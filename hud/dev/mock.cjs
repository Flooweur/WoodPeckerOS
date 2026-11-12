// A stand-in for the HUD gateway and the agent, with sample data, so the frame
// can be looked at in a browser without the VM.
//
//   cd hud && npx vite build && node dev/mock.cjs [port]
//
// Then open the address it prints. Environment switches:
//   MOCK_STATE=resting|working|attending|waiting|pacing|api_error   Woody's state (default resting)
//   MOCK_APPROVAL=1   an approval prompt is waiting
//   MOCK_PAUSED=1     Woody is paused
//   MOCK_IDENTITY=1   Woody changed its identity and you have not looked yet
//   MOCK_DRIFT=1      less than half of the first identity remains: its changes wait for you
//   MOCK_EMPTY=1      nothing was ever said, no goals: a first boot
const http = require("http");
const fs = require("fs");
const path = require("path");
const hud = path.join(__dirname, "..");
const port = Number(process.argv[2] || 7811);
const { WebSocketServer } = require(path.join(hud, "node_modules", "ws"));
const root = path.join(hud, "dist", "web");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const EMPTY = Boolean(process.env.MOCK_EMPTY);

const now = Date.now();
const min = 60_000;
const T = (m) => now - m * min;
const goal = (id, title, status, extra = {}) => ({
  id, title, description: "", reasoning: "", owner: "operator", status, review: null, accepted: false, auto_started: false,
  budget_usd: 0, spent_usd: 0, dossier: "", next_step: "", waiting_reason: "", outcome: "", last_worked: now - 30 * min, standing: null, ...extra,
});
const review = (o = {}) => ({
  understanding: "You want to know what fills the disk and what can safely go.",
  judgement: "Feasible and useful. Looking is read-only; removing anything needs your yes.",
  recommendation: "proceed", plan: ["Measure the largest directories", "List old snapshots and generations", "Write what could be removed, and what it frees"],
  estimate_usd: 0.4, estimate_minutes: 10, changes_system: false, questions: [], ...o,
});
const standing = (enabled, cadence, weekly, spent) => ({ enabled, cadence_minutes: cadence, weekly_usd: weekly, week_spent_usd: spent, week_start: now - 3 * 86_400_000 });
const goals = EMPTY ? [] : [
  goal(4, "Find what fills the disk", "active", { accepted: true, auto_started: true, budget_usd: 1, spent_usd: 0.27, review: review(), next_step: "list snapshots older than 30 days",
    description: "And tell me what can go.", dossier: "The Nix store is 41 GB, snapshots 18 GB.\nTwelve system generations are older than a month." }),
  goal(7, "Learn how tides work and show me", "ready", { accepted: true, budget_usd: 1.5, review: review({ estimate_usd: 1, understanding: "You want an explanation of tides you can play with." }) }),
  goal(6, "Install the ncdu package", "review", { review: review({ estimate_usd: 0.2, estimate_minutes: 5, changes_system: true, plan: ["Add ncdu to nix/modules/woody.nix", "Propose and apply the change"] }) }),
  goal(3, "Make the screen nicer", "waiting", { waiting_reason: "Woody has questions before it can plan.", review: review({ plan: [], questions: ["Nicer how: calmer, denser, or more playful?"] }) }),
  goal(9, "Rotate old snapshots weekly", "proposed", { owner: "woody", description: "Add a timer that prunes snapshots older than 30 days.", reasoning: "The disk is at 9 % free and snapshots are the largest part." }),
];
const duties = [
  goal(100, "Keep this machine healthy", "standing", { standing: standing(true, 360, 1.5, 0.6), last_worked: now - 230 * min }),
  goal(101, "Stay up to date", "standing", { standing: standing(true, 1440, 2, 0.35), last_worked: now - 300 * min }),
  goal(102, "Keep improving yourself", "standing", { standing: standing(true, 10080, 2, 0), last_worked: now - 2 * 86_400_000 }),
];
const all = [...goals, ...duties];
const inbox = EMPTY ? [] : [{ kind: "plan", goal: goals[2] }, { kind: "blocked", goal: goals[3] }, { kind: "proposal", goal: goals[4] }];
const ID1 = "You are somewhat playful: observant, at ease, lightly teasing, and fond of the small detail that gives the game away.\n\nYou are also exact. You never bluff.";
const ID2 = ID1 + "\n\nYou care about this machine as your own home.";
const ID3 = ID2.replace("lightly teasing, and fond", "lightly teasing, patient with half-formed ideas, and fond") + "\n\nWith this operator you give times in Paris time.";
let idHistory = [
  { version: 3, ts: now - 6 * 3_600_000, text: ID3, note: "changed by Woody after its reflection", author: "woody", reason: "They asked for Paris time three times this week, and twice thanked me for waiting while they thought aloud.", seen: !process.env.MOCK_IDENTITY },
  { version: 2, ts: now - 5 * 86_400_000, text: ID2, note: "written by the operator", author: "operator", reason: "", seen: true },
  { version: 1, ts: now - 20 * 86_400_000, text: ID1, note: "initial character", author: "initial", reason: "", seen: true },
];
let idFrozen = false;
let idDriftOk = false;
const idState = () => ({
  version: idHistory[0].version,
  remaining: process.env.MOCK_DRIFT ? 0.41 : 0.86,
  paused: Boolean(process.env.MOCK_DRIFT) && !idDriftOk,
  frozen: idFrozen,
  blocked: null,
  unseen: idHistory.filter((v) => !v.seen).map((v) => v.version),
});
const identityRecord = () => ({ current: { version: idHistory[0].version, text: idHistory[0].text }, pending: [], history: idHistory, anchor: idHistory[idHistory.length - 1], state: idState() });

