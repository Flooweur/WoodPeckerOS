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
//  * gives files to Woody and hands out its results: the operator's side of
//    the workbench's folder (files.ts)
//  * takes Woody's requests about the canvas over a link to the agent, tries
//    each new thing on the screen before keeping it, and refuses them while
//    the operator has paused Woody
//
// Because it carries approvals, access is gated by a secret token. The token
// reaches the kiosk browser through a bootstrap file only the kiosk user can
// read, never through a command line or an unauthenticated URL.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { Canvas, CanvasError, THING_POLICY, describe, wrapThing, type Actor, type Thing } from "./canvas.js";
import { FeedError, readFeed, readJournal } from "./feeds.js";
import { Bench, FilesError, sendDownload } from "./files.js";
import { tokenOk, writeBootstrap } from "./access.js";
import { commandLine } from "./cli.js";
import { AGENT_BOUND, AGENT_SOCKET, APPROVE_SOCKET, BIND, CANVAS_SOCKET, HOST_PORT, JOURNALCTL, ORIGINS, PORT, STATE_DIR, SYSTEMCTL, TERM_SOCKET, TLS_DIR, WEB_ROOT } from "./config.js";
import { handleLogin, hostSession, passwordIsSet, securityHeaders } from "./door.js";
import { buildPart, kitCatalogue } from "./kit.js";
import { readMeters } from "./meters.js";
import { proxyTerminal, proxyTerminalUpgrade, terminalFlag } from "./terminal.js";


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
/** The workbench's folder, where the operator gives files to Woody and takes its results. */
const bench = new Bench(process.env.WOODY_BENCH_DIR);
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
        // Woody reading a thing's content has seen what changed in it.
        if (by === "woody") canvas.stateSeen(String(m.id));
        return canvas.state(String(m.id));
      case "state_set":
        canvas.setState(String(m.id), m.value, by, by === "you" && m.touched === true);
        // What Woody writes reaches the thing on every screen at once.
        if (by === "woody") for (const ws of browsers) send(ws, { type: "thing_state", id: String(m.id), value: m.value ?? null });
        return true;
      case "state_news":
        if (by !== "woody") throw new CanvasError("that is asked for Woody");
        return canvas.stateNews();
      case "health":
        // The frame says whether a thing started. Only a screen can know.
        if (by !== "you") throw new CanvasError("only a screen reports that");
        reportHealth(String(m.id), Number(m.version), m.phase === "ready" ? "ready" : "failed", Array.isArray(m.faults) ? m.faults.map(String).slice(-5) : []);
        return true;
      case "picture_put":
        // A picture the executor fetched and re-encoded, handed over by the agent to be kept.
        return canvas.putPicture(by, m);
      case "pictures":
        return canvas.pictureList();
      case "picture":
        // A thing asks, through the bridge, for a picture it was given. The thing is known by its window, not its word.
        if (by !== "you") throw new CanvasError("only a thing on a screen asks for that");
        return canvas.pictureFor(String(m.id), String(m.picture));
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
      // Pictures from the web that are kept and can be given to a thing by their id.
      pictures: canvas.pictureList().map((p) => ({ id: p.id, width: p.width, height: p.height, from: p.source, shows: p.about, used_by: all.filter((t) => (t.pictures ?? []).some((x) => x.id === p.id)).map((t) => t.id) })),
      put_away: all.filter((t) => t.removed).map((t) => ({ id: t.id, title: t.title, made_by: t.by, on_its_own: t.uninvited === true })),
      // Things you added today without being asked, and the most the operator allows in a day.
      own_additions: { today: canvas.uninvitedToday(), limit: canvas.limits().uninvited_per_day },
      kit: kitCatalogue(),
    };
  }
  if (op === "get" || op === "kit_catalogue" || op === "limits" || op === "may_add" || op === "pictures" || op === "picture_put" || op === "state_get" || op === "state_news") return canvasOp("woody", m);
  if (op === "state_set") {
    // A thing's data, written by Woody. Pause holds it back like any other change; pinning does not.
    let held: boolean;
    try {
      held = Boolean((await approvalCall({ op: "status" })).result?.paused);
    } catch {
      throw new CanvasError("The executor cannot be reached, so Pause cannot be checked. Nothing was changed.");
    }
    if (held) throw new CanvasError("paused-by-operator: the canvas is not changed while the operator has paused you");
    return canvasOp("woody", m);
  }
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

// ---- feeds: what things read ----

const agentAsks = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let agentAskSeq = 0;

