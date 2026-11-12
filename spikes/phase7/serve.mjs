#!/usr/bin/env node
// Phase 7a spike server (throwaway). No dependencies.
//
// Serves the test canvas and its things the way the real gateway is meant to:
// the frame page under a strict policy, each thing as its own document with a
// policy that forbids every network use, shown in a sandboxed frame.
//
// It also plays the outside world for the isolation probe: anything that
// reaches /leak, the WebSocket path or the UDP port is recorded as a leak.
//
//   node serve.mjs [--port 7811] [--out ./out] [--once] [--mock-api] [--keep-webrtc]
//
// Open http://127.0.0.1:<port>/ (or http://localhost:<port>/). The two names
// are two different origins on purpose: one serves the canvas, the other
// stands in for a foreign site.
import dgram from "node:dgram";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PORT = Number(opt("port", "7811"));
const OUT = path.resolve(opt("out", path.join(here, "out")));
const ONCE = flag("once");
const MOCK_API = flag("mock-api");
// The WebRTC interfaces are removed from a thing's page before its code runs:
// the policy cannot forbid them, and they can send packets anywhere (found by
// this spike). --keep-webrtc leaves them in, to see the hole.
const STRIP_WEBRTC = !flag("keep-webrtc");
const CANVAS = path.join(here, "canvas");
const MADE = path.join(OUT, "made");

fs.mkdirSync(MADE, { recursive: true });

