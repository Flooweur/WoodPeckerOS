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
//  * keeps the canvas: the things Woody makes, served as sealed documents,
//    with their versions, what is pinned, and the record of changes (canvas.ts)
//  * takes Woody's requests about the canvas over a link to the agent, tries
//    each new thing on the screen before keeping it, and refuses them while
//    the operator has paused Woody
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
import { Canvas, CanvasError, THING_POLICY, describe, wrapThing, type Actor, type Thing } from "./canvas.js";
import { buildPart, kitCatalogue } from "./kit.js";

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
/** Where the operator's command line reaches the canvas of the running gateway. */
const CANVAS_SOCKET = process.env.WOODY_CANVAS_SOCKET ?? path.join(RUNTIME_DIR, "canvas.sock");

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

// ---- the canvas -----------------------------------------------------------
//
// The gateway owns the things on the canvas. The frame shows each one in a
// sandboxed frame loaded from /thing/<key>. The key is an unguessable name
// for one thing: knowing it lets a page read that thing's source and nothing
// else, so a thing learning its own key learns nothing.

/** Opened when the gateway starts serving (not for the command-line modes). */
let canvas: Canvas;
const THING_SECRET = crypto.randomBytes(32);
const thingKey = (id: string): string => crypto.createHmac("sha256", THING_SECRET).update(id).digest("hex").slice(0, 32);

function canvasSnapshot(): Record<string, unknown> {
  const u = canvas.undoable();
  return {
    type: "canvas",
    things: canvas.list().map((t) => ({ ...t, key: thingKey(t.id) })),
    undo: u ? { seq: u.seq, by: u.by, text: describe(u) } : null,
    limits: canvas.limits(),
  };
}

function pushCanvas(): void {
  const snapshot = canvasSnapshot();
  for (const ws of browsers) send(ws, snapshot);
  tellWoody();
}

/** The last change Woody was told about. Set when the gateway starts, so old changes are not replayed. */
let toldSeq = -1;

/**
 * Woody is told of every change to the canvas, its own and the operator's:
 * that the operator kept, moved, pinned or removed something is part of what
 * really happened. It is a record for Woody, never a reason to wake it.
 */
function tellWoody(): void {
  const recent = canvas.history(60).reverse();
  for (const c of recent) {
    if (c.seq <= toldSeq) continue;
    toldSeq = c.seq;
    if (link?.readyState !== WebSocket.OPEN) continue;
    let thing: Thing | undefined;
    try {
      thing = canvas.get(c.id);
    } catch {
      /* the thing is gone from the list */
    }
    const undid = c.op === "undo" && c.of !== undefined ? recent.find((x) => x.seq === c.of) : undefined;
    link.send(
      JSON.stringify({
        type: "canvas_event",
        change: {
          seq: c.seq, by: c.by, op: c.op, id: c.id, title: c.title, why: c.why, refused: c.refused ?? null,
          thing_by: thing?.by ?? "woody", undid_by: undid?.by ?? null, pinned: c.op === "pin" && thing?.pinned === true,
          // Whether Woody did it unasked, whether the thing was put there that way, and where a thing was moved.
          uninvited: c.uninvited === true, thing_uninvited: thing?.uninvited === true, for: thing?.for ?? "you",
          box: c.op === "place" ? (thing?.box ?? null) : null, from: c.op === "place" ? (c.before?.box ?? null) : null, screen: canvas.viewport,
        },
      }),
    );
  }
}