// Woody's face: the built-in designs, two of which Woody redrew or invented.
const BUILTIN = [
  ["attending", "state", "while you answer the operator", "rings spreading from the centre"],
  ["working", "state", "while you work on something by yourself", "cells firing here and there, like thoughts"],
  ["resting", "state", "while nothing is asked of you", "four centre cells breathing"],
  ["sleeping", "state", "at night, while you sleep", "one low line breathing very slowly"],
  ["reflecting", "state", "during your daily reflection", "two halves breathing in turn"],
  ["woke", "moment", "a session starts", "a line in the middle opens like an eye"],
  ["message", "moment", "a message from the operator arrives", "a dot comes in from the side"],
  ["tool", "moment", "you call a tool", "one bright cell, somewhere different each time"],
  ["saved", "moment", "you stored a memory", "lit cells settle downwards"],
  ["done", "moment", "a session ended well", "a tick"],
  ["smile", "expression", "the operator comes back after a while", "a face with blinking eyes and a smile"],
  ["wink", "expression", "a goal was finished within its budget", "a smiling face, one eye winking"],
  ["yawn", "expression", "you start again after a long rest", "closed eyes and an open mouth"],
  ["peck", "expression", "you start work on a goal", "three quick taps of the whole field"],
  ["curious", "expression", "a goal needs the operator's answer", "eyes at different heights, a small mouth"],
  ["worried", "expression", "something is wrong on the machine", "a face with a wavering mouth"],
  ["sparkle", "expression", "the operator took up an idea of yours", "a star twinkling"],
  ["heart", "expression", "the operator thanked you", "a heart beating"],
  ["listening", "expression", "the operator is typing", "eyes turned to the side where they type"],
  ["asleep", "expression", "you are asleep", "closed eyes and two Zs"],
];
const RING = [
  ["........", "........", "........", "...22...", "...22...", "........", "........", "........"],
  ["........", "........", "..3553..", "..5..5..", "..5..5..", "..3553..", "........", "........"],
  ["........", ".279972.", ".7....7.", ".9....9.", ".9....9.", ".7....7.", ".279972.", "........"],
  ["........", "........", "..3553..", "..5..5..", "..5..5..", "..3553..", "........", "........"],
];
const SHRUG = [
  ["........", ".99..99.", "........", "........", "..9999..", "........", "........", "........"],
  ["........", ".99..99.", "........", "9......9", ".999999.", "........", "........", "........"],
  ["9......9", ".99..99.", "........", "9......9", ".999999.", "........", "........", "........"],
];
let faceVersion = EMPTY ? 0 : 2;
let ownFace = EMPTY ? {} : {
  resting: { design: { colour: "blue", fade: true, repeat: 1, frames: RING.map((rows) => ({ rows, ms: 1100 })) }, about: "", version: 1, ts: now - 3 * 86_400_000, reason: "The four centre cells read as a cursor. A ring that opens and closes reads as breathing." },
  shrug: { design: { colour: "green", fade: false, repeat: 2, frames: SHRUG.map((rows, i) => ({ rows, ms: i === 2 ? 700 : 260 })) }, about: "I do not know, and that is fine", version: 2, ts: now - 26 * 3_600_000, reason: "I had no way to show not knowing without looking worried." },
};
const faceRecord = () => ({
  version: faceVersion,
  designs: [
    ...BUILTIN.map(([name, kind, about, looks]) => ({ name, kind, about, builtin: true, looks, design: ownFace[name]?.design ?? null, version: ownFace[name]?.version ?? null, ts: ownFace[name]?.ts ?? null, reason: ownFace[name]?.reason ?? "" })),
    ...Object.entries(ownFace).filter(([name]) => !BUILTIN.some((b) => b[0] === name)).map(([name, f]) => ({ name, kind: "expression", about: f.about, builtin: false, looks: "", design: f.design, version: f.version, ts: f.ts, reason: f.reason })),
  ],
  history: Object.fromEntries(Object.entries(ownFace).map(([name, f]) => [name, [{ id: f.version, name, ts: f.ts, design: f.design, about: f.about, reason: f.reason, actor: "woody" }]])),
});
let stateName = process.env.MOCK_STATE || "resting";
let paused = Boolean(process.env.MOCK_PAUSED);
let ownTime = true;
const rhythm = { day: "07:00", night: "23:00" };
const limits = { uninvited_per_day: 3, uninvited_today: 1 };
let interests = EMPTY ? [] : [
  { id: 1, topic: "How woodpeckers avoid concussion", origin: "you joked about my name on the first day", source: "woody", status: "open", created: now - 6 * 86_400_000, last_followed: now - 26 * 3_600_000, followed: 3,
    notes: [{ ts: now - 3 * 86_400_000, text: "The hyoid bone wraps around the skull like a seat belt.", web: false }, { ts: now - 26 * 3_600_000, text: "A page claims the beak's two halves differ in length and spread the shock.", web: true }], dropped_reason: "" },
  { id: 2, topic: "Tide tables and how they are computed", origin: "you mentioned sailing at the weekend", source: "woody", status: "open", created: now - 2 * 86_400_000, last_followed: 0, followed: 0, notes: [], dropped_reason: "" },
  { id: 3, topic: "Btrfs snapshots", origin: "the operator suggested it", source: "operator", status: "open", created: now - 86_400_000, last_followed: now - 5 * 3_600_000, followed: 1,
    notes: [{ ts: now - 5 * 3_600_000, text: "Snapshots here are taken before every rebuild; 14 are kept.", web: false }], dropped_reason: "" },
  { id: 4, topic: "Paper sizes", origin: "a passing thought", source: "woody", status: "dropped", created: now - 9 * 86_400_000, last_followed: now - 8 * 86_400_000, followed: 1, notes: [], dropped_reason: "it went flat" },
];
const page = (url, title, h) => ({ url, title, ts: now - h * 3_600_000 });
let studies = EMPTY ? [] : [
  { id: 2, subject: "How tides work", why: "Learn about tides and show me.", owner: "operator", status: "reading", created: now - 5 * 3_600_000, updated: now - 40 * min, budget_usd: 1.5, spent_usd: 0.46, max_readings: 5, readings: 2,
    plan: "Why there are two bulges and not one, in terms a newcomer can follow.", thing_id: null, outcome: "",
    notes: [
      { id: 1, ts: now - 4 * 3_600_000, text: "Tides are raised mainly by the moon: its pull differs across the Earth, which stretches the oceans into two bulges, one facing the moon and one opposite.", sources: ["https://oceanservice.example/tides/basics"] },
      { id: 2, ts: now - 40 * min, text: "Spring tides come at new and full moon, when the sun and the moon pull along one line; neap tides at the quarters. Two pages agree; one popular page had it the wrong way round.", sources: ["https://oceanservice.example/tides/spring-neap", "https://encyclopedia.example/wiki/Tide"] },
    ],
    pages: [page("https://oceanservice.example/tides/basics", "What causes tides?", 4), page("https://oceanservice.example/tides/spring-neap", "Spring and neap tides", 1), page("https://encyclopedia.example/wiki/Tide", "Tide", 1)] },
  { id: 1, subject: "How woodpeckers avoid concussion", why: "My own curiosity, from a joke about my name.", owner: "woody", status: "done", created: now - 4 * 86_400_000, updated: now - 2 * 86_400_000, budget_usd: 0.5, spent_usd: 0.41, max_readings: 2, readings: 2,
    plan: "", thing_id: "t3", outcome: "It shows the hyoid bone wrapping the skull and lets you slow a peck down. How much the beak's shape matters stays disputed.",
    notes: [{ id: 3, ts: now - 3 * 86_400_000, text: "The hyoid bone wraps around the skull and acts like a seat belt at each strike.", sources: ["https://birds.example/woodpecker-skull"] }],
    pages: [page("https://birds.example/woodpecker-skull", "The woodpecker's skull", 72)] },
];
const lifeResult = () => ({
  ...state().life,
  next: "its last moment of its own was 48 minutes ago; the next is in about 72 minutes",
  budget: state().budget.own, session_usd: 0.4,
  today: EMPTY ? [] : [{ ts: now - 5 * 3_600_000, kind: "free", nothing: false, cost_usd: 0.21, left: [], interests: ["Btrfs snapshots"] }, { ts: now - 48 * min, kind: "free", nothing: true, cost_usd: 0.03, left: [], interests: [] }],
  interests,
  journal: EMPTY ? [] : [
    { id: 214, ts: now - 48 * min, wake: "I had time of my own.", did: "Answered without using tools.", outcome: "I chose to do nothing with it.", next: "", summary: "" },
    { id: 209, ts: now - 5 * 3_600_000, wake: "I had time of my own.", did: "", outcome: "", next: "", summary: "I looked at how snapshots are taken on this machine, since you suggested it, and wrote down what I found. I did not put anything on the canvas: a note was enough." },
    { id: 198, ts: now - 15 * 3_600_000, wake: "The day ended (2026-11-11).", did: "Looked back at what I did with my own time.", outcome: "I had 3 moments of my own today and used 2 of them. I followed \"How woodpeckers avoid concussion\". I put \"Hyoid sketch\" on the canvas. That cost $0.52 of my share.", next: "", summary: "" },
  ],
});
const state = () => ({
  type: "state", model: "claude-sonnet-5-5",
  models: [{ id: "claude-sonnet-5-5", label: "Sonnet 5.5", note: "default" }, { id: "claude-opus-5-5", label: "Opus 5.5", note: "stronger" }],
  busy: stateName === "working" || stateName === "attending",
  budget: { month: "2026-11", spent_usd: 38.2, cap_usd: 100, remaining_usd: 61.8, exhausted: false, daily_usd: 3.33, autonomous_usd: 1.42, own: { share_usd: 25, spent_usd: 6.4, available_usd: 0.62 } },
  life: { phase: stateName === "sleeping" ? "night" : "day", asleep: stateName === "sleeping", own_time: ownTime, day_start: rhythm.day, night_start: rhythm.night },
  has_credential: true,
  face: faceVersion,
  identity: (({ version, unseen, paused: far, remaining }) => ({ version, unseen, paused: far, remaining }))(idState()),
  inner: {
    at: Date.now(),
    energy: { value: 0.58, word: "steady", causes: [{ text: "7 work sessions in the last six hours", effect: -0.2 }, { text: "there is allowance to spare", effect: 0.12 }] },
    ease: { value: 0.74, word: "at ease", causes: [{ text: 'you pinned "Backwards clock"', effect: 0.1 }, { text: "recent work went through without trouble", effect: 0.08 }] },
    curiosity: { value: 0.52, word: "interested", causes: [{ text: "3 new things learned in the last two days", effect: 0.12 }] },
    attention: { value: 0.93, word: "with you", causes: [{ text: "you are here", effect: 0.85 }] },
    unease: { value: 0.25, word: "untroubled", causes: [{ text: "backup.service has failed", effect: 0.2 }] },
  },
  mind: { memories: EMPTY ? 0 : 48, journal: EMPTY ? 0 : 212, identity_version: idHistory[0].version, studies_open: studies.filter((s) => s.status === "reading" || s.status === "explaining").length, goals_need_you: inbox.length, identity_pending: 0 },
  mind_state: {
    state: stateName,
    focus: stateName === "working" ? "Goal #4 (work): Find what fills the disk" : stateName === "resting" ? "until 14:35: look at the disk again"
      : stateName === "waiting" ? "2 request(s) need your decision" : stateName === "pacing" ? "12 sessions started by itself in the last hour (the ceiling). Next one at 15:07."
      : stateName === "api_error" ? "API Error: 400 usage limit reached. Trying again at 15:20." : stateName === "sleeping" ? "until 07:00" : "",
    since: now - 4 * min, mode: stateName === "working" ? "full" : null, tainted: false, failed_units: EMPTY ? [] : ["backup.service"], paused,
    queue: { operator: 0, autonomous: EMPTY ? 0 : 2 }, next_alarm: EMPTY ? null : { id: 4, due: now + 31 * min, reason: "look at the disk again" }, waiting_on_operator: 0,
  },
});
const history = {
  type: "history", thread: 1, items: EMPTY ? [] : [
    { kind: "user", ts: T(60), text: "Find what fills the disk when you have a moment, and tell me what can go." },
    { kind: "assistant", ts: T(59), text: "On the board as goal 04. Looking is read-only and small, so I have started." },
    { kind: "meta", ts: T(59), text: "$0.021 · 3.4 s" },
    { kind: "meta", ts: T(8), text: "woke up: Your alarm #3 went off: continue goal #04" },
    { kind: "tool", ts: T(7), id: "t1", name: "mcp__woody__osquery", input: { sql: "select path, blocks_available from mounts" }, result: "4 rows", isError: false },
    { kind: "tool", ts: T(6), id: "t2", name: "mcp__woody__service_restart", input: { unit: "backup.service" }, result: "service.restart was refused (paused-by-operator)", isError: true },
    { kind: "assistant", ts: T(6), text: "The Nix store holds 41 GB and the snapshots 18 GB. Twelve system generations are older than a month; removing them would free about 9 GB. I have not removed anything." },
    { kind: "meta", ts: T(6), text: "$0.112 · 41.0 s" },
    { kind: "user", ts: T(4), text: "Good. Keep the last five generations." },
    { kind: "meta", ts: T(3), text: 'goal #7 "Learn how tides work and show me" is ready' },
  ],
};
const activity = EMPTY ? [] : [
  { ts: T(4), mark: "said", text: "you: Good. Keep the last five generations." },
  { ts: T(6), mark: "saved", text: "checkpoint goal #4 · active" },
  { ts: T(7), mark: "tool", text: "osquery" },
  { ts: T(8), mark: "woke", text: "Your alarm #3 went off: continue goal #04" },
  { ts: T(27), mark: "problem", text: "backup.service failed" },
  { ts: T(60), mark: "saved", text: "remembered #48 (preference, user)" },
  { ts: T(70), mark: "woke", text: "goal #100 (standing)" },
];
const memories = EMPTY ? [] : [
  { id: 48, kind: "preference", statement: "The operator wants the last five system generations kept.", subject: "machine", origin: "user", pinned: false, confirmed: now, supersedes: null, superseded_by: null, actor: "woody" },
  { id: 41, kind: "preference", statement: "The operator wants short answers that lead with the number.", subject: "style", origin: "user", pinned: true, confirmed: now - 86_400_000, supersedes: null, superseded_by: null, actor: "woody" },
  { id: 39, kind: "fact", statement: "NixOS 26.11 is planned for late November.", subject: "nixos", origin: "web", pinned: false, confirmed: now - 2 * 86_400_000, supersedes: null, superseded_by: null, actor: "woody" },
];
const journal = EMPTY ? [] : [
  { id: 212, ts: T(6), wake: "", did: "", outcome: "", next: "list snapshots older than 30 days", summary: "My alarm went off and I continued goal 04. The store and the snapshots fill most of the disk; I reported the numbers and removed nothing." },
  { id: 211, ts: T(70), wake: "", did: "", outcome: "", next: "", summary: "Health round. Disk is at 9 % free; I told the operator and proposed goal 09 to rotate snapshots." },
];
const approvals = process.env.MOCK_APPROVAL ? [{
  approval_id: "ab12cd34ef56ab78", action: "service.restart", params: { unit: "greetd.service" }, action_hash: "f".repeat(64), created_ms: now, expires_ms: now + 7 * 86_400_000,
}] : [];

