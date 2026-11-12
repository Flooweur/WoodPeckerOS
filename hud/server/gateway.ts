#!/usr/bin/env node
// woody-hud: the HUD gateway.
//
//  * serves the HUD web app on a loopback port for the kiosk browser
//  * relays chat between the browser and the agent's socket
//  * carries the human's approve/deny decisions to the executor's approval
//    socket, which the agent itself cannot open
//
// Because it carries approvals, access is gated by a secret token. The token
// reaches the kiosk browser through a bootstrap file only the kiosk user can
// read, never through a command line or an unauthenticated URL.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";

const PORT = Number(process.env.WOODY_HUD_PORT ?? "7800");
const BIND = process.env.WOODY_HUD_BIND ?? "127.0.0.1";
const AGENT_SOCKET = process.env.WOODY_AGENT_SOCKET ?? "/run/woody-agent/agent.sock";
const APPROVE_SOCKET = process.env.WOODY_APPROVE_SOCKET ?? "/run/woody/approve.sock";
const STATE_DIR = process.env.WOODY_HUD_STATE_DIR ?? "/var/lib/woody-hud";
const RUNTIME_DIR = process.env.WOODY_HUD_RUNTIME_DIR ?? "/run/woody-hud";
const WEB_ROOT = path.resolve(import.meta.dirname, "../web");
const ORIGINS = (process.env.WOODY_HUD_ORIGINS ?? `http://127.0.0.1:${PORT}`).split(",");

/** Messages the browser may send on to the agent unchanged. */
const AGENT_BOUND = new Set(["chat", "set_model", "new_session", "interrupt", "get_state", "get_history", "mind", "presence"]);

// ---- access token ---------------------------------------------------------

function loadToken(): string {
  const file = path.join(STATE_DIR, "token");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(existing)) return existing;
  } catch {
    // first start
  }
  const token = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(file, token + "\n", { mode: 0o600 });
  return token;
}

const TOKEN = loadToken();

function tokenOk(candidate: string | null): boolean {
  if (!candidate || candidate.length !== TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(TOKEN));
}

/** The kiosk opens this file; it waits for the gateway and then loads the HUD with the token. */
function writeBootstrap(): void {
  const target = `http://127.0.0.1:${PORT}/`;
  const html = `<!doctype html>
<meta charset="utf-8">
<title>WoodPecker</title>
<style>html,body{height:100%;margin:0;background:#050403;color:#ffb000;font:16px monospace;display:grid;place-items:center}</style>
<p id="s">starting…</p>
<script>
  const target = ${JSON.stringify(target)};
  const token = ${JSON.stringify(TOKEN)};
  let failures = 0;
  async function go() {
    try {
      await fetch(target + "healthz", { mode: "no-cors", cache: "no-store" });
      location.replace(target + "#t=" + token);
    } catch {
      // If the browser will not let this page probe the service, stop
      // probing and just go there.
      if (++failures >= 5) return location.replace(target + "#t=" + token);
      document.getElementById("s").textContent = "waiting for the HUD service…";
      setTimeout(go, 1000);
    }
  }
  go();
</script>
`;
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  // Group-readable only: the service runs with the kiosk group as its primary group.
  fs.writeFileSync(path.join(RUNTIME_DIR, "boot.html"), html, { mode: 0o640 });
}

// ---- executor approval channel -------------------------------------------

function approvalCall(request: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(APPROVE_SOCKET);
    let buffer = "";
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("executor timeout"))), 30_000);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const i = buffer.indexOf("\n");
      if (i < 0) return;
      const line = buffer.slice(0, i);
      finish(() => {
        try {
          resolve(JSON.parse(line));
        } catch {
          reject(new Error("unreadable executor reply"));
        }
      });
    });
    socket.on("error", (err) => finish(() => reject(new Error(`executor unreachable: ${err.message}`))));
    socket.on("close", () => finish(() => reject(new Error("executor closed the connection"))));
  });
}

// ---- static files ---------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'",
    `connect-src 'self' ws://127.0.0.1:${PORT} ws://localhost:${PORT}`,
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain", "Cache-Control": "no-store" }).end("ok\n");
    return;
  }
  const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const file = path.resolve(WEB_ROOT, relative);
  if (file !== WEB_ROOT && !file.startsWith(WEB_ROOT + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
      ...SECURITY_HEADERS,
    });
    res.end(req.method === "HEAD" ? undefined : data);
  });
});

// ---- browser sessions -----------------------------------------------------

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
const browsers = new Set<WebSocket>();

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const origin = req.headers.origin ?? "";
  if (url.pathname !== "/ws" || !ORIGINS.includes(origin) || !tokenOk(url.searchParams.get("t"))) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
});

