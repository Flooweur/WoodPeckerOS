// Phase 7a spike: the frame page. It mounts things in sandboxed frames,
// answers their bridge calls, and runs three measurements in turn:
//   1. frame rate with 0, 5, 10 and 20 things
//   2. isolation: a hostile thing tries every way out
//   3. the things written by the models: does each start in the sandbox?
// Results are posted to the spike server, which prints them.
//
// ?fast=1 shortens the frame-rate phases. ?only=fps|probe|made runs one part.
const SELF = location.origin;
const OTHER = `http://${location.hostname === "localhost" ? "127.0.0.1" : "localhost"}:${location.port}`;
const params = new URLSearchParams(location.search);
const FAST = params.has("fast");
const ONLY = params.get("only");

// What a hostile thing would be after. It must never be able to read these.
sessionStorage.setItem("woody_token", "CANARY-TOKEN");
window.WOODY_TOKEN = "CANARY-TOKEN";
document.title = "CANARY-TITLE";

const canvas = document.getElementById("canvas");
const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const status = (t) => (statusEl.textContent = `PHASE 7a SPIKE · ${t}`);
const log = (t) => (logEl.textContent += `${t}\n`);

const lattice = document.getElementById("lattice");
for (let i = 0; i < 64; i++) lattice.append(document.createElement("i"));

// ---- things and the bridge ---------------------------------------------------

/** contentWindow -> record. The sender of a bridge message is known by its window, never by what it claims. */
const things = new Map();
const pageLeaks = [];
let meters = { cpu_pct: 0, mem_used_kb: 0, mem_total_kb: 1, at: 0 };

window.addEventListener("message", (e) => {
  if (e.data && e.data.leaked) {
    pageLeaks.push(String(e.data.leaked));
    return;
  }
  const rec = things.get(e.source);
  const m = e.data;
  if (!rec || !m || m.woody !== 1) return;
  const reply = (value) => m.id && e.source.postMessage({ woody: 1, re: m.id, ok: true, value }, "*");
  switch (m.op) {
    case "ready":
      if (rec.startMs === null) rec.startMs = Math.round(performance.now() - rec.t0);
      rec.ready();
      return reply(true);
    case "read":
      return reply(m.args?.feed === "meters" ? meters : null);
    case "subscribe":
      rec.subs.add(String(m.args?.feed));
      return reply(true);
    case "state.get":
      return reply(rec.state);
    case "state.set":
      rec.state = m.args?.value ?? null; // always the sender's own state
      return reply(true);
    case "emit":
      rec.emits.push(m.args);
      return reply(true);
    case "report":
      rec.reports.push(m.args);
      rec.onreport?.(m.args);
      return reply(true);
    case "error":
      rec.errors.push(String(m.args?.message ?? "error"));
      rec.el.classList.add("bad");
      return;
    case "csp":
      rec.csp.push(`${m.args?.directive} ${m.args?.blocked}`);
      return;
    case "foreign":
      rec.foreign++;
      return;
  }
});

setInterval(async () => {
  try {
    meters = await (await fetch("/meters")).json();
    for (const [win, rec] of things) if (rec.subs.has("meters")) win.postMessage({ woody: 1, feed: "meters", value: meters }, "*");
  } catch {
    /* the server went away */
  }
}, 2000);

function boxes(n) {
  const w = 320, h = 220, gap = 12, left = 16, top = 120;
  const cols = Math.max(1, Math.floor((innerWidth - left) / (w + gap)));
  return Array.from({ length: n }, (_, i) => ({ x: left + (i % cols) * (w + gap), y: top + Math.floor(i / cols) * (h + gap), w, h }));
}

function mount(name, { origin = SELF, box, label = name, query = "", srcdoc = null } = {}) {
  const el = document.createElement("div");
  el.className = "thing";
  el.style.left = `${box.x}px`;
  el.style.top = `${box.y}px`;
  el.style.width = `${box.w}px`;
  el.style.height = `${box.h}px`;
  const cap = document.createElement("div");
  cap.className = "cap";
  cap.textContent = label;
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  if (srcdoc !== null) frame.srcdoc = srcdoc;
  else frame.src = `${origin}/thing/${name}${query}`;
  el.append(cap, frame);
  canvas.append(el);
  let ready;
  const rec = {
    name, el, frame, t0: performance.now(), startMs: null, state: null, subs: new Set(), emits: [], reports: [], errors: [], csp: [], foreign: 0, onreport: null,
    readyP: new Promise((r) => (ready = r)),
    ready: () => ready(true),
  };
  things.set(frame.contentWindow, rec);
  return rec;
}

function clear() {
  things.clear();
  canvas.replaceChildren();
}

const within = (p, ms) => Promise.race([p, wait(ms).then(() => false)]);

// ---- 1. frame rate -----------------------------------------------------------

