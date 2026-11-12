// The host door: the same HUD for the operator's own browser, over HTTPS and
// behind a password. This file holds who is signed in, the password, the
// sign-in page, and the headers every page is sent with.
import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import { PASSWORD_FILE, PORT } from "./config.js";

// ---- who is asking --------------------------------------------------------
//
// Two doors:
//  * the kiosk: plain HTTP on loopback, gated by the token the kiosk session
//    receives through its bootstrap file. Only this door has the terminal.
//  * the host: HTTPS on the host-only network, gated by a password the
//    operator sets and a session cookie. No terminal there, ever.

export const SESSION_MS = 12 * 3600 * 1000;
export const sessions = new Map<string, number>();
export const loginFailures: number[] = [];

export function cookies(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function hostSession(req: http.IncomingMessage): boolean {
  const id = cookies(req).woody_session;
  const expires = id ? sessions.get(id) : undefined;
  if (!id || !expires) return false;
  if (expires < Date.now()) {
    sessions.delete(id);
    return false;
  }
  return true;
}

export function hashPassword(password: string, salt = crypto.randomBytes(16)): string {
  const hash = crypto.scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function passwordIsSet(): boolean {
  return fs.existsSync(PASSWORD_FILE);
}

export function checkPassword(password: string): boolean {
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
export function loginLocked(): boolean {
  const cutoff = Date.now() - 10 * 60_000;
  while (loginFailures.length && loginFailures[0]! < cutoff) loginFailures.shift();
  return loginFailures.length >= 5;
}

export const LOGIN_PAGE = `<!doctype html>
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

export function securityHeaders(req: http.IncomingMessage, host: boolean): Record<string, string> {
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

export function handleLogin(req: http.IncomingMessage, res: http.ServerResponse): void {
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