const REPLIES = [
  "It is doing fine. The processor is quiet, memory is at two thirds, and the disk is the one thing to watch: 9 % free. I am already looking at what fills it.",
  "I can. Give me a moment and it will be on the canvas.\n\nUntil the canvas exists I can only tell you about it, which is a poor substitute for a clock.",
  "Noted.",
];
let replyIndex = 0;

const server = http.createServer((req, res) => {
  const rel = req.url.split("?")[0] === "/" ? "index.html" : req.url.split("?")[0].slice(1);
  fs.readFile(path.join(root, rel), (err, data) => {
    if (err) return res.writeHead(404).end("not found");
    res.writeHead(200, { "content-type": MIME[path.extname(rel)] || "application/octet-stream" }).end(data);
  });
});
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => {
  const send = (m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
  const sendApprovals = () => send({ type: "approvals", items: approvals, paused, executor_up: true });
  let timers = [];
  send({ type: "hello", kiosk: true, terminal: true });
  send({ type: "agent_up" });
  send(state());
  send(history);
  sendApprovals();
  send({ type: "canvas", things: [], undo: null, limits });
  send({ type: "meters", cpu_pct: 12, mem_used_kb: 5_100_000, mem_total_kb: 8_000_000, disk_free_pct: 9, net_kbps: 38, uptime_s: 6 * 86_400, generation: 41 });
  ws.on("close", () => timers.forEach(clearTimeout));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "canvas_op" && m.op === "set_limit") { limits.uninvited_per_day = m.n; send({ type: "canvas", things: [], undo: null, limits }); }
    if (m.type === "mind") {
      if (m.op === "own_time") { ownTime = Boolean(m.enabled); send(state()); }
      if (m.op === "rhythm") { rhythm.day = m.day_start; rhythm.night = m.night_start; send(state()); }
      if (m.op === "interest_drop") interests = interests.map((i) => (i.id === m.id ? { ...i, status: "dropped", dropped_reason: "removed by the operator" } : i));
      if (m.op === "interest_suggest") interests = [...interests, { id: interests.length + 1, topic: m.topic, origin: "the operator suggested it", source: "operator", status: "open", created: Date.now(), last_followed: 0, followed: 0, notes: [], dropped_reason: "" }];
      if (m.op === "identity_seen") { idHistory = idHistory.map((v) => ({ ...v, seen: true })); send(state()); }
      if (m.op === "identity_continue") { idDriftOk = true; send(state()); }
      if (m.op === "identity_freeze") idFrozen = Boolean(m.frozen);
      if (m.op === "identity_restore") {
        const old = idHistory.find((v) => v.version === m.id);
        if (old) idHistory = [{ version: idHistory[0].version + 1, ts: Date.now(), text: old.text, note: `version ${old.version} restored by the operator`, author: "operator", reason: "", seen: true }, ...idHistory.map((v) => ({ ...v, seen: true }))];
        send(state());
      }
      if (m.op === "face_restore") { delete ownFace[m.name]; faceVersion += 1; send(state()); }
      if (m.op === "study_add") studies = [{ id: studies.length + 1, subject: m.subject, why: "The operator asked for it from the studies record.", owner: "operator", status: "reading", created: Date.now(), updated: Date.now(), budget_usd: m.size === "small" ? 0.5 : m.size === "large" ? 4 : 1.5, spent_usd: 0, max_readings: m.size === "small" ? 2 : m.size === "large" ? 10 : 5, readings: 0, plan: "", thing_id: null, outcome: "", notes: [], pages: [] }, ...studies];
      if (m.op === "study_drop") studies = studies.map((s) => (s.id === m.id ? { ...s, status: "dropped", outcome: "Dropped by the operator." } : s));
      if (m.op === "study_size") studies = studies.map((s) => (s.id === m.id ? { ...s, budget_usd: m.budget_usd, max_readings: m.max_readings } : s));
      const result = String(m.op).startsWith("stud") ? { studies } : m.op === "face" || m.op === "face_restore" ? faceRecord() : String(m.op).startsWith("identity") ? identityRecord() : m.op === "life" ? lifeResult() : m.op === "goals" ? { goals: all, small_goal_usd: 1 } : m.op === "inbox" ? inbox : m.op === "activity" ? activity
        : m.op === "goal" ? { goal: all.find((g) => g.id === m.id), messages: [{ kind: "assistant", text: "The store is 41 GB so far." }, { kind: "user", text: "Leave my home directory out." }, { kind: "tool", name: "mcp__woody__goal_checkpoint" }] }
        : m.op === "memories" ? memories : m.op === "journal" ? journal : m.op === "brief" ? { time: "08:00", enabled: true } : {};
      send({ type: "mind_result", op: m.op, ok: true, result });
    }
    if (m.type === "logs") send({ type: "logs", ok: true, entries: [
      { ts: Date.now() - 60000, unit: "backup.service", priority: 3, message: "Main process exited, code=exited, status=1/FAILURE" },
      { ts: Date.now() - 30000, unit: "sshd.service", priority: 4, message: "Failed password for invalid user admin from 192.168.222.1 port 51234 ssh2" },
      { ts: Date.now() - 5000, unit: "kernel", priority: 4, message: "btrfs: free space is low on /" }] });
    if (m.type === "web_list" || m.type === "web_add" || m.type === "web_remove") send({ type: "web_list", ok: true, domains: ["*.tracker.example", "blocked.example"] });
    if (m.type === "play") send({ type: "moment", name: m.name });
    if (m.type === "pause") { paused = Boolean(m.on); sendApprovals(); send(state()); }
    if (m.type === "interrupt") {
      timers.forEach(clearTimeout); timers = [];
      stateName = "resting"; send({ type: "result", subtype: "interrupted", cost_usd: 0.004, thread: 1 }); send(state());
    }
    if (m.type === "chat") {
      // Woody answers: it attends, the reply streams in, then it rests.
      const text = REPLIES[replyIndex++ % REPLIES.length];
      send({ type: "user_text", text: m.text, thread: 1 });
      send({ type: "moment", name: /thank/i.test(m.text) ? "heart" : "smile" });
      stateName = "attending"; send(state());
      send({ type: "turn_start", source: "operator", thread: 1 });
      const words = text.split(/(?<= )/);
      words.forEach((w, i) => timers.push(setTimeout(() => send({ type: "assistant_delta", text: w, thread: 1 }), 900 + i * 60)));
      timers.push(setTimeout(() => {
        send({ type: "assistant_text", text, thread: 1 });
        send({ type: "result", subtype: "success", cost_usd: 0.018, duration_ms: 900 + words.length * 60, thread: 1 });
        stateName = "resting"; send(state());
      }, 1000 + words.length * 60));
    }
  });
});
server.listen(port, "127.0.0.1", () => console.log(`mock HUD on http://127.0.0.1:${port}/#t=${"a".repeat(64)}`));