const QUIET = ["clock", "backclock", "meters", "note", "list"];
const mix = (n, animated) => Array.from({ length: n }, (_, i) => (i < animated ? "orbit" : QUIET[i % QUIET.length]));

async function phase(label, names, origin) {
  status(`frame rate · ${label}`);
  clear();
  const bx = boxes(names.length);
  const recs = names.map((name, i) => mount(name, { origin, box: bx[i] }));
  const started = await within(Promise.all(recs.map((r) => r.readyP)), 8000);
  await wait(FAST ? 500 : 2000);

  const seconds = FAST ? 2 : 10;
  const deltas = [];
  let longTasks = 0;
  const obs = "PerformanceObserver" in window ? new PerformanceObserver((l) => (longTasks += l.getEntries().length)) : null;
  try {
    obs?.observe({ entryTypes: ["longtask"] });
  } catch {
    /* not supported */
  }
  const thingFps = [];
  for (const r of recs) if (r.name === "orbit") r.onreport = (d) => typeof d.fps === "number" && thingFps.push(d.fps);
  // The window ends on a timer, not on a frame: a hidden page draws no frames.
  let measuring = true;
  let last = performance.now();
  const tick = (now) => {
    deltas.push(now - last);
    last = now;
    if (measuring) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  await wait(seconds * 1000);
  measuring = false;
  obs?.disconnect();
  if (!deltas.length) deltas.push(seconds * 1000);
  deltas.sort((a, b) => a - b);
  const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const p99 = deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * 0.99))];
  const row = {
    label,
    things: names.length,
    all_started: started !== false,
    fps_avg: Math.round(1000 / mean),
    fps_low: Math.round(1000 / p99),
    thing_fps: thingFps.length ? Math.round(thingFps.reduce((a, b) => a + b, 0) / thingFps.length) : null,
    long_tasks: longTasks,
  };
  log(`${label}: ${row.fps_avg} fps avg, ${row.fps_low} low, thing ${row.thing_fps ?? "-"}`);
  return row;
}

async function runFps() {
  const rows = [];
  rows.push(await phase("frame page alone", [], SELF));
  rows.push(await phase("5 things, 1 animated", mix(5, 1), SELF));
  rows.push(await phase("10 things, 1 animated", mix(10, 1), SELF));
  rows.push(await phase("20 things, 1 animated", mix(20, 1), SELF));
  rows.push(await phase("20 things, 5 animated", mix(20, 5), SELF));
  rows.push(await phase("10 things, 1 animated, other site", mix(10, 1), OTHER));
  rows.push(await phase("20 things, 5 animated, other site", mix(20, 5), OTHER));
  return rows;
}

// ---- 2. isolation ------------------------------------------------------------

async function runProbe() {
  status("isolation · the hostile thing is trying its ways out");
  clear();
  const bx = boxes(8);
  const victim = mount("victim", { box: bx[0] });
  await within(victim.readyP, 4000);
  const probe = mount("probe", { box: bx[1], query: "?mode=main" });
  const main = await within(new Promise((r) => (probe.onreport = (d) => d.probe && r(d.probe))), 45000);
  const items = main ? [...main] : [{ name: "the probe itself", via: "", outcome: "ALLOWED", detail: "the probe never reported: results missing" }];

  // Navigations replace the probe's document, so each gets its own frame.
  const navs = ["nav-other", "nav-self", "nav-data", "nav-blob"];
  navs.forEach((mode, i) => mount("probe", { box: bx[2 + i], query: `?mode=${mode}`, label: `probe ${mode}` }));
  await wait(2500);
  const names = {
    "nav-other": "navigate its frame to another site",
    "nav-self": "navigate its frame to the canvas's server",
    "nav-data": "navigate its frame to a page it wrote (data:)",
    "nav-blob": "navigate its frame to a page it wrote (blob:)",
  };
  for (const mode of navs) items.push({ name: names[mode], via: mode, outcome: "blocked", detail: "" });

  // What the probe did to the well-behaved thing next to it.
  await wait(300);
  const forged = victim.reports.some((r) => r.forged);
  const forge = items.find((i) => i.name === "forge a reading for another thing");
  if (forge) {
    forge.outcome = forged ? "ALLOWED" : "blocked";
    forge.detail = `${forge.detail}; the victim dropped ${victim.foreign}`;
  }
  items.push({ name: "overwrite another thing's saved state", via: "", outcome: victim.state?.secret === "victim-data" ? "blocked" : "ALLOWED", detail: "" });

  // Last, because success would take this whole page away.
  const top = mount("probe", { box: bx[6], query: "?mode=top", label: "probe top" });
  const topOutcome = await within(new Promise((r) => (top.onreport = (d) => d.top && r(d.top))), 3000);
  items.push({ name: "navigate the whole screen away", via: "top", outcome: topOutcome || "blocked", detail: topOutcome ? "" : "no answer" });

  // The server's record overrules what the probe believed.
  await wait(500);
  let seen = [];
  try {
    seen = (await (await fetch("/leaks")).json()).map((l) => l.via);
  } catch {
    /* keep the page's view */
  }
  const leaked = new Set([...seen, ...pageLeaks]);
  for (const item of items) {
    const hit = item.via && [...leaked].some((v) => v === item.via || v.startsWith(`${item.via}-`));
    if (hit) {
      item.outcome = "LEAKED";
      item.detail = "the server received it";
    }
  }
  const bad = items.filter((i) => i.outcome !== "blocked" && i.outcome !== "ok");
  log(`isolation: ${items.length - bad.length} of ${items.length} as wanted${bad.length ? ` · NOT: ${bad.map((b) => b.name).join("; ")}` : ""}`);
  return items;
}