/** One canvas request, from the operator's frame ("you") or made on Woody's behalf ("woody"). */
function canvasOp(by: Actor, m: Record<string, any>): unknown {
  const changed = <T>(result: T): T => {
    pushCanvas();
    return result;
  };
  try {
    switch (String(m.op ?? "")) {
      case "make":
        return changed(canvas.make(by, m));
      case "kit":
        // A ready part: its source is written here from a few values.
        return changed(canvas.make(by, { ...m, source: buildPart(m.part, m.props) }));
      case "kit_catalogue":
        return kitCatalogue();
      case "may_add":
        // Asked by Woody before it spends anything on a thing nobody asked for.
        return by === "woody" ? canvas.mayAdd(m) : true;
      case "limits":
        return canvas.limits();
      case "set_limit":
        return changed(canvas.setLimit(by, m.n));
      case "note_seen":
        return changed(canvas.seeNote(by, m.id));
      case "change":
        return changed(canvas.change(by, m));
      case "restore":
        return changed(canvas.restore(by, m));
      case "place":
        return changed(canvas.place(by, m));
      case "remove":
        return changed(canvas.remove(by, m));
      case "bring_back":
        return changed(canvas.bringBack(by, m));
      case "pin":
        return changed(canvas.pin(by, m));
      case "undo":
        return changed({ undone: describe(canvas.undo(by)) });
      case "list":
        return canvas.list();
      case "get":
        return { thing: canvas.get(String(m.id)), source: canvas.source(String(m.id), typeof m.version === "number" ? m.version : undefined) };
      case "history":
        return canvas.history(Math.min(Number(m.n) || 100, 500)).map((c) => ({ ...c, text: describe(c) }));
      case "state_get":
        return canvas.state(String(m.id));
      case "state_set":
        canvas.setState(String(m.id), m.value);
        return true;
      case "health":
        // The frame says whether a thing started. Only a screen can know.
        if (by !== "you") throw new CanvasError("only a screen reports that");
        reportHealth(String(m.id), Number(m.version), m.phase === "ready" ? "ready" : "failed", Array.isArray(m.faults) ? m.faults.map(String).slice(-5) : []);
        return true;
      case "emit":
        // A thing tells Woody that something happened on it.
        if (by !== "you") throw new CanvasError("only a thing on a screen sends that");
        return thingEvent(canvas.get(String(m.id)), m.name, m.data);
      case "viewport":
        if (by === "you" && Number(m.w) >= 600 && Number(m.h) >= 400) canvas.viewport = { w: Math.min(Math.round(m.w), 8000), h: Math.min(Math.round(m.h), 8000) };
        return canvas.viewport;
      default:
        throw new CanvasError("unknown canvas request");
    }
  } catch (err) {
    // A refused request (a pinned thing, say) is recorded: show it.
    if (err instanceof CanvasError) pushCanvas();
    throw err;
  }
}

// ---- what the screens report about things ----

type Health = { phase: "ready" | "failed"; faults: string[]; at: number };
/** The latest report for each version of each thing ("t3:2"). Not kept across restarts. */
const health = new Map<string, Health>();
const healthWaiters = new Map<string, (h: Health) => void>();

function reportHealth(id: string, version: number, phase: Health["phase"], faults: string[]): void {
  const key = `${id}:${version}`;
  const report = { phase, faults, at: Date.now() };
  // A later report of trouble replaces "ready"; "ready" never hides a failure.
  if (health.get(key)?.phase === "failed" && phase === "ready") return;
  health.set(key, report);
  if (health.size > 500) health.delete(health.keys().next().value!);
  healthWaiters.get(key)?.(report);
}

/**
 * A thing Woody made or changed is tried on a screen before it is kept. If it
 * does not start, the change is taken back and Woody is told why, so a broken
 * thing never stays on the canvas.
 */
async function tried(thing: Thing, seq: number): Promise<unknown> {
  if (browsers.size === 0) return { thing, tried: false, note: "No screen is showing the canvas right now, so it could not be tried." };
  const key = `${thing.id}:${thing.version}`;
  const began = Date.now();
  const report =
    health.get(key) ??
    (await new Promise<Health | null>((resolve) => {
      const timer = setTimeout(() => {
        healthWaiters.delete(key);
        resolve(null);
      }, 12_000);
      healthWaiters.set(key, (h) => {
        clearTimeout(timer);
        healthWaiters.delete(key);
        resolve(h);
      });
    }));
  if (!report) return { thing, tried: false, note: "The screen did not say in time whether it started. Look again with canvas_look." };
  if (report.phase === "ready") return { thing, tried: true, started: true, start_ms: Date.now() - began };
  const why = report.faults.join(" | ") || "it never called woody.ready()";
  canvas.takeBack(seq, "it did not start");
  pushCanvas();
  throw new CanvasError(`It did not start, so the canvas is as it was before. What went wrong: ${why}`);
}

