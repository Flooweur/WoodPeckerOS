#!/usr/bin/env node
// woody-hud: the HUD gateway.
//
//  * serves the HUD web app on a loopback port for the kiosk browser
//  * relays chat between the browser and the agent's socket
//  * carries the human's approve/deny decisions to the executor's approval
//    socket, which the agent itself cannot open
//  * serves the same HUD to the operator's own browser on the host-only
//    network, over HTTPS and behind a password (no terminal there)
//  * relays the operator's terminal to the kiosk, and only to the kiosk
//
// Because it carries approvals, access is gated by a secret token. The token
// reaches the kiosk browser through a bootstrap file only the kiosk user can
// read, never through a command line or an unauthenticated URL.
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
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
/** HTTPS port for the operator's browser on the host-only network. 0 turns it off. */
const HOST_PORT = Number(process.env.WOODY_HUD_HOST_PORT ?? "0");
const TLS_DIR = process.env.WOODY_HUD_TLS_DIR ?? path.join(STATE_DIR, "tls");
const PASSWORD_FILE = path.join(STATE_DIR, "host-password");
/** Unix socket of the terminal service. Empty: no terminal. */
const TERM_SOCKET = process.env.WOODY_TERM_SOCKET ?? "";
const TERMINAL_FLAG = path.join(RUNTIME_DIR, "terminal-open");
const JOURNALCTL = process.env.WOODY_JOURNALCTL ?? "journalctl";

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

// ---- who is asking --------------------------------------------------------
//
// Two doors:
//  * the kiosk: plain HTTP on loopback, gated by the token the kiosk session
//    receives through its bootstrap file. Only this door has the terminal.
//  * the host: HTTPS on the host-only network, gated by a password the
//    operator sets and a session cookie. No terminal there, ever.

const SESSION_MS = 12 * 3600 * 1000;
const sessions = new Map<string, number>();
const loginFailures: number[] = [];

