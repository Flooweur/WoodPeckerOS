// WoodPecker Phase 0: prove the Agent SDK runs as a hardened systemd service.
// Reports which credential type was used, whether the model answered, and
// what the run cost, without ever printing the credential itself.
import { query } from "@anthropic-ai/claude-agent-sdk";

const hasOAuth = Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN);
const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);

if (hasOAuth === hasKey) {
  console.error(
    "Set exactly one of CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in /etc/woody-spike/agent.env",
  );
  process.exit(2);
}

const credential = hasOAuth ? "subscription-oauth-token" : "api-key";
console.log(JSON.stringify({ event: "start", credential, uid: process.getuid(), cwd: process.cwd() }));

const started = Date.now();
try {
  for await (const message of query({
    prompt: "Reply with exactly: WOODY ONLINE",
    options: {
      maxTurns: 1,
      allowedTools: [],          // no tools: this only tests transport + auth
      settingSources: [],        // ignore any user/project settings on disk
    },
  })) {
    if (message.type === "system" && message.subtype === "init") {
      console.log(JSON.stringify({ event: "init", model: message.model }));
    }
    if (message.type === "result") {
      console.log(JSON.stringify({
        event: "result",
        credential,
        ok: message.subtype === "success",
        subtype: message.subtype,
        text: message.result ?? null,
        cost_usd: message.total_cost_usd ?? null,
        usage: message.usage ?? null,
        wall_ms: Date.now() - started,
      }));
      process.exit(message.subtype === "success" ? 0 : 1);
    }
  }
  console.error(JSON.stringify({ event: "error", error: "stream ended without a result" }));
  process.exit(1);
} catch (err) {
  console.error(JSON.stringify({ event: "error", credential, error: String(err?.stack ?? err) }));
  process.exit(1);
}
