// The access token. Because the gateway carries approvals, the kiosk's page
// must prove it is the kiosk's: it is handed a secret token through a
// bootstrap file that only the kiosk user can read, never through a command
// line or an address anyone could open.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PORT, RUNTIME_DIR, STATE_DIR } from "./config.js";

// ---- access token ---------------------------------------------------------

export function loadToken(): string {
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

export const TOKEN = loadToken();

export function tokenOk(candidate: string | null): boolean {
  if (!candidate || candidate.length !== TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(TOKEN));
}

/** The kiosk opens this file; it waits for the gateway and then loads the HUD with the token. */
export function writeBootstrap(): void {
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
