#!/usr/bin/env node
// woody-chat: a terminal client for the agent, for use until the HUD exists
// and as an escape hatch afterwards.
//
//   sudo woody-chat
//
// Commands: /model [id]   /new   /stop   /quit
import readline from "node:readline";
import { WebSocket } from "ws";

const socketPath = process.env.WOODY_AGENT_SOCKET ?? "/run/woody-agent/agent.sock";
const url = process.env.WOODY_AGENT_URL ?? `ws+unix://${socketPath}:/`;

const ws = new WebSocket(url);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

type Model = { id: string; label: string; note: string };
let models: Model[] = [];
let streaming = false;
let busy = false;

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const amber = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

function prompt(): void {
  if (!busy) {
    rl.setPrompt(amber("you> "));
    rl.prompt();
  }
}

function endStream(): void {
  if (streaming) {
    process.stdout.write("\n");
    streaming = false;
  }
}

ws.on("open", () => console.log(dim(`connected to ${url}`)));

ws.on("error", (err) => {
  console.error(red(`cannot reach the agent: ${err.message}`));
  console.error(dim("Is woody-agent running, and are you root or the HUD user?"));
  process.exit(1);
});

ws.on("close", () => {
  endStream();
  console.log(dim("connection closed"));
  process.exit(0);
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString()) as Record<string, any>;
  switch (msg.type) {
    case "state": {
      const first = models.length === 0;
      models = msg.models;
      busy = msg.busy;
      if (first) {
        const b = msg.budget;
        console.log(dim(`model ${msg.model} · budget $${b.spent_usd} of $${b.cap_usd} used in ${b.month}`));
        if (!msg.has_credential) {
          console.log(red("No API key is configured for the agent. See docs/AGENT.md."));
        }
      }
      prompt();
      break;
    }
    case "turn_start":
      busy = true;
      break;
    case "assistant_delta":
      if (!streaming) {
        process.stdout.write(amber("woody> "));
        streaming = true;
      }
      process.stdout.write(msg.text);
      break;
    case "tool_use":
      endStream();
      console.log(dim(`  → ${msg.name} ${JSON.stringify(msg.input)}`));
      break;
    case "tool_result":
      console.log(dim(`  ← ${msg.is_error ? "error: " : ""}${String(msg.preview).replace(/\s+/g, " ").slice(0, 200)}`));
      break;
    case "approval_pending":
      endStream();
      console.log(red(`  ! approval needed: ${msg.action} ${JSON.stringify(msg.params)}`));
      console.log(red(`    in another shell:  sudo woodyctl approve ${msg.approval_id}   (or: deny)`));
      break;
    case "approval_resolved":
      console.log(dim(`  approval ${msg.approval_id}: ${msg.status}`));
      break;
    case "result":
      endStream();
      console.log(
        dim(
          `  [${msg.subtype} · $${Number(msg.cost_usd).toFixed(4)} · month $${msg.budget.spent_usd}/$${msg.budget.cap_usd}]`,
        ),
      );
      break;
    case "error":
      endStream();
      console.log(red(`  error: ${msg.error}${msg.detail ? ` (${msg.detail})` : ""}`));
      prompt();
      break;
  }
});

rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return prompt();
  if (text === "/quit" || text === "/exit") {
    ws.close();
    return;
  }
  if (text === "/new") {
    ws.send(JSON.stringify({ type: "new_session" }));
    console.log(dim("started a new conversation"));
    return;
  }
  if (text === "/stop") {
    ws.send(JSON.stringify({ type: "interrupt" }));
    return;
  }
  if (text.startsWith("/model")) {
    const id = text.split(/\s+/)[1];
    if (!id) {
      for (const m of models) console.log(dim(`  ${m.id}  (${m.label}, ${m.note})`));
      return prompt();
    }
    ws.send(JSON.stringify({ type: "set_model", model: id }));
    console.log(dim(`model set to ${id} for the next message`));
    return;
  }
  ws.send(JSON.stringify({ type: "chat", text }));
});

rl.on("close", () => ws.close());