function cookies(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function hostSession(req: http.IncomingMessage): boolean {
  const id = cookies(req).woody_session;
  const expires = id ? sessions.get(id) : undefined;
  if (!id || !expires) return false;
  if (expires < Date.now()) {
    sessions.delete(id);
    return false;
  }
  return true;
}

function hashPassword(password: string, salt = crypto.randomBytes(16)): string {
  const hash = crypto.scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

function passwordIsSet(): boolean {
  return fs.existsSync(PASSWORD_FILE);
}

function checkPassword(password: string): boolean {
  let stored: string;
  try {
    stored = fs.readFileSync(PASSWORD_FILE, "utf8").trim();
  } catch {
    return false;
  }
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const candidate = hashPassword(password, Buffer.from(salt, "hex")).split("$")[2]!;
  return candidate.length === hash.length && crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(hash));
}

/** Five wrong passwords in ten minutes close the door for ten minutes. */
function loginLocked(): boolean {
  const cutoff = Date.now() - 10 * 60_000;
  while (loginFailures.length && loginFailures[0]! < cutoff) loginFailures.shift();
  return loginFailures.length >= 5;
}

const LOGIN_PAGE = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>WoodPecker</title>
<style>
  html,body{height:100%;margin:0;background:#050403;color:#f2d9a0;font:14px/1.5 "JetBrains Mono",ui-monospace,Consolas,monospace}
  form{height:100%;display:grid;place-content:center;gap:10px;padding:20px;max-width:360px;margin:auto}
  h1{margin:0;color:#ffb000;letter-spacing:.3em;font-size:20px}
  label{font-size:12px;color:#a98a45;letter-spacing:.1em}
  input,button{font:inherit;min-height:44px;padding:0 12px;background:#050403;color:#f2d9a0;border:1px solid #6b4a05;border-radius:0}
  button{background:#ffb000;color:#050403;font-weight:700;letter-spacing:.14em;border-color:#ffb000;cursor:pointer}
  p{margin:0;min-height:1.5em;color:#ff8a80;font-size:12px}
</style>
<form id="f">
  <h1>WOODPECKER</h1>
  <label for="p">PASSWORD</label>
  <input id="p" type="password" autocomplete="current-password" autofocus required>
  <button>OPEN</button>
  <p id="m" role="alert"></p>
</form>
<script>
  document.getElementById("f").addEventListener("submit", async (e) => {
    e.preventDefault();
    const m = document.getElementById("m");
    m.textContent = "";
    const r = await fetch("/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: document.getElementById("p").value }) });
    if (r.ok) location.replace("/");
    else m.textContent = await r.text();
  });
</script>
</html>`;

function securityHeaders(req: http.IncomingMessage, host: boolean): Record<string, string> {
  const connect = host ? `'self' wss://${req.headers.host ?? ""}` : `'self' ws://127.0.0.1:${PORT} ws://localhost:${PORT}`;
  return {
    "Content-Security-Policy": [
      "default-src 'self'",
      `connect-src ${connect}`,
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join("; "),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    ...(host ? { "Strict-Transport-Security": "max-age=31536000" } : {}),
  };
}

function handleLogin(req: http.IncomingMessage, res: http.ServerResponse): void {
  const plain = { "content-type": "text/plain; charset=utf-8", "Cache-Control": "no-store" };
  if (req.method === "GET" || req.method === "HEAD") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self' 'unsafe-inline'; frame-ancestors 'none'" });
    res.end(req.method === "HEAD" ? undefined : LOGIN_PAGE);
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  // The form must come from this very page.
  if (req.headers.origin !== `https://${req.headers.host}`) {
    res.writeHead(403, plain).end("Wrong origin.");
    return;
  }
  if (!passwordIsSet()) {
    res.writeHead(503, plain).end("No password is set yet. On the VM, run: sudo -u woody-hud woody-hud set-password");
    return;
  }
  if (loginLocked()) {
    res.writeHead(429, plain).end("Too many wrong passwords. Wait ten minutes.");
    return;
  }
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk: string) => {
    body += chunk;
    if (body.length > 4096) req.destroy();
  });
  req.on("end", () => {
    let password = "";
    try {
      password = String(JSON.parse(body).password ?? "");
    } catch {
      /* treated as a wrong password */
    }
    if (!password || !checkPassword(password)) {
      loginFailures.push(Date.now());
      console.log("woody-hud: a host login failed");
      res.writeHead(401, plain).end("Wrong password.");
      return;
    }
    const id = crypto.randomBytes(32).toString("hex");
    sessions.set(id, Date.now() + SESSION_MS);
    console.log("woody-hud: a host session was opened");
    res.writeHead(204, { "Set-Cookie": `woody_session=${id}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`, "Cache-Control": "no-store" }).end();
  });
}

// ---- the terminal ---------------------------------------------------------
//
// A real shell for the operator, served by a separate root service (ttyd
// running \`login\`) on a Unix socket only this gateway can open. The gateway
// relays it to the kiosk and nowhere else. While a terminal is open, a flag
// file tells the executor to refuse screenshots, so Woody cannot look at it.

let terminals = 0;
function terminalFlag(): void {
  try {
    if (terminals > 0) fs.writeFileSync(TERMINAL_FLAG, "open\n", { mode: 0o644 });
    else fs.rmSync(TERMINAL_FLAG, { force: true });
  } catch {
    /* the runtime directory is gone: the service is stopping */
  }
}

function terminalAllowed(req: http.IncomingMessage, url: URL): boolean {
  return Boolean(TERM_SOCKET) && (tokenOk(url.searchParams.get("t")) || tokenOk(cookies(req).woody_term ?? null));
}

function proxyTerminal(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  if (!terminalAllowed(req, url)) {
    res.writeHead(403, { "content-type": "text/plain" }).end("forbidden\n");
    return;
  }
  const upstream = http.request({ socketPath: TERM_SOCKET, path: req.url, method: req.method, headers: req.headers }, (up) => {
    const headers: http.OutgoingHttpHeaders = { ...up.headers, "Cache-Control": "no-store" };
    // The page's own requests carry no token, so hand the browser a cookie scoped to the terminal.
    if (tokenOk(url.searchParams.get("t"))) headers["Set-Cookie"] = `woody_term=${TOKEN}; HttpOnly; SameSite=Strict; Path=/term`;
    res.writeHead(up.statusCode ?? 502, headers);
    up.pipe(res);
  });
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("The terminal service is not running.\n");
  });
  req.pipe(upstream);
}

function proxyTerminalUpgrade(req: http.IncomingMessage, socket: import("node:stream").Duplex, head: Buffer, url: URL): void {
  const origin = req.headers.origin ?? "";
  if (!terminalAllowed(req, url) || !ORIGINS.includes(origin)) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const upstream = net.createConnection(TERM_SOCKET);
  let counted = false;
  const close = () => {
    if (counted) {
      counted = false;
      terminals -= 1;
      terminalFlag();
    }
    socket.destroy();
    upstream.destroy();
  };
  upstream.on("connect", () => {
    counted = true;
    terminals += 1;
    terminalFlag();
    let request = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) request += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    upstream.write(request + "\r\n");
    if (head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on("error", close);
  upstream.on("close", close);
  socket.on("error", close);
  socket.on("close", close);
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

function handle(req: http.IncomingMessage, res: http.ServerResponse, host: boolean): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain", "Cache-Control": "no-store" }).end("ok\n");
    return;
  }
  if (host) {
    if (url.pathname === "/login") return handleLogin(req, res);
    if (url.pathname.startsWith("/term")) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
      return;
    }
    if (!hostSession(req)) {
      if (url.pathname === "/") res.writeHead(302, { Location: "/login", "Cache-Control": "no-store" }).end();
      else res.writeHead(401, { "content-type": "text/plain" }).end("sign in first\n");
      return;
    }
  } else if (url.pathname.startsWith("/term")) {
    return proxyTerminal(req, res, url);
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
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
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", ...securityHeaders(req, host) });
    res.end(req.method === "HEAD" ? undefined : data);
  });
}

const server = http.createServer((req, res) => handle(req, res, false));

// ---- browser sessions -----------------------------------------------------

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
const browsers = new Set<WebSocket>();

function upgrade(req: http.IncomingMessage, socket: import("node:stream").Duplex, head: Buffer, host: boolean): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const origin = req.headers.origin ?? "";
  if (!host && url.pathname.startsWith("/term")) return proxyTerminalUpgrade(req, socket, head, url);
  const allowed = host
    ? origin === `https://${req.headers.host}` && hostSession(req)
    : ORIGINS.includes(origin) && tokenOk(url.searchParams.get("t"));
  if (url.pathname !== "/ws" || !allowed) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, host));
}