function send(ws: WebSocket, message: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

wss.on("connection", (browser) => {
  browsers.add(browser);
  let upstream: WebSocket | undefined;
  let closed = false;
  let retry: NodeJS.Timeout | undefined;

  const connectAgent = () => {
    if (closed) return;
    const agent = new WebSocket(`ws+unix://${AGENT_SOCKET}:/`);
    upstream = agent;
    agent.on("open", () => send(browser, { type: "agent_up" }));
    agent.on("message", (data) => {
      if (browser.readyState === WebSocket.OPEN) browser.send(data.toString());
    });
    agent.on("error", () => {
      // "close" follows; handled there.
    });
    agent.on("close", () => {
      if (upstream === agent) upstream = undefined;
      send(browser, { type: "agent_down" });
      if (!closed) retry = setTimeout(connectAgent, 2000);
    });
  };
  connectAgent();

  // Send the current approvals straight away.
  lastApprovals = "";
  void pollApprovals();

  browser.on("message", async (raw) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(browser, { type: "error", error: "bad-json" });
      return;
    }
    const type = String(msg.type ?? "");

    if (AGENT_BOUND.has(type)) {
      if (upstream?.readyState === WebSocket.OPEN) upstream.send(JSON.stringify(msg));
      else send(browser, { type: "error", error: "agent-unavailable" });
      return;
    }

    if (type === "decide") {
      const decision = msg.decision === "approve" ? "approve" : msg.decision === "deny" ? "deny" : null;
      if (!decision || typeof msg.approval_id !== "string" || typeof msg.action_hash !== "string") {
        send(browser, { type: "decide_result", ok: false, error: "malformed decision" });
        return;
      }
      try {
        // action_hash binds the click to the exact action the human was shown.
        const reply = await approvalCall({
          op: "decide",
          approval_id: msg.approval_id,
          decision,
          action_hash: msg.action_hash,
        });
        send(browser, {
          type: "decide_result",
          approval_id: msg.approval_id,
          decision,
          ok: reply.status === "ok",
          error: reply.error ?? null,
        });
      } catch (err) {
        send(browser, {
          type: "decide_result",
          approval_id: msg.approval_id,
          decision,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      lastApprovals = "";
      void pollApprovals();
      return;
    }

    if (type === "pause") {
      // The Pause switch lives in the executor, so it holds whatever the agent does.
      try {
        const reply = await approvalCall({ op: "pause", on: msg.on !== false });
        if (reply.status !== "ok") send(browser, { type: "error", error: "pause-failed", detail: reply.error ?? "" });
      } catch (err) {
        send(browser, { type: "error", error: "pause-failed", detail: err instanceof Error ? err.message : String(err) });
      }
      lastApprovals = "";
      void pollApprovals();
      return;
    }

    if (type === "get_audit") {
      try {
        const n = Math.min(Number(msg.n ?? 50) || 50, 500);
        const reply = await approvalCall({ op: "audit_tail", n });
        send(browser, { type: "audit", records: reply.result ?? [] });
      } catch (err) {
        send(browser, { type: "error", error: "audit-unavailable" });
      }
      return;
    }

    send(browser, { type: "error", error: "unknown-message-type" });
  });

  const cleanup = () => {
    closed = true;
    browsers.delete(browser);
    if (retry) clearTimeout(retry);
    upstream?.close();
  };
  browser.on("close", cleanup);
  browser.on("error", cleanup);
});

// ---- approvals feed -------------------------------------------------------

let lastApprovals = "";
let polling = false;

async function pollApprovals(): Promise<void> {
  if (polling || browsers.size === 0) return;
  polling = true;
  try {
    const reply = await approvalCall({ op: "pending" });
    const items = reply.status === "ok" ? reply.result : [];
    const status = await approvalCall({ op: "status" });
    const paused = Boolean(status.result?.paused);
    const snapshot = JSON.stringify([items, paused]);
    if (snapshot !== lastApprovals) {
      lastApprovals = snapshot;
      for (const ws of browsers) send(ws, { type: "approvals", items, paused, executor_up: true });
    }
  } catch {
    if (lastApprovals !== "down") {
      lastApprovals = "down";
      for (const ws of browsers) send(ws, { type: "approvals", items: [], executor_up: false });
    }
  } finally {
    polling = false;
  }
}

setInterval(() => void pollApprovals(), 1000).unref();

// ---- start ----------------------------------------------------------------

server.listen(PORT, BIND, () => {
  writeBootstrap();
  console.log(`woody-hud: serving ${WEB_ROOT} on http://${BIND}:${PORT}`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    for (const ws of browsers) ws.close(1001, "gateway shutting down");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