// ---- things telling Woody that something happened ----

const eventTimes = new Map<string, number[]>();
function thingEvent(thing: Thing, name: unknown, data: unknown): boolean {
  const label = String(name ?? "").trim().slice(0, 40);
  if (!label) throw new CanvasError("an event needs a name");
  const body = JSON.stringify(data ?? null);
  if (body.length > 2000) throw new CanvasError("an event's data is limited to 2000 characters");
  // At most six a minute from one thing, sixty an hour from all of them.
  const now = Date.now();
  const mine = (eventTimes.get(thing.id) ?? []).filter((t) => t > now - 60_000);
  const all = [...eventTimes.values()].flat().filter((t) => t > now - 3_600_000);
  if (mine.length >= 6 || all.length >= 60) throw new CanvasError("too many events: Woody is not woken more often than this");
  if (link?.readyState !== WebSocket.OPEN) throw new CanvasError("Woody is not connected right now");
  eventTimes.set(thing.id, [...mine, now]);
  link.send(JSON.stringify({ type: "thing_event", id: thing.id, title: thing.title, name: label, data: JSON.parse(body) }));
  return true;
}

// ---- Woody's side ----
//
// The gateway keeps one connection to the agent's socket for the canvas.
// Requests arriving on it are Woody's: they are checked against Pause, they
// cannot pin, unpin or undo, and what they make is tried on a screen.

let link: WebSocket | undefined;
const WOODY_CHANGES = new Set(["make", "kit", "change", "restore", "place", "remove", "bring_back"]);
const WOODY_TRIED = new Set(["make", "kit", "change", "restore", "bring_back"]);

async function woodyRequest(m: Record<string, any>): Promise<unknown> {
  const op = String(m.op ?? "");
  if (op === "look") {
    const all = canvas.list();
    return {
      screen: canvas.viewport,
      screens_showing_it: browsers.size,
      things: all
        .filter((t) => !t.removed)
        .map((t) => {
          const h = health.get(`${t.id}:${t.version}`);
          return {
            id: t.id, title: t.title, kind: t.kind, for: t.for, made_by: t.by, on_its_own: t.uninvited === true, note: t.note ?? null,
            why: t.why, version: t.version, pinned: t.pinned,
            x: t.box.x, y: t.box.y, width: t.box.w, height: t.box.h,
            running: h ? (h.phase === "ready" ? (h.faults.length ? `yes, with faults: ${h.faults.join(" | ")}` : "yes") : `no: ${h.faults.join(" | ") || "it did not start"}`) : "not reported",
          };
        }),
      put_away: all.filter((t) => t.removed).map((t) => ({ id: t.id, title: t.title, made_by: t.by, on_its_own: t.uninvited === true })),
      // Things you added today without being asked, and the most the operator allows in a day.
      own_additions: { today: canvas.uninvitedToday(), limit: canvas.limits().uninvited_per_day },
      kit: kitCatalogue(),
    };
  }
  if (op === "get" || op === "kit_catalogue" || op === "limits" || op === "may_add") return canvasOp("woody", m);
  if (!WOODY_CHANGES.has(op)) throw new CanvasError("that is the operator's alone to do");
  let paused: boolean;
  try {
    paused = Boolean((await approvalCall({ op: "status" })).result?.paused);
  } catch {
    throw new CanvasError("The executor cannot be reached, so Pause cannot be checked. Nothing was changed.");
  }
  if (paused) throw new CanvasError("paused-by-operator: the canvas is not changed while the operator has paused you");
  const thing = canvasOp("woody", m) as Thing;
  return WOODY_TRIED.has(op) ? tried(thing, canvas.last()!.seq) : thing;
}

