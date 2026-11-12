#!/usr/bin/env node
// Phase 7a spike (throwaway): how long does each model take to make a thing,
// and what does it cost?
//
// Three requests of rising difficulty, sent to each model one after another:
//   kit      pick and fill a ready part            (answer: a small JSON value)
//   small    "a clock that runs backwards"         (answer: a thing's source)
//   complex  an orbit you can play with            (answer: a thing's source)
//
// Each thing is saved under <out>/made, so the test canvas can then load it
// in its sandbox and say whether it starts. Numbers go to <out>/bench.json.
//
//   ANTHROPIC_API_KEY=... node bench.mjs [--models a,b] [--tasks kit,small,complex]
//                                        [--effort low] [--out ../out]
//
// A dry run without a key: start `node ../serve.mjs --mock-api`, then
//   ANTHROPIC_API_KEY=dry ANTHROPIC_BASE_URL=http://127.0.0.1:7811 node bench.mjs
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

// Dollars per million tokens (input, output), as published on 2026-11-03.
// Haiku's price holds for prompts up to 100K tokens, far above what is sent here.
const PRICES = {
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-sonnet-5-5": [2, 10],
  "claude-opus-5-5": [4, 20],
  "claude-fable-5-2": [8, 40],
};

const MODELS = opt("models", Object.keys(PRICES).join(",")).split(",").filter(Boolean);
const TASKS = opt("tasks", "kit,small,complex").split(",").filter(Boolean);
const EFFORT = opt("effort", "low");
const OUT = path.resolve(opt("out", path.join(here, "..", "out")));
fs.mkdirSync(path.join(OUT, "made"), { recursive: true });

// A first draft of what Woody's maker will be told. Part of what this spike
// measures is whether these instructions are enough.
const THING_RULES = `You make "things" for the canvas of WoodPecker-OS, a machine with a mind called Woody. A thing is a small live program shown in its own frame on the canvas: a clock, a chart, a tool, a drawing, an explanation with moving parts.

What you write is an HTML fragment: markup, one <style> element and one <script> element. The canvas places it inside the <body> of a document it owns, in an isolated frame.

Rules of the frame:
- There is no network at all. No external scripts, styles, fonts or images, and no requests of any kind. Everything is inline. Pictures are inline SVG or drawn on a <canvas>.
- No storage, cookies, dialogs (alert, prompt), popups or nested frames. They are not available.
- The frame is small and can be resized, about 320 by 220 pixels to start. Fill it (width and height 100%), never scroll, and adapt to its size.
- It must be real: working code on real time and real input. Never fake data.
- The screen is software-rendered. Keep animation light: no blur, glow, heavy shadows or large gradients, and nothing that redraws more than it needs to.

House style, already set on the document: black background, monospace type. Use the colours var(--fg) (amber, the main colour), var(--dim) (secondary text), var(--line) (rules and borders) and var(--red) (only for what needs attention).

The bridge, the thing's only way out, is the global object "woody":
- woody.ready()               call it once the thing is working. A thing that never calls it is not shown.
- woody.state.get()           a promise of the thing's own saved state (one JSON value, or null the first time).
- woody.state.set(value)      saves it. Use this for anything that must survive a restart.
- woody.subscribe("meters", fn)  fn receives { cpu_pct, mem_used_kb, mem_total_kb } every two seconds.
- woody.emit(name, data)      tells Woody something happened. Use it rarely.

Reply with the fragment only. No explanation and no code fences.`;

const KIT_RULES = `You place parts from a kit of ready parts on the canvas of WoodPecker-OS. Answer a request by choosing one part and filling its values.

The parts:
- text    { text: string }
- note    { title: string, body: string }
- list    { title: string, items: string[], checkable: boolean }
- table   { columns: string[], rows: string[][] }
- chart   { kind: "line" | "bar", feed: "cpu" | "memory" | "disk" | "network", minutes: number }
- clock   { timezone: string (IANA name), seconds: boolean, style: "digital" | "analog" }
- meter   { feed: "cpu" | "memory" | "disk" | "network", label: string }

Reply with one JSON value and nothing else: { "part": "<name>", "props": { ... } }. If no part fits, reply { "part": null, "reason": "<why>" }.`;

const KIT_PARTS = ["text", "note", "list", "table", "chart", "clock", "meter"];

const REQUESTS = {
  kit: { system: KIT_RULES, ask: "Show me the time in Tokyo.", max_tokens: 4000, ext: "json" },
  small: { system: THING_RULES, ask: "A clock that runs backwards.", max_tokens: 16000, ext: "html" },
  complex: {
    system: THING_RULES,
    ask: "Help me understand orbits. A planet circling a star that I can play with: let me change the planet's speed and see the orbit change shape, with a trail behind it.",
    max_tokens: 16000,
    ext: "html",
  },
};

const client = new Anthropic({ maxRetries: 1 });

function unfence(text) {
  const m = /^\s*```[\w-]*\n([\s\S]*?)\n```\s*$/.exec(text);
  return (m ? m[1] : text).trim();
}