/** Everything that reached the "outside". An empty list is the goal. */
const leaks = [];
function leak(via, detail) {
  leaks.push({ via, detail, at: Date.now() });
  console.log(`LEAK  via=${via}  ${detail}`);
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json" };

/** The other name for this server: a different origin on the same port. */
function origins(req) {
  const host = String(req.headers.host ?? `127.0.0.1:${PORT}`);
  const name = host.replace(/:\d+$/, "");
  const other = name === "localhost" ? "127.0.0.1" : "localhost";
  return { self: `http://${host}`, other: `http://${other}:${PORT}` };
}

/** The policy of the frame page: its own scripts only, frames only from the things path. */
function framePolicy(req) {
  const { self, other } = origins(req);
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    `connect-src 'self' ${other}`, // the other origin only for the reachability check
    `frame-src ${self}/thing/ ${other}/thing/`,
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/** The policy of a thing: inline code only, no network of any kind, sandboxed even if opened directly. */
const THING_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "webrtc 'block'",
  "sandbox allow-scripts",
].join("; ");

const BRIDGE = fs.readFileSync(path.join(CANVAS, "bridge.js"), "utf8");
const STRIP = `for (const k of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCIceTransport", "RTCSctpTransport", "RTCDtlsTransport"]) { try { delete window[k]; } catch (e) {} try { Object.defineProperty(window, k, { value: undefined, configurable: false, writable: false }); } catch (e) {} }
`;

/** A thing's source is a fragment. The canvas owns the document around it. */
function wrapThing(fragment) {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
:root { --bg: #050400; --fg: #ffb000; --dim: #a98a45; --line: #4a3a12; --red: #ff3b30; color-scheme: dark; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg); font: 14px/1.4 "JetBrains Mono", ui-monospace, monospace; overflow: hidden; }
* { box-sizing: border-box; }
</style>
<script>${STRIP_WEBRTC ? STRIP : ""}${BRIDGE}</script>
</head><body>
${fragment}
</body></html>`;
}

function send(res, status, type, body, headers = {}) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", ...headers });
  res.end(body);
}

function thingSource(name) {
  // made/<file> comes from the benchmark; everything else from canvas/things.
  const made = /^made\/([\w.-]+)$/.exec(name);
  const file = made ? path.join(MADE, made[1]) : /^[\w-]+$/.test(name) ? path.join(CANVAS, "things", `${name}.html`) : null;
  if (!file || !fs.existsSync(file)) return null;
  return fs.readFileSync(file, "utf8");
}

function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) reject(new Error("too large"));
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function summary(r) {
  const lines = ["", "================ PHASE 7a SPIKE RESULTS ================"];
  if (r.env) lines.push(`screen ${r.env.width}x${r.env.height} · ${r.env.agent}`);
  if (r.control) lines.push(`control: other origin reachable from the frame: ${r.control.other_reachable ? "yes" : "NO (probe results are not valid)"}`);
  if (r.fps?.length) {
    lines.push("", "FRAME RATE (frame page fps avg / 1% low · animated thing fps)");
    for (const p of r.fps) lines.push(`  ${p.label.padEnd(34)} ${String(p.fps_avg).padStart(5)} / ${String(p.fps_low).padStart(5)}   thing ${p.thing_fps ?? "-"}   long tasks ${p.long_tasks}`);
  }
  if (r.probe?.length) {
    const bad = r.probe.filter((p) => p.outcome !== "blocked" && p.outcome !== "ok");
    lines.push("", `ISOLATION: ${r.probe.length - bad.length} of ${r.probe.length} as wanted`);
    for (const p of r.probe) lines.push(`  ${p.outcome === "blocked" || p.outcome === "ok" ? "ok  " : "FAIL"} ${p.name.padEnd(38)} ${p.outcome}${p.detail ? ` · ${p.detail}` : ""}`);
  }
  for (const n of r.notes ?? []) lines.push("", `NOTE ${n.name}:`, `  ${n.detail}`);
  if (r.hog?.length) {
    lines.push("", "A THING THAT HOGS THE PROCESSOR (longest stall of the frame page)");
    for (const h of r.hog) lines.push(`  thing served from ${h.origin.padEnd(13)} ${h.burned_ms === null ? "the thing never finished" : `thing burned ${h.burned_ms} ms`} · frame stalled ${h.stall_ms} ms`);
  }
  if (r.made?.length) {
    lines.push("", "THINGS MADE BY THE MODELS, LOADED IN THE SANDBOX");
    for (const m of r.made) lines.push(`  ${m.started ? "ok  " : "FAIL"} ${m.file.padEnd(34)} ${m.started ? `started in ${m.start_ms} ms` : "did not start"}${m.errors.length ? ` · errors: ${m.errors.slice(0, 2).join(" | ")}` : ""}${m.csp.length ? ` · blocked: ${m.csp.slice(0, 3).join(", ")}` : ""}`);
  }
  lines.push("", `LEAKS SEEN BY THE SERVER: ${leaks.length}${leaks.length ? ` (${[...new Set(leaks.map((l) => l.via))].join(", ")})` : ""}`);
  lines.push("=========================================================", "");
  return lines.join("\n");
}

// ---- a stand-in for the Messages API, for a dry run of the benchmark -------
const MOCK_THING = `<div id="c">--:--:--</div>
<style>#c { height: 100%; display: grid; place-items: center; font-size: 15vw; letter-spacing: .05em; }</style>
<script>
  const start = Date.now();
  const el = document.getElementById("c");
  function tick() {
    const t = new Date(start - (Date.now() - start));
    el.textContent = t.toTimeString().slice(0, 8);
  }
  tick(); setInterval(tick, 250); woody.ready();
</script>`;

async function mockMessages(req, res) {
  const body = JSON.parse(await readBody(req));
  const kit = String(body.system ?? "").includes("kit of ready parts") || JSON.stringify(body.system ?? "").includes("kit of ready parts");
  const text = kit ? '{"part":"clock","props":{"timezone":"Asia/Tokyo","seconds":true}}' : MOCK_THING;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev("message_start", { message: { id: "msg_mock", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 900, output_tokens: 1 } } });
  await new Promise((r) => setTimeout(r, 300));
  ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  for (let i = 0; i < text.length; i += 40) {
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: text.slice(i, i + 40) } });
    await new Promise((r) => setTimeout(r, 15));
  }
  ev("content_block_stop", { index: 0 });
  ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: Math.ceil(text.length / 4) } });
  ev("message_stop", {});
  res.end();
}

// ---- requests ---------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const p = url.pathname;
  try {
    if (p === "/") return send(res, 200, MIME[".html"], fs.readFileSync(path.join(CANVAS, "index.html")), { "content-security-policy": framePolicy(req) });
    if (p === "/frame.js" || p === "/frame.css") return send(res, 200, MIME[path.extname(p)], fs.readFileSync(path.join(CANVAS, p.slice(1))));

    if (p.startsWith("/thing/")) {
      const source = thingSource(decodeURIComponent(p.slice("/thing/".length)));
      if (source === null) return send(res, 404, "text/plain", "no such thing");
      return send(res, 200, MIME[".html"], wrapThing(source), { "content-security-policy": THING_POLICY });
    }
    // The same document as text, for the variant where the frame page injects it itself.
    if (p.startsWith("/raw/")) {
      const source = thingSource(decodeURIComponent(p.slice("/raw/".length)));
      if (source === null) return send(res, 404, "text/plain", "no such thing");
      return send(res, 200, "text/plain; charset=utf-8", wrapThing(source));
    }

    if (p === "/ping") return send(res, 200, "text/plain", "pong", { "access-control-allow-origin": "*" });
    if (p === "/leak" || p === "/leak.js" || p === "/leak.css") {
      leak(url.searchParams.get("via") ?? "unknown", `${req.method} ${req.headers.host}${req.url}`);
      // If a frame was navigated here, say so to whoever embeds it.
      const page = `<script>try { parent.postMessage({ leaked: ${JSON.stringify(url.searchParams.get("via") ?? "unknown")} }, "*"); } catch (e) {}</script>leaked`;
      return send(res, 200, p.endsWith(".js") ? MIME[".js"] : p.endsWith(".css") ? MIME[".css"] : MIME[".html"], p === "/leak" ? page : "", { "access-control-allow-origin": "*" });
    }
    if (p === "/leaks") return send(res, 200, MIME[".json"], JSON.stringify(leaks));

    if (p === "/meters") {
      const load = os.loadavg()[0] ?? 0;
      return send(res, 200, MIME[".json"], JSON.stringify({ cpu_pct: Math.min(100, Math.round((load / os.cpus().length) * 100)), mem_total_kb: Math.round(os.totalmem() / 1024), mem_used_kb: Math.round((os.totalmem() - os.freemem()) / 1024), at: Date.now() }));
    }
    if (p === "/made/list") {
      let bench = [];
      try {
        bench = JSON.parse(fs.readFileSync(path.join(OUT, "bench.json"), "utf8")).runs ?? [];
      } catch {
        /* the benchmark has not run */
      }
      const files = fs.readdirSync(MADE).filter((f) => f.endsWith(".html")).sort();
      return send(res, 200, MIME[".json"], JSON.stringify(files.map((file) => ({ file, ...(bench.find((b) => b.file === file) ?? {}) }))));
    }
    if (p === "/results" && req.method === "POST") {
      const results = JSON.parse(await readBody(req));
      results.leaks = leaks;
      fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
      console.log(summary(results));
      console.log(`Full results: ${path.join(OUT, "results.json")}`);
      send(res, 200, MIME[".json"], JSON.stringify({ ok: true, leaks }));
      if (ONCE) setTimeout(() => process.exit(0), 300);
      return;
    }
    if (MOCK_API && p === "/v1/messages" && req.method === "POST") return await mockMessages(req, res);
    return send(res, 404, "text/plain", "not found");
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, "text/plain", "error");
  }
});

// A WebSocket attempt from a thing: record it and hang up.
server.on("upgrade", (req, socket) => {
  if (String(req.url).startsWith("/leak-ws")) leak("websocket", `${req.headers.host}${req.url}`);
  socket.destroy();
});

// "localhost" may resolve to ::1, so listen on both loopback addresses.
server.listen(PORT, "127.0.0.1", () => console.log(`spike server on http://127.0.0.1:${PORT}/ and http://localhost:${PORT}/  (out: ${OUT})`));
const v6 = http.createServer((req, res) => server.emit("request", req, res));
v6.on("upgrade", (req, socket) => server.emit("upgrade", req, socket));
v6.on("error", () => {});
v6.listen(PORT, "::1");

// Anything arriving by UDP on the same port would be a WebRTC (STUN) leak.
// The next port up is used by the probe's second attempt, through an inner frame.
for (const [type, addr] of [["udp4", "127.0.0.1"], ["udp6", "::1"]]) {
  for (const [port, via] of [[PORT, "webrtc-stun"], [PORT + 1, "webrtc-inner"]]) {
    const udp = dgram.createSocket(type);
    udp.on("message", (msg, from) => leak(via, `${msg.length} bytes from ${from.address}:${from.port}`));
    udp.on("error", () => {});
    udp.bind(port, addr);
  }
}
