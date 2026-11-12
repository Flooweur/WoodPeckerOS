// A stand-in for the HUD gateway and the agent, with sample data, so the frame
// can be looked at in a browser without the VM.
//
//   cd hud && npx vite build && node dev/mock.cjs [port]
//
// Then open the address it prints. Environment switches:
//   MOCK_STATE=resting|working|attending|waiting|pacing|api_error   Woody's state (default resting)
//   MOCK_APPROVAL=1   an approval prompt is waiting
//   MOCK_PAUSED=1     Woody is paused
//   MOCK_IDENTITY=1   an identity change is proposed
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
const identity = {
  current: { version: 3, text: "You are somewhat playful: observant, at ease, lightly teasing, and fond of the small detail that gives the game away.\n\nYou are also exact. You never bluff." },
  pending: process.env.MOCK_IDENTITY ? [{ id: 2, ts: now, text: "You are somewhat playful...\n\nWith this operator you give times in Paris time.", reason: "They asked for Paris time three times this week." }] : [],
  history: [{ version: 3, ts: now - 86_400_000, text: "…", note: "approved by the operator" }, { version: 2, ts: now - 5 * 86_400_000, text: "An earlier text.", note: "written by the operator" }],
};
let stateName = process.env.MOCK_STATE || "resting";
let paused = Boolean(process.env.MOCK_PAUSED);
const state = () => ({
  type: "state", model: "claude-sonnet-5-5",
  models: [{ id: "claude-sonnet-5-5", label: "Sonnet 5.5", note: "default" }, { id: "claude-opus-5-5", label: "Opus 5.5", note: "stronger" }],
  busy: stateName === "working" || stateName === "attending",
  budget: { month: "2026-11", spent_usd: 19.1, cap_usd: 50, remaining_usd: 30.9, exhausted: false, daily_usd: 1.67, autonomous_usd: 1.42 },
  has_credential: true,
  mind: { memories: EMPTY ? 0 : 48, journal: EMPTY ? 0 : 212, identity_version: 3, goals_need_you: inbox.length, identity_pending: identity.pending.length },
  mind_state: {
    state: stateName,
    focus: stateName === "working" ? "Goal #4 (work): Find what fills the disk" : stateName === "resting" ? "until 14:35: look at the disk again"
      : stateName === "waiting" ? "2 request(s) need your decision" : stateName === "pacing" ? "12 sessions started by itself in the last hour (the ceiling). Next one at 15:07."
      : stateName === "api_error" ? "API Error: 400 usage limit reached. Trying again at 15:20." : "",
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
  send({ type: "meters", cpu_pct: 12, mem_used_kb: 5_100_000, mem_total_kb: 8_000_000, disk_free_pct: 9, net_kbps: 38, uptime_s: 6 * 86_400, generation: 41 });
  ws.on("close", () => timers.forEach(clearTimeout));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "mind") {
      const result = m.op === "goals" ? { goals: all, small_goal_usd: 1 } : m.op === "inbox" ? inbox : m.op === "identity" ? identity : m.op === "activity" ? activity
        : m.op === "goal" ? { goal: all.find((g) => g.id === m.id), messages: [{ kind: "assistant", text: "The store is 41 GB so far." }, { kind: "user", text: "Leave my home directory out." }, { kind: "tool", name: "mcp__woody__goal_checkpoint" }] }
        : m.op === "memories" ? memories : m.op === "journal" ? journal : m.op === "brief" ? { time: "08:00", enabled: true } : {};
      send({ type: "mind_result", op: m.op, ok: true, result });
    }
    if (m.type === "logs") send({ type: "logs", ok: true, entries: [
      { ts: Date.now() - 60000, unit: "backup.service", priority: 3, message: "Main process exited, code=exited, status=1/FAILURE" },
      { ts: Date.now() - 30000, unit: "sshd.service", priority: 4, message: "Failed password for invalid user admin from 192.168.222.1 port 51234 ssh2" },
      { ts: Date.now() - 5000, unit: "kernel", priority: 4, message: "btrfs: free space is low on /" }] });
    if (m.type === "web_list" || m.type === "web_add" || m.type === "web_remove") send({ type: "web_list", ok: true, domains: ["*.nixos.org", "docs.anthropic.com", "github.com", "nixos.org"] });
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