async function make(model, task) {
  const req = REQUESTS[task];
  const started = performance.now();
  let firstText = null;
  let text = "";
  const stream = client.messages.stream({
    model,
    max_tokens: req.max_tokens,
    system: req.system,
    // Thinking is left at each model's default (adaptive); effort sets its depth.
    output_config: { effort: EFFORT },
    messages: [{ role: "user", content: req.ask }],
  });
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      if (firstText === null) firstText = performance.now();
      text += event.delta.text;
    }
  }
  const message = await stream.finalMessage();
  const seconds = (performance.now() - started) / 1000;
  const u = message.usage;
  const [inPrice, outPrice] = PRICES[model] ?? [0, 0];
  const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) * 1.25 + (u.cache_read_input_tokens ?? 0) * 0.1;
  const cost = (input * inPrice + (u.output_tokens ?? 0) * outPrice) / 1e6;

  const body = unfence(text);
  let note = "";
  if (message.stop_reason === "refusal") note = `refused (${message.stop_details?.category ?? "no category"})`;
  else if (message.stop_reason === "max_tokens") note = "cut off at the token limit";
  else if (task === "kit") {
    try {
      const value = JSON.parse(body);
      if (!KIT_PARTS.includes(value.part)) note = `unknown part ${JSON.stringify(value.part)}`;
    } catch {
      note = "not valid JSON";
    }
  } else {
    if (!body.includes("woody.ready")) note = "never calls woody.ready()";
    if (/\b(src|href)\s*=\s*["']https?:/i.test(body)) note = `${note ? `${note}; ` : ""}refers to the network`;
  }

  const file = `${model.replace("claude-", "")}-${task}.${req.ext}`;
  fs.writeFileSync(path.join(OUT, req.ext === "html" ? "made" : ".", req.ext === "html" ? file : `kit-${file}`), `${body}\n`);
  return {
    model,
    task,
    effort: EFFORT,
    file,
    seconds: Number(seconds.toFixed(1)),
    first_text_s: firstText === null ? null : Number(((firstText - started) / 1000).toFixed(1)),
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    chars: body.length,
    cost_usd: Number(cost.toFixed(4)),
    stop_reason: message.stop_reason,
    ok: note === "",
    note,
  };
}

const runs = [];
for (const task of TASKS) {
  for (const model of MODELS) {
    process.stdout.write(`${task.padEnd(8)} ${model.padEnd(20)} `);
    try {
      const run = await make(model, task);
      runs.push(run);
      console.log(`${String(run.seconds).padStart(6)} s  (first text ${run.first_text_s ?? "-"} s)  ${String(run.output_tokens).padStart(6)} tokens out  $${run.cost_usd.toFixed(4)}  ${run.ok ? "ok" : run.note}`);
    } catch (err) {
      // Most specific first: a wrong key or an unknown model should stop the
      // whole run; a busy moment or a network blip only loses one line.
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        console.log(`\nThe API refused the key (${err.status}). Nothing more was sent.`);
        process.exit(1);
      } else if (err instanceof Anthropic.NotFoundError) {
        console.log("model not available to this key");
        runs.push({ model, task, effort: EFFORT, ok: false, note: "model not available" });
      } else if (err instanceof Anthropic.RateLimitError) {
        console.log("rate limited; skipped");
        runs.push({ model, task, effort: EFFORT, ok: false, note: "rate limited" });
      } else if (err instanceof Anthropic.APIConnectionError) {
        console.log("connection failed; skipped");
        runs.push({ model, task, effort: EFFORT, ok: false, note: "connection failed" });
      } else if (err instanceof Anthropic.APIError) {
        console.log(`API error ${err.status}: ${String(err.message).slice(0, 120)}`);
        runs.push({ model, task, effort: EFFORT, ok: false, note: `API error ${err.status}` });
      } else {
        throw err;
      }
    }
  }
}

const total = runs.reduce((a, r) => a + (r.cost_usd ?? 0), 0);
fs.writeFileSync(path.join(OUT, "bench.json"), JSON.stringify({ at: new Date().toISOString(), effort: EFFORT, total_usd: Number(total.toFixed(4)), runs }, null, 2));

console.log("\n================ MAKING BENCHMARK ================");
console.log(`effort ${EFFORT} · total spent $${total.toFixed(4)}`);
console.log(`${"task".padEnd(8)} ${"model".padEnd(20)} ${"seconds".padStart(7)} ${"1st text".padStart(8)} ${"out tok".padStart(7)} ${"cost".padStart(8)}  result`);
for (const r of runs) {
  console.log(`${r.task.padEnd(8)} ${r.model.padEnd(20)} ${String(r.seconds ?? "-").padStart(7)} ${String(r.first_text_s ?? "-").padStart(8)} ${String(r.output_tokens ?? "-").padStart(7)} ${r.cost_usd !== undefined ? `$${r.cost_usd.toFixed(4)}` : "-".padStart(8)}  ${r.ok ? "ok" : r.note}`);
}
console.log("==================================================");
console.log(`Saved: ${path.join(OUT, "bench.json")} and ${path.join(OUT, "made")}`);