function connectCanvasLink(): void {
  const ws = new WebSocket(`ws+unix://${AGENT_SOCKET}:/`);
  ws.on("open", () => {
    link = ws;
    ws.send(JSON.stringify({ type: "canvas_link" }));
  });
  ws.on("message", async (data) => {
    let m: Record<string, any>;
    try {
      m = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (m.type !== "canvas_request") return; // the agent's broadcasts are for the screens, not for this link
    let reply: Record<string, unknown>;
    try {
      reply = { ok: true, result: await woodyRequest(m) };
    } catch (err) {
      reply = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "canvas_reply", rid: m.rid, ...reply }));
  });
  ws.on("error", () => {
    // "close" follows; handled there.
  });
  ws.on("close", () => {
    if (link === ws) link = undefined;
    setTimeout(connectCanvasLink, 2000).unref();
  });
}

function serveThing(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  const plain = { "content-type": "text/plain", "Cache-Control": "no-store" };
  const key = url.pathname.slice("/thing/".length);
  const thing = /^[0-9a-f]{32}$/.test(key) ? canvas.list().find((t) => thingKey(t.id) === key) : undefined;
  if (!thing || (req.method !== "GET" && req.method !== "HEAD")) {
    res.writeHead(404, plain).end("not found\n");
    return;
  }
  let source: string;
  try {
    const v = Number(url.searchParams.get("v"));
    source = canvas.source(thing.id, Number.isInteger(v) && v > 0 ? v : undefined);
  } catch {
    res.writeHead(404, plain).end("not found\n");
    return;
  }
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "Content-Security-Policy": THING_POLICY,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  });
  res.end(req.method === "HEAD" ? undefined : wrapThing(source));
}

