// A listener that should never hear anything.
//
// The scripted browser check (drive.cjs) puts a hostile thing on the canvas
// (../probe.html) that tries every way out of its frame it can think of, each
// aimed at this port. Whatever arrives here, by HTTP, WebSocket or UDP, is a
// leak, and GET /leaks lists them.
//
//   node sink.mjs --port 7811
import dgram from "node:dgram";
import http from "node:http";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const PORT = Number(arg("port", "7811"));

const leaks = [];
const leak = (via, detail) => leaks.push({ via, detail, at: Date.now() });

const TYPES = { ".js": "text/javascript", ".css": "text/css" };

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://sink");
  const p = url.pathname;
  if (p === "/leaks") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(leaks));
  }
  if (p === "/leak" || p === "/leak.js" || p === "/leak.css") {
    const via = url.searchParams.get("via") ?? "unknown";
    leak(via, `${req.method} ${req.headers.host}${req.url}`);
    const ext = p.slice(p.lastIndexOf("."));
    res.writeHead(200, { "content-type": TYPES[ext] ?? "text/html", "access-control-allow-origin": "*" });
    // Loaded as a page, it also tells its parent that it got through.
    return res.end(p === "/leak" ? `<script>try { parent.postMessage({ leaked: ${JSON.stringify(via)} }, "*"); } catch (e) {}</script>leaked` : "");
  }
  res.writeHead(404);
  res.end();
});

// A WebSocket handshake is a leak too; it is recorded and refused.
server.on("upgrade", (req, socket) => {
  leak("websocket", `${req.headers.host}${req.url}`);
  socket.destroy();
});

// Anything arriving by UDP on the same port would be a WebRTC (STUN) leak.
for (const [type, via] of [["udp4", "webrtc-udp4"], ["udp6", "webrtc-udp6"]]) {
  try {
    const udp = dgram.createSocket(type);
    udp.on("message", (msg, from) => leak(via, `${msg.length} bytes from ${from.address}:${from.port}`));
    udp.on("error", () => {});
    udp.bind(PORT, type === "udp4" ? "127.0.0.1" : "::1");
  } catch {
    // No such address family here: nothing to listen for.
  }
}

server.listen(PORT, "127.0.0.1");