server.on("upgrade", (req, socket, head) => upgrade(req, socket, head, false));

function send(ws: WebSocket, message: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

wss.on("connection", (browser: WebSocket, host: boolean) => {
  browsers.add(browser);
  // Tell the page which door it came through: the terminal exists only on the kiosk.
  send(browser, { type: "hello", kiosk: !host, terminal: !host && Boolean(TERM_SOCKET) });
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

  // Send the current approvals, scope and meters straight away.
  lastApprovals = "";
  void pollApprovals();
  void pushScope(true);
  send(browser, readMeters());

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

    if (type === "logs") {
      // The system journal, for the operator's eyes. Every argument is checked;
      // nothing the browser sends reaches a shell.
      const args = ["-o", "json", "--no-pager", "-n", String(Math.min(500, Math.max(10, Number(msg.lines) || 200)))];
      if (typeof msg.unit === "string" && /^[A-Za-z0-9@_.-]{1,120}\.(service|socket|timer|target)$/.test(msg.unit)) args.push(`--unit=${msg.unit}`);
      const priority = Number(msg.priority);
      if (Number.isInteger(priority) && priority >= 0 && priority <= 7) args.push(`--priority=${priority}`);
      if (typeof msg.since === "string" && /^-\d{1,4}[smhd]$/.test(msg.since)) args.push(`--since=${msg.since}`);
      execFile(JOURNALCTL, args, { timeout: 8000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        if (err && !stdout) {
          send(browser, { type: "logs", ok: false, error: "The journal could not be read.", entries: [] });
          return;
        }
        const entries: Array<Record<string, unknown>> = [];
        for (const line of stdout.split("\n")) {
          if (!line) continue;
          try {
            const j = JSON.parse(line);
            entries.push({
              ts: Math.round(Number(j.__REALTIME_TIMESTAMP ?? 0) / 1000),
              unit: j._SYSTEMD_UNIT ?? j.SYSLOG_IDENTIFIER ?? "kernel",
              priority: Number(j.PRIORITY ?? 6),
              message: typeof j.MESSAGE === "string" ? j.MESSAGE.slice(0, 2000) : "[binary]",
            });
          } catch {
            /* skip a damaged line */
          }
        }
        send(browser, { type: "logs", ok: true, entries });
      });
      return;
    }

    if (type === "web_list" || type === "web_add" || type === "web_remove") {
      try {
        const reply = await approvalCall(type === "web_list" ? { op: "web_list" } : { op: type, domain: String(msg.domain ?? "") });
        send(browser, { type: "web_list", ok: reply.status === "ok", domains: reply.result?.domains ?? null, error: reply.error ?? null });
      } catch (err) {
        send(browser, { type: "web_list", ok: false, domains: null, error: err instanceof Error ? err.message : String(err) });
      }
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

// ---- the machine: meters and scope ---------------------------------------
//
// Read from /proc by this unprivileged process. No model and no executor
// action is involved, so the meters cost nothing and work while Woody rests.

let lastCpu: { busy: number; total: number } | undefined;
let lastNet: { bytes: number; at: number } | undefined;

function readMeters(): Record<string, unknown> {
  const out: Record<string, unknown> = { type: "meters", at: Date.now() };
  try {
    const cpu = fs.readFileSync("/proc/stat", "utf8").split("\n")[0]!.trim().split(/\s+/).slice(1).map(Number);
    const total = cpu.reduce((a, b) => a + b, 0);
    const busy = total - (cpu[3] ?? 0) - (cpu[4] ?? 0);
    if (lastCpu && total > lastCpu.total) out.cpu_pct = Math.round(((busy - lastCpu.busy) / (total - lastCpu.total)) * 100);
    lastCpu = { busy, total };
  } catch {
    /* not available */
  }
  try {
    const mem = fs.readFileSync("/proc/meminfo", "utf8");
    const kb = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(mem)?.[1] ?? 0);
    out.mem_total_kb = kb("MemTotal");
    out.mem_used_kb = kb("MemTotal") - kb("MemAvailable");
  } catch {
    /* not available */
  }
  try {
    const st = fs.statfsSync("/");
    out.disk_free_pct = Math.round((Number(st.bavail) / Number(st.blocks)) * 1000) / 10;
  } catch {
    /* not available */
  }
  try {
    let bytes = 0;
    for (const line of fs.readFileSync("/proc/net/dev", "utf8").split("\n").slice(2)) {
      const [name, rest] = line.split(":");
      if (!rest || name!.trim() === "lo") continue;
      const f = rest.trim().split(/\s+/).map(Number);
      bytes += (f[0] ?? 0) + (f[8] ?? 0);
    }
    const at = Date.now();
    if (lastNet && at > lastNet.at) out.net_kbps = Math.max(0, Math.round((bytes - lastNet.bytes) / 1024 / ((at - lastNet.at) / 1000)));
    lastNet = { bytes, at };
  } catch {
    /* not available */
  }
  try {
    out.uptime_s = Math.round(Number(fs.readFileSync("/proc/uptime", "utf8").split(" ")[0]));
  } catch {
    /* not available */
  }
  try {
    out.generation = Number(/system-(\d+)-link/.exec(fs.readlinkSync("/nix/var/nix/profiles/system"))?.[1] ?? 0) || undefined;
  } catch {
    /* not on NixOS */
  }
  return out;
}

setInterval(() => {
  if (browsers.size === 0) return;
  const meters = readMeters();
  for (const ws of browsers) send(ws, meters);
}, 2000).unref();

let lastScope = "";
async function pushScope(force = false): Promise<void> {
  if (browsers.size === 0) return;
  try {
    const reply = await approvalCall({ op: "scope" });
    const snapshot = JSON.stringify(reply.result ?? null);
    if (force || snapshot !== lastScope) {
      lastScope = snapshot;
      for (const ws of browsers) send(ws, { type: "scope", ...(reply.result ?? {}) });
    }
  } catch {
    /* the executor is down: the approvals feed already says so */
  }
}
setInterval(() => void pushScope(), 30_000).unref();

// ---- start ----------------------------------------------------------------

/** Input that arrived after the line just read (piped input delivers several lines at once). */
let pendingInput = "";

/** Reads a line from the terminal without showing it. */
function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk: string) => {
      const text = pendingInput + chunk;
      pendingInput = "";
      for (let i = 0; i < text.length; i++) {
        const ch = text[i]!;
        if (ch === "\r" || ch === "\n") {
          stdin.off("data", onData);
          if (stdin.isTTY) stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write("\n");
          pendingInput = text.slice(i + 1).replace(/^\n/, "");
          resolve(value);
          return;
        }
        if (ch === "\u0003") process.exit(1);
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
    if (pendingInput) onData("");
  });
}

if (process.argv[2] === "set-password") {
  // sudo -u woody-hud woody-hud set-password
  const first = await readHidden("New password for the HUD from your own browser: ");
  if (first.length < 10) {
    console.error("Use at least 10 characters.");
    process.exit(1);
  }
  if ((await readHidden("Again: ")) !== first) {
    console.error("The two did not match.");
    process.exit(1);
  }
  fs.writeFileSync(PASSWORD_FILE, hashPassword(first) + "\n", { mode: 0o600 });
  console.log(`Saved. Open https://<the VM's host-only address>:${HOST_PORT || 7843}/ in your browser.`);
  process.exit(0);
}

terminalFlag();

server.listen(PORT, BIND, () => {
  writeBootstrap();
  console.log(`woody-hud: serving ${WEB_ROOT} on http://${BIND}:${PORT}`);
});

if (HOST_PORT > 0) {
  try {
    const hostServer = https.createServer(
      { key: fs.readFileSync(path.join(TLS_DIR, "key.pem")), cert: fs.readFileSync(path.join(TLS_DIR, "cert.pem")), minVersion: "TLSv1.2" },
      (req, res) => handle(req, res, true),
    );
    hostServer.on("upgrade", (req, socket, head) => upgrade(req, socket, head, true));
    hostServer.listen(HOST_PORT, "0.0.0.0", () => {
      console.log(`woody-hud: host access on https port ${HOST_PORT}${passwordIsSet() ? "" : " (no password set yet: nobody can sign in)"}`);
    });
  } catch (err) {
    console.error("woody-hud: host access is off:", err instanceof Error ? err.message : err);
  }
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    for (const ws of browsers) ws.close(1001, "gateway shutting down");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
