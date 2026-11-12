// The operator's terminal: a login prompt (ttyd, on a local socket) relayed to
// the kiosk, and only to the kiosk. While it is open, Woody's screenshots
// are switched off: what is typed there is not Woody's to see.
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { TOKEN, tokenOk } from "./access.js";
import { ORIGINS, TERMINAL_FLAG, TERM_SOCKET } from "./config.js";
import { cookies } from "./door.js";

// ---- the terminal ---------------------------------------------------------
//
// A real shell for the operator, served by a separate root service (ttyd
// running \`login\`) on a Unix socket only this gateway can open. The gateway
// relays it to the kiosk and nowhere else. While a terminal is open, a flag
// file tells the executor to refuse screenshots, so Woody cannot look at it.

export let terminals = 0;
export function terminalFlag(): void {
  try {
    if (terminals > 0) fs.writeFileSync(TERMINAL_FLAG, "open\n", { mode: 0o644 });
    else fs.rmSync(TERMINAL_FLAG, { force: true });
  } catch {
    /* the runtime directory is gone: the service is stopping */
  }
}

export function terminalAllowed(req: http.IncomingMessage, url: URL): boolean {
  return Boolean(TERM_SOCKET) && (tokenOk(url.searchParams.get("t")) || tokenOk(cookies(req).woody_term ?? null));
}

export function proxyTerminal(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
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

export function proxyTerminalUpgrade(req: http.IncomingMessage, socket: import("node:stream").Duplex, head: Buffer, url: URL): void {
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