/** Asks the agent for something of the mind (the goals, the journal, memories, the conversation), over the gateway's own connection. */
function askAgent(op: string, params: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (link?.readyState !== WebSocket.OPEN) return reject(new FeedError("Woody is not connected right now"));
    const rid = `f${++agentAskSeq}`;
    agentAsks.set(rid, { resolve, reject });
    setTimeout(() => {
      if (agentAsks.delete(rid)) reject(new FeedError("Woody did not answer in time"));
    }, 6000).unref();
    link.send(JSON.stringify({ ...params, type: "mind", op, rid }));
  });
}

const feedDeps = { systemctl: SYSTEMCTL, journalctl: JOURNALCTL, askAgent, bench };

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
    if (m.type === "mind_result" && typeof m.rid === "string") {
      // The agent's answer to something a feed asked (askAgent below).
      const waiting = agentAsks.get(m.rid);
      if (waiting) {
        agentAsks.delete(m.rid);
        if (m.ok) waiting.resolve(m.result);
        else waiting.reject(new FeedError(String(m.error ?? "the agent refused")));
      }
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
  if (url.pathname.startsWith("/files/")) return serveFiles(req, res, url, host);
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

// ---- files given to Woody and taken from it ------------------------------------

/**
 * The operator's side of the workbench's folder. On the host door the session
 * was checked before this is reached, and a request that changes something
 * must come from the HUD's own page. The kiosk has no session: its frame
 * sends the token it was given.
 */
function serveFiles(req: http.IncomingMessage, res: http.ServerResponse, url: URL, host: boolean): void {
  const json = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
  const reading = req.method === "GET";
  const allowed = host ? reading || req.headers.origin === `https://${req.headers.host}` : tokenOk(String(req.headers["x-woody-token"] ?? ""));
  if (!allowed) return void json(403, { error: "not allowed" });
  const failed = (err: unknown) => void json(err instanceof FilesError ? err.status : 500, { error: err instanceof Error ? err.message : String(err) });
  const changed = () => {
    for (const ws of browsers) send(ws, { type: "files_changed" });
  };
  try {
    if (url.pathname === "/files/list" && reading) {
      return void json(200, bench.available ? { available: true, ...bench.list() } : { available: false, files: [], truncated: false, free_bytes: null });
    }
    if (url.pathname === "/files/get" && reading) return sendDownload(res, bench.resolve(url.searchParams.get("path") ?? ""));
    if (url.pathname === "/files/put" && req.method === "POST") {
      bench
        .receive(req, url.searchParams.get("name") ?? "file")
        .then((given) => {
          changed();
          // Woody is told, and waits: the file is listed in front of it the next time the operator speaks.
          if (link?.readyState === WebSocket.OPEN) link.send(JSON.stringify({ type: "file_given", path: given.path, bytes: given.bytes }));
          json(200, given);
        })
        .catch(failed);
      return;
    }
    if (url.pathname === "/files/delete" && req.method === "POST") {
      bench.remove(url.searchParams.get("path") ?? "");
      changed();
      return void json(200, { removed: true });
    }
    json(404, { error: "no such request" });
  } catch (err) {
    failed(err);
  }
}

const server = http.createServer((req, res) => handle(req, res, false));

// ---- browser sessions -----------------------------------------------------

/**
 * Which build of the frame is served: a short hash of its start page, which
 * names the script and style files by their own hashes. After an update of
 * the system the gateway restarts with a new one, and screens that were left
 * open are still running the old frame.
 */
const BUILD = (() => {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(path.join(WEB_ROOT, "index.html"))).digest("hex").slice(0, 12);
  } catch {
    return "";
  }
})();

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
  // It is also told which build of the frame this gateway serves: a page that runs an older one reloads itself.
  send(browser, { type: "hello", kiosk: !host, terminal: !host && Boolean(TERM_SOCKET), build: BUILD });
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

    if (type === "canvas_op" && msg.op === "feed") {
      // A thing reads a feed through the bridge (feeds.ts). Read-only, whatever it asks for.
      try {
        send(browser, { type: "canvas_result", rid: msg.rid ?? null, op: "feed", ok: true, result: await readFeed(feedDeps, String(msg.feed ?? ""), (msg.args ?? {}) as Record<string, unknown>) });
      } catch (err) {
        send(browser, { type: "canvas_result", rid: msg.rid ?? null, op: "feed", ok: false, error: err instanceof FeedError || err instanceof FilesError ? err.message : "that feed could not be read" });
      }
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
      try {
        send(browser, { type: "logs", ok: true, entries: await readJournal(JOURNALCTL, msg) });
      } catch {
        send(browser, { type: "logs", ok: false, error: "The journal could not be read.", entries: [] });
      }
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


setInterval(() => {
  if (browsers.size === 0) return;
  const meters = readMeters();
  for (const ws of browsers) send(ws, meters);
}, 2000).unref();

// ---- start ----------------------------------------------------------------

await commandLine();


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