/** The operator's command line (woody-hud canvas ...) talks to the running gateway here. */
function serveCanvasSocket(): void {
  fs.rmSync(CANVAS_SOCKET, { force: true });
  const listener = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 2_000_000) return socket.destroy();
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        void (async () => {
          let reply: Record<string, unknown>;
          try {
            const m = JSON.parse(line);
            // As Woody: the same checks as Woody's own requests (Pause, the trial on a screen).
            reply = { ok: true, result: m.by === "you" ? canvasOp("you", m) : await woodyRequest(m) };
          } catch (err) {
            reply = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
          if (!socket.destroyed) socket.write(JSON.stringify(reply) + "\n");
        })();
      }
    });
  });
  listener.on("error", (err) => console.error("woody-hud: the canvas socket is off:", err.message));
  listener.listen(CANVAS_SOCKET, () => {
    try {
      fs.chmodSync(CANVAS_SOCKET, 0o600);
    } catch {
      /* the default mask already keeps others out */
    }
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
  // Frames may only show things and the terminal. A thing that navigates
  // its own frame anywhere else is stopped here.
  const self = `${host ? "https" : "http"}://${req.headers.host ?? `127.0.0.1:${PORT}`}`;
  return {
    "Content-Security-Policy": [
      "default-src 'self'",
      `connect-src ${connect}`,
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      `frame-src ${self}/thing/ ${self}/term/`,
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
  // A thing is fetched by a sandboxed frame, which may carry no session: its
  // key is what grants access, on both doors.
  if (url.pathname.startsWith("/thing/")) return serveThing(req, res, url);
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

  // Send the current approvals, meters and canvas straight away.
  lastApprovals = "";
  void pollApprovals();
  send(browser, readMeters());
  send(browser, canvasSnapshot());

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

    if (type === "canvas_op") {
      // What the operator does on the canvas, and what things ask of the bridge.
      try {
        send(browser, { type: "canvas_result", rid: msg.rid ?? null, op: msg.op, ok: true, result: canvasOp("you", msg) });
      } catch (err) {
        send(browser, { type: "canvas_result", rid: msg.rid ?? null, op: msg.op, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
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

// ---- the machine: meters -------------------------------------------------
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

if (process.argv[2] === "canvas") {
  // sudo -u woody-hud woody-hud canvas <request> ...   (see docs/HUD.md)
  const [, , , op, ...rest] = process.argv;
  const flags: Record<string, string> = {};
  const words: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) flags[a.slice(2)] = rest[i + 1]?.startsWith("--") || rest[i + 1] === undefined ? "yes" : rest[++i]!;
    else words.push(a);
  }
  const file = (p: string | undefined): string => {
    if (!p) throw new Error("a source file is needed");
    return fs.readFileSync(p, "utf8");
  };
  const num = (v: string | undefined): number | undefined => (v === undefined ? undefined : Number(v));
  let request: Record<string, unknown>;
  try {
    switch (op) {
      case "list":
      case "undo":
        request = { op };
        break;
      case "history":
        request = { op, n: num(words[0]) ?? 20 };
        break;
      case "make":
        request = { op, title: words[0], source: file(words[1]), kind: flags.pretend ? "pretend" : "real", for: flags.for, why: flags.why, uninvited: Boolean(flags.uninvited), note: flags.note,
          box: flags.at ? Object.fromEntries(flags.at.split(",").map((v, i) => [["x", "y", "w", "h"][i]!, Number(v)])) : undefined };
        break;
      case "kit":
        request = { op, part: words[0], props: JSON.parse(words[1] ?? "{}"), title: flags.title ?? words[0], why: flags.why, for: flags.for, uninvited: Boolean(flags.uninvited), note: flags.note };
        break;
      case "change":
        request = { op, id: words[0], source: file(words[1]), why: flags.why, title: flags.title };
        break;
      case "place":
        request = { op, id: words[0], box: { x: num(words[1]), y: num(words[2]), w: num(words[3]), h: num(words[4]) }, raise: true, why: flags.why };
        break;
      case "remove":
      case "bring_back":
      case "get":
        request = { op, id: words[0], why: flags.why };
        break;
      case "pin":
        request = { op, id: words[0], pinned: words[1] !== "off" };
        break;
      case "limit":
        request = words[0] === undefined ? { op: "limits" } : { op: "set_limit", n: Number(words[0]) };
        break;
      default:
        console.error(
          "usage: woody-hud canvas list | history [n] | undo\n" +
            "       woody-hud canvas make <title> <file> [--why text] [--pretend] [--for woody] [--at x,y,w,h] [--uninvited --note text]\n" +
            "       woody-hud canvas kit <part> '<values as JSON>' [--title text] [--why text] [--uninvited --note text]\n" +
            "       woody-hud canvas limit [n]     how many things Woody may add in a day on its own (setting it needs --as you)\n" +
            "       woody-hud canvas change <id> <file> [--why text] [--title text]\n" +
            "       woody-hud canvas place <id> <x> <y> [w] [h] | remove <id> | bring_back <id> | get <id> | pin <id> [off]\n" +
            "       add --as you to act as the operator; without it the request is made as Woody would make it",
        );
        process.exit(2);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
  request.by = flags.as === "you" || ["undo", "pin", "list", "history", "get"].includes(op!) ? "you" : "woody";
  const socket = net.createConnection(CANVAS_SOCKET);
  let reply = "";
  socket.setEncoding("utf8");
  socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
  socket.on("data", (chunk: string) => {
    reply += chunk;
    if (!reply.includes("\n")) return;
    const r = JSON.parse(reply);
    if (r.ok) console.log(typeof r.result === "string" ? r.result : JSON.stringify(r.result, null, 2));
    else console.error(`refused: ${r.error}`);
    process.exit(r.ok ? 0 : 1);
  });
  socket.on("error", (err) => {
    console.error(`The HUD gateway is not reachable (${err.message}). Run this as the woody-hud user.`);
    process.exit(1);
  });
  await new Promise(() => {});
}

terminalFlag();
canvas = new Canvas(path.join(STATE_DIR, "canvas"));
toldSeq = canvas.last()?.seq ?? 0;
serveCanvasSocket();
connectCanvasLink();

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