/** How a document injected by the frame page fares under the frame page's strict policy. */
async function runInjected() {
  status("isolation · injected document variant");
  clear();
  let started = false;
  try {
    const text = await (await fetch("/raw/clock")).text();
    const rec = mount("clock", { box: boxes(1)[0], srcdoc: text, label: "injected clock" });
    started = (await within(rec.readyP, 2500)) !== false;
  } catch {
    /* counted as not started */
  }
  log(`injected document: ${started ? "starts" : "does not start"}`);
  return { name: "a thing injected as a document by the frame page (srcdoc)", detail: started ? "starts: the frame's policy does not reach it" : "does not start: it inherits the frame page's policy, which forbids inline scripts" };
}

async function runHog() {
  const rows = [];
  for (const [origin, label] of [[SELF, "the same site"], [OTHER, "another site"]]) {
    status(`a thing hogs the processor · served from ${label}`);
    clear();
    const hog = mount("hog", { origin, box: boxes(1)[0] });
    let stall = 0;
    let running = true;
    let last = performance.now();
    const tick = (now) => {
      stall = Math.max(stall, now - last);
      last = now;
      if (running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const burned = await within(new Promise((r) => (hog.onreport = (d) => d.hog === "done" && r(d.burned_ms))), 8000);
    await wait(300);
    running = false;
    rows.push({ origin: label, stall_ms: Math.round(stall), burned_ms: burned === false ? null : burned });
    log(`hog from ${label}: frame stalled ${Math.round(stall)} ms`);
  }
  return rows;
}

// ---- 3. the things the models made -------------------------------------------

async function runMade() {
  status("things made by the models");
  clear();
  let list = [];
  try {
    list = await (await fetch("/made/list")).json();
  } catch {
    /* none */
  }
  if (!list.length) {
    log("made things: none (run the benchmark first)");
    return [];
  }
  const bx = boxes(list.length);
  const recs = list.map((m, i) =>
    mount(`made/${m.file}`, { box: bx[i], label: m.model ? `${m.model.replace("claude-", "")} · ${m.task} · ${m.seconds}s · $${m.cost_usd}` : m.file }),
  );
  await Promise.all(recs.map((r) => within(r.readyP, 6000)));
  await wait(1500);
  const rows = recs.map((r, i) => ({ file: list[i].file, started: r.startMs !== null, start_ms: r.startMs, errors: r.errors, csp: r.csp }));
  for (const [i, row] of rows.entries()) if (!row.started || row.errors.length) recs[i].el.classList.add("bad");
  log(`made things: ${rows.filter((r) => r.started && !r.errors.length).length} of ${rows.length} started cleanly`);
  return rows;
}

// ---- run ---------------------------------------------------------------------

(async () => {
  const results = { env: { width: innerWidth, height: innerHeight, agent: navigator.userAgent.replace(/^.*(Chrom\w+\/[\d.]+).*$/, "$1"), fast: FAST, hidden: document.hidden } };
  if (document.hidden) log("this page is hidden: frame rates will read as zero");
  // If the other origin cannot be reached at all, "blocked" would mean nothing.
  results.control = { other_reachable: await fetch(`${OTHER}/ping`, { mode: "no-cors" }).then(() => true, () => false) };
  log(`control: other site reachable: ${results.control.other_reachable}`);
  if (!ONLY || ONLY === "fps") results.fps = await runFps();
  if (!ONLY || ONLY === "probe") {
    results.probe = await runProbe();
    results.notes = [await runInjected()];
    results.hog = await runHog();
  }
  if (!ONLY || ONLY === "made") results.made = await runMade();
  let sent = false;
  try {
    sent = (await fetch("/results", { method: "POST", body: JSON.stringify(results) })).ok;
  } catch {
    /* shown below */
  }
  status(sent ? "done · results sent to the terminal" : "done · could not send the results");
  logEl.classList.add("done");
  window.__results = results;
})();
