#!/usr/bin/env node
// woody-chat: a terminal client for the agent, for use until the HUD exists
// and as an escape hatch afterwards.
//
//   sudo woody-chat
//
// Commands: /model [id]   /new   /stop   /quit
//           /memories [words]   /memory <id>   /remember <text>   /correct <id> <text>
//           /pin <id>   /unpin <id>   /forget <id>   /journal [n]   /mind
//           /alarms   /unalarm <id>   /pulse
//           /goals   /inbox   /goal <id>   /goal-add <title> | <details>   /accept <id>
//           /drop <id>   /say <id> <text>
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
let streamedSinceTurn = false;

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
      streamedSinceTurn = false;
      break;
    case "assistant_delta":
      if (!streaming) {
        process.stdout.write(amber("woody> "));
        streaming = true;
        streamedSinceTurn = true;
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
    case "note":
      endStream();
      console.log(amber(`  * ${msg.text}`));
      break;
    case "assistant_text":
      // Shown here only when it was not streamed (Woody speaking unprompted).
      if (!streaming && !streamedSinceTurn) console.log(amber("woody> ") + msg.text);
      break;
    case "mind_result":
      if (!msg.ok) console.log(red(`  ${msg.error}`));
      else printMind(msg.op, msg.result);
      prompt();
      break;
  }
});

const ORIGIN: Record<string, string> = { user: "you said so", observed: "observed", inferred: "inferred", web: "web" };

function memoryRow(m: Record<string, any>): string {
  const flags = [m.pinned ? "pinned" : "", m.superseded_by ? `replaced by #${m.superseded_by}` : ""].filter(Boolean).join(", ");
  const when = new Date(m.confirmed).toISOString().slice(0, 10);
  return `  #${m.id} [${m.kind}; ${ORIGIN[m.origin] ?? m.origin}; ${when}${flags ? `; ${flags}` : ""}] ${m.statement}`;
}

function goalRow(g: Record<string, any>): string {
  const money = g.standing
    ? `$${g.standing.week_spent_usd.toFixed(2)}/$${g.standing.weekly_usd.toFixed(2)} this week${g.standing.enabled ? "" : ", off"}`
    : g.budget_usd > 0
      ? `$${g.spent_usd.toFixed(2)}/$${g.budget_usd.toFixed(2)}`
      : "";
  return `  #${g.id} [${g.status}] ${g.title}${money ? ` (${money})` : ""}${g.waiting_reason ? ` — ${g.waiting_reason}` : ""}`;
}

function printMind(op: string, result: any): void {
  switch (op) {
    case "memories":
    case "memory":
      if (!result.length) console.log(dim("  nothing found"));
      for (const m of result) console.log(memoryRow(m));
      break;
    case "journal":
      if (!result.length) console.log(dim("  the journal is empty"));
      for (const j of result) {
        console.log(amber(`  ${new Date(j.ts).toISOString().slice(0, 16).replace("T", " ")}`));
        console.log(`    ${j.summary || `${j.wake} ${j.did} ${j.outcome}`}`);
        if (j.next) console.log(dim(`    next: ${j.next}`));
      }
      break;
    case "forget":
      console.log(dim(`  deleted ${result.deleted.map((i: number) => `#${i}`).join(", ")}`));
      break;
    case "goals":
      for (const g of result.goals) console.log(goalRow(g));
      console.log(dim(`  small-goal limit: $${result.small_goal_usd}`));
      break;
    case "inbox":
      if (!result.length) console.log(dim("  nothing needs you"));
      for (const i of result) console.log(`  ${i.kind === "plan" ? "plan to accept" : i.kind === "blocked" ? "needs your answer" : "proposal"}: ${goalRow(i.goal).trim()}`);
      break;
    case "goal": {
      const g = result.goal;
      console.log(goalRow(g));
      if (g.description) console.log(`    ${g.description}`);
      if (g.reasoning) console.log(dim(`    why: ${g.reasoning}`));
      if (g.review) {
        console.log(`    review: ${g.review.understanding}`);
        console.log(`    judgement (${g.review.recommendation}): ${g.review.judgement}`);
        g.review.plan.forEach((s: string, n: number) => console.log(`      ${n + 1}. ${s}`));
        console.log(dim(`    estimate $${g.review.estimate_usd}, ${g.review.estimate_minutes} min, ${g.review.changes_system ? "changes the system" : "read-only"}`));
        for (const q of g.review.questions) console.log(amber(`    ? ${q}`));
      }
      if (g.dossier) console.log(`    dossier: ${g.dossier}`);
      if (g.outcome) console.log(`    outcome: ${g.outcome}`);
      for (const m of result.messages) {
        if (m.kind === "user" || m.kind === "assistant") console.log(`    ${m.kind === "user" ? "you" : "woody"}: ${m.text}`);
      }
      break;
    }
    case "goal_add":
    case "goal_accept":
    case "goal_drop":
    case "goal_edit":
      console.log(goalRow(result));
      break;
    case "goal_message":
      console.log(dim("  sent"));
      break;
    case "alarms":
    case "alarm_cancel":
      if (!result.length) console.log(dim("  no alarms are set"));
      for (const a of result) console.log(`  #${a.id} ${new Date(a.due).toISOString().slice(0, 16).replace("T", " ")} UTC  ${a.reason}`);
      break;
    case "stats":
      console.log(dim(`  ${Object.entries(result).map(([k, v]) => `${k} ${v}`).join(" · ")}`));
      break;
    default:
      console.log(memoryRow(result));
  }
}

function mind(op: string, extra: Record<string, unknown> = {}): void {
  ws.send(JSON.stringify({ type: "mind", op, ...extra }));
}

/** Returns true if the line was a memory command. */
function mindCommand(text: string): boolean {
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(" ");
  const id = Number(rest[0]);
  switch (cmd) {
    case "/memories":
      mind("memories", { query: arg });
      return true;
    case "/memory":
      mind("memory", { id });
      return true;
    case "/remember":
      mind("add", { statement: arg });
      return true;
    case "/correct":
      mind("correct", { id, statement: rest.slice(1).join(" ") });
      return true;
    case "/pin":
      mind("pin", { id });
      return true;
    case "/unpin":
      mind("unpin", { id });
      return true;
    case "/forget":
      mind("forget", { id });
      return true;
    case "/journal":
      mind("journal", { n: Number(rest[0]) || 10 });
      return true;
    case "/mind":
      mind("stats");
      return true;
    case "/alarms":
      mind("alarms");
      return true;
    case "/goals":
      mind("goals", { all: rest[0] === "all" });
      return true;
    case "/inbox":
      mind("inbox");
      return true;
    case "/goal":
      mind("goal", { id });
      return true;
    case "/goal-add": {
      const [title, ...details] = arg.split("|");
      mind("goal_add", { title: (title ?? "").trim(), description: details.join("|").trim() });
      return true;
    }
    case "/accept":
      mind("goal_accept", { id });
      return true;
    case "/drop":
      mind("goal_drop", { id });
      return true;
    case "/say":
      mind("goal_message", { id, text: rest.slice(1).join(" ") });
      return true;
    case "/unalarm":
      mind("alarm_cancel", { id });
      return true;
    case "/pulse":
      ws.send(JSON.stringify({ type: "pulse" }));
      return true;
    default:
      return false;
  }
}

rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return prompt();
  if (mindCommand(text)) return;
  if (text === "/quit" || text === "/exit") {
    ws.close();
    return;
  }
  if (text === "/new") {
    ws.send(JSON.stringify({ type: "new_session" }));
    console.log(dim("cleared Woody's working context (conversation, journal and memory are kept)"));
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
