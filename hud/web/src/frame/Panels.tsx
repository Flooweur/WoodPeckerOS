// The records: the views that open below the lattice. Some are drawn here
// (one goal, a new goal, the journal, memory, who Woody is, the logs, the web
// list, the terminal, the settings); the others are handed in by the frame,
// which holds their data (what needs you, the conversation, the goals, the
// activity, the machine).
import { useEffect, useState } from "react";
import type { AgentState, GatewayResult, Goal, Identity, JournalEntry, LogEntry, Memory, MindResult, Send } from "./types";
import { TOOL_PREFIX, day, money, until } from "./types";

export type Panel =
  | { kind: "goal"; id: number }
  | { kind: "new-goal" }
  | { kind: "journal" }
  | { kind: "memory" }
  | { kind: "identity" }
  | { kind: "settings" }
  | { kind: "logs" }
  | { kind: "web" }
  | { kind: "terminal" }
  | { kind: "needs" }
  | { kind: "talk" }
  | { kind: "goals" }
  | { kind: "activity" }
  | { kind: "machine" };

const STATUS: Record<string, string> = {
  inbox: "to be reviewed",
  review: "plan awaits you",
  ready: "ready",
  active: "active",
  waiting: "waiting on you",
  done: "done",
  dropped: "dropped",
  proposed: "proposed by Woody",
  standing: "standing duty",
};
const ORIGIN: Record<string, string> = { user: "you said so", observed: "Woody observed it", inferred: "Woody inferred it", web: "from the web" };

type ThreadItem = { kind: string; text?: string; name?: string; ts?: number };

export function PanelView({
  panel,
  setPanel,
  tx,
  incoming,
  gateway,
  door,
  version,
  state,
  identity,
  smallLimit,
  expressions,
  setExpressions,
  children,
}: {
  panel: Panel;
  setPanel: (p: Panel | null) => void;
  tx: Send;
  incoming: MindResult | null;
  gateway: GatewayResult | null;
  door: { kiosk: boolean; terminal: boolean };
  /** Bumped whenever the agent says something changed. */
  version: number;
  state: AgentState | null;
  identity: Identity | null;
  smallLimit: number;
  expressions: boolean;
  setExpressions: (on: boolean) => void;
  /** The body of a record the frame draws itself. */
  children?: React.ReactNode;
}) {
  const mind = (op: string, extra: Record<string, unknown> = {}) => tx({ type: "mind", op, ...extra });
  const [error, setError] = useState("");
  useEffect(() => {
    if (incoming && !incoming.ok) setError(incoming.error ?? "The request failed.");
    else if (incoming) setError("");
  }, [incoming]);

  const title =
    panel.kind === "goal" ? `GOAL ${String(panel.id).padStart(2, "0")}`
    : panel.kind === "new-goal" ? "NEW GOAL"
    : panel.kind === "journal" ? "JOURNAL"
    : panel.kind === "memory" ? "MEMORY"
    : panel.kind === "identity" ? "WHO WOODY IS"
    : panel.kind === "logs" ? "SYSTEM LOG"
    : panel.kind === "web" ? "WEB ALLOW-LIST"
    : panel.kind === "terminal" ? "TERMINAL"
    : panel.kind === "needs" ? "NEEDS YOU"
    : panel.kind === "talk" ? "CONVERSATION"
    : panel.kind === "goals" ? "GOALS AND DUTIES"
    : panel.kind === "activity" ? "ACTIVITY"
    : panel.kind === "machine" ? "WOODY AND THE MACHINE"
    : "SETTINGS";
  // The conversation scrolls by itself, like the terminal: it gets no padded body.
  const bare = panel.kind === "terminal" || panel.kind === "talk";

  return (
    <section className="panel overlay" aria-label={title}>
      <header className="panel-head">
        <span className="tab">{title}</span>
        <span className="leader" />
        <button className="ghost" onClick={() => setPanel(null)}>
          {panel.kind === "terminal" ? "close" : "close · esc"}
        </button>
      </header>
      {error && <div className="line problem">{error}</div>}
      {panel.kind === "terminal" && <Terminal available={door.terminal} />}
      {panel.kind === "talk" && children}
      <div className="overlay-body" hidden={bare}>
        {!bare && children}
        {panel.kind === "logs" && <Logs tx={tx} gateway={gateway} />}
        {panel.kind === "web" && <WebList tx={tx} gateway={gateway} />}
        {panel.kind === "goal" && <GoalDetail id={panel.id} mind={mind} incoming={incoming} version={version} />}
        {panel.kind === "new-goal" && <NewGoal mind={mind} incoming={incoming} smallLimit={smallLimit} onDone={(id) => setPanel({ kind: "goal", id })} />}
        {panel.kind === "journal" && <Journal mind={mind} incoming={incoming} version={version} />}
        {panel.kind === "memory" && <MemoryView mind={mind} incoming={incoming} version={version} />}
        {panel.kind === "identity" && <IdentityView mind={mind} identity={identity} />}
        {panel.kind === "settings" && (
          <Settings mind={mind} tx={tx} incoming={incoming} state={state} smallLimit={smallLimit} expressions={expressions} setExpressions={setExpressions} />
        )}
      </div>
    </section>
  );
}

type MindFn = (op: string, extra?: Record<string, unknown>) => void;

/** The system journal, read by the gateway. Woody has its own, narrower way to search it. */
function Logs({ tx, gateway }: { tx: Send; gateway: GatewayResult | null }) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [unit, setUnit] = useState("");
  const [priority, setPriority] = useState("4");
  const [follow, setFollow] = useState(true);
  const [error, setError] = useState("");
  const load = () => tx({ type: "logs", lines: 200, unit: unit.trim() || undefined, priority: priority === "all" ? undefined : Number(priority) });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [priority]);
  useEffect(() => {
    if (!follow) return;
    const id = window.setInterval(load, 5000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [follow, unit, priority]);
  useEffect(() => {
    if (gateway?.type !== "logs") return;
    setError(gateway.ok ? "" : gateway.error ?? "The journal could not be read.");
    if (gateway.ok) setEntries([...gateway.entries].reverse());
  }, [gateway]);
  return (
    <div className="stack wide">
      <form className="search three" onSubmit={(e) => { e.preventDefault(); load(); }}>
        <label className="small dim" htmlFor="log-unit">One unit (for example sshd.service), or empty for all</label>
        <input id="log-unit" value={unit} onChange={(e) => setUnit(e.target.value)} />
        <select aria-label="Severity" value={priority} onChange={(e) => setPriority(e.target.value)}>
          <option value="3">errors</option>
          <option value="4">warnings and errors</option>
          <option value="all">everything</option>
        </select>
        <button>refresh</button>
      </form>
      <label className="small dim">
        <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> refresh every five seconds
      </label>
      {error && <p className="problem">{error}</p>}
      {entries.length === 0 && !error && <p className="dim">Nothing at this severity.</p>}
      <div className="log">
        {entries.map((e, i) => (
          <div key={`${e.ts}-${i}`} className={e.priority <= 3 ? "problem" : e.priority === 4 ? "warn" : ""}>
            <span className="dim">{new Date(e.ts).toLocaleTimeString(undefined, { hourCycle: "h23" })}</span>
            <span className="unit">{e.unit}</span>
            <span className="msg">{e.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The sites Woody may read. The list is yours: Woody can only ask to add one. */
function WebList({ tx, gateway }: { tx: Send; gateway: GatewayResult | null }) {
  const [domains, setDomains] = useState<string[] | null>(null);
  const [adding, setAdding] = useState("");
  const [error, setError] = useState("");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => tx({ type: "web_list" }), []);
  useEffect(() => {
    if (gateway?.type !== "web_list") return;
    setError(gateway.ok ? "" : gateway.error ?? "The list could not be changed.");
    if (gateway.domains) setDomains(gateway.domains);
  }, [gateway]);
  return (
    <div className="stack">
      <p className="dim small">
        Woody can fetch https pages only from these sites. An entry starting with *. covers every subdomain. Web search is separate and can return any site,
        but opening a result still needs its site to be here.
      </p>
      <form
        className="search"
        onSubmit={(e) => {
          e.preventDefault();
          if (adding.trim()) tx({ type: "web_add", domain: adding.trim().toLowerCase() });
          setAdding("");
        }}
      >
        <label className="small dim" htmlFor="web-add">Add a site (example.org, or *.example.org)</label>
        <input id="web-add" value={adding} onChange={(e) => setAdding(e.target.value)} />
        <button disabled={!adding.trim()}>add</button>
      </form>
      {error && <p className="problem">{error}</p>}
      {domains === null ? <p className="dim">Loading…</p> : domains.length === 0 ? <p className="dim">The list is empty: Woody cannot read any site.</p> : null}
      {(domains ?? []).map((d) => (
        <div key={d} className="record inline">
          <span>{d}</span>
          <button className="ghost mini" onClick={() => tx({ type: "web_remove", domain: d })}>remove</button>
        </div>
      ))}
    </div>
  );
}

/**
 * A real shell on the VM, as you. It exists only on the VM's own screen, asks
 * for your password, and while it is open Woody cannot take screenshots.
 */
function Terminal({ available }: { available: boolean }) {
  if (!available) return <p className="line problem">The terminal is only available on the VM's own screen.</p>;
  let token = "";
  try {
    token = sessionStorage.getItem("woody-token") ?? "";
  } catch {
    /* no token: the frame will be refused */
  }
  return (
    <>
      <p className="line small dim">
        A shell on this machine, as you: sign in with your own password. It is not shown to Woody, and screenshots are off while it is open.
      </p>
      <iframe className="terminal" title="Terminal" src={`/term/?t=${token}`} />
    </>
  );
}

function GoalDetail({ id, mind, incoming, version }: { id: number; mind: MindFn; incoming: MindResult | null; version: number }) {
  const [detail, setDetail] = useState<{ goal: Goal; messages: ThreadItem[] } | null>(null);
  const [reply, setReply] = useState("");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => mind("goal", { id }), [id, version]);
  useEffect(() => {
    if (incoming?.ok && incoming.op === "goal" && incoming.result?.goal?.id === id) setDetail(incoming.result);
  }, [incoming, id]);
  if (!detail || detail.goal.id !== id) return <p className="dim">Loading…</p>;

  const goal = detail.goal;
  const r = goal.review;
  const closed = goal.status === "done" || goal.status === "dropped";
  const retry = goal.status === "waiting" && !goal.accepted && !r;
  const canAccept =
    goal.status === "proposed" || (goal.status === "review" && r && r.questions.length === 0) || (goal.status === "waiting" && goal.accepted) || retry;
  const acceptLabel =
    goal.status === "proposed" ? "accept the idea" : goal.status === "review" ? "accept the plan" : retry ? "try the review again" : "let it continue";
  const act = (op: string, extra: Record<string, unknown> = {}) => mind(op, { id, ...extra });

  return (
    <div className="stack">
      <h3>{goal.title}</h3>
      <p className="dim small">
        {STATUS[goal.status] ?? goal.status} · written by {goal.owner === "operator" ? "you" : "Woody"}
        {goal.auto_started && " · started by itself, observe-only"}
        {goal.accepted && !goal.auto_started && " · plan accepted by you"}
      </p>
      {goal.description && <p className="pre">{goal.description}</p>}
      {goal.reasoning && (
        <>
          <h4>Why Woody proposes it</h4>
          <p className="pre">{goal.reasoning}</p>
        </>
      )}
      {goal.waiting_reason && <p className="pre problem">{goal.waiting_reason}</p>}

      {r && (
        <>
          <h4>Woody's review</h4>
          <p className="pre">{r.understanding}</p>
          <p className={r.recommendation === "reconsider" ? "pre problem" : "pre"}>
            {r.recommendation === "reconsider" ? "Woody advises against: " : ""}
            {r.judgement}
          </p>
          {r.plan.length > 0 && (
            <ol>
              {r.plan.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          )}
          <p className="dim small">
            Estimate {money(r.estimate_usd)}, {r.estimate_minutes} min ·{" "}
            <span className={r.changes_system ? "problem" : ""}>{r.changes_system ? "changes the system" : "read-only"}</span>
          </p>
          {r.questions.length > 0 && (
            <>
              <h4>Woody's questions</h4>
              <ul>
                {r.questions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      {goal.standing ? (
        <div className="row-actions">
          <button onClick={() => act("standing", { enabled: !goal.standing!.enabled })}>{goal.standing.enabled ? "turn off" : "turn on"}</button>
          <span className="dim small">
            every {Math.round(goal.standing.cadence_minutes / 60)} h · {money(goal.standing.week_spent_usd)} of {money(goal.standing.weekly_usd)} this week
          </span>
        </div>
      ) : (
        !closed && (
          <div className="row-actions">
            {canAccept && <button className="primary" onClick={() => act("goal_accept")}>{acceptLabel}</button>}
            <button className="ghost" onClick={() => act("goal_move", { where: "up" })}>priority up</button>
            <button className="ghost" onClick={() => act("goal_move", { where: "down" })}>priority down</button>
            <button className="danger" onClick={() => act("goal_drop")}>{goal.status === "proposed" ? "reject" : "drop"}</button>
          </div>
        )
      )}

      {(goal.dossier || goal.next_step) && (
        <>
          <h4>Where it stands</h4>
          {goal.dossier && <pre>{goal.dossier}</pre>}
          {goal.next_step && <p className="small">Next: {goal.next_step}</p>}
        </>
      )}
      {goal.outcome && (
        <>
          <h4>Outcome</h4>
          <p className="pre">{goal.outcome}</p>
        </>
      )}
      {!goal.standing && goal.budget_usd > 0 && (
        <p className="dim small">
          Spent {money(goal.spent_usd)} of {money(goal.budget_usd)}
        </p>
      )}

      <h4>Thread</h4>
      {detail.messages.length === 0 && <p className="dim small">Nothing said yet.</p>}
      {detail.messages.map((m, i) =>
        m.kind === "tool" ? (
          <p key={i} className="dim small">
            used {String(m.name).replace(TOOL_PREFIX, "")}
          </p>
        ) : m.kind === "user" || m.kind === "assistant" ? (
          <p key={i} className={`pre ${m.kind === "user" ? "you" : ""}`}>
            <span className="who">{m.kind === "user" ? "YOU" : "WOODY"} </span>
            {m.text}
          </p>
        ) : (
          <p key={i} className={`small ${m.kind === "error" ? "problem" : "dim"}`}>
            {m.text}
          </p>
        ),
      )}
      {!closed && (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!reply.trim()) return;
            act("goal_message", { text: reply.trim() });
            setReply("");
          }}
        >
          <label className="small dim" htmlFor="goal-reply">Write to Woody about this goal</label>
          <textarea id="goal-reply" value={reply} rows={3} onChange={(e) => setReply(e.target.value)} />
          <button disabled={!reply.trim()}>send</button>
        </form>
      )}
    </div>
  );
}

function NewGoal({ mind, incoming, smallLimit, onDone }: { mind: MindFn; incoming: MindResult | null; smallLimit: number; onDone: (id: number) => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  useEffect(() => {
    if (incoming?.ok && incoming.op === "goal_add") onDone(incoming.result.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming]);
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim().length >= 3) mind("goal_add", { title, description });
      }}
    >
      <label className="small dim" htmlFor="goal-title">What do you want done?</label>
      <input id="goal-title" value={title} maxLength={140} autoFocus onChange={(e) => setTitle(e.target.value)} />
      <label className="small dim" htmlFor="goal-desc">Details (optional): why, any limits, what done looks like</label>
      <textarea id="goal-desc" value={description} rows={6} onChange={(e) => setDescription(e.target.value)} />
      <button className="primary" disabled={title.trim().length < 3}>add goal</button>
      <p className="dim small">
        Woody reviews it first. A read-only plan estimated under {money(smallLimit)} starts by itself; anything else waits for you to accept the plan.
      </p>
    </form>
  );
}

function Journal({ mind, incoming, version }: { mind: MindFn; incoming: MindResult | null; version: number }) {
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [query, setQuery] = useState("");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => mind("journal", { n: 60, query }), [version]);
  useEffect(() => {
    if (incoming?.ok && incoming.op === "journal") setEntries(query ? incoming.result : [...incoming.result].reverse());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming]);
  return (
    <div className="stack">
      <form className="search" onSubmit={(e) => { e.preventDefault(); mind("journal", { n: 60, query }); }}>
        <label className="small dim" htmlFor="journal-q">Search the journal</label>
        <input id="journal-q" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button>search</button>
      </form>
      {entries.length === 0 && <p className="dim">Nothing found.</p>}
      {entries.map((j) => (
        <div key={j.id} className="record">
          <span className="dim small">{day(j.ts)}</span>
          <span className="pre">{j.summary || `${j.wake} ${j.did} ${j.outcome}`}</span>
          {j.next && <span className="dim small">Next: {j.next}</span>}
        </div>
      ))}
    </div>
  );
}

function MemoryView({ mind, incoming, version }: { mind: MindFn; incoming: MindResult | null; version: number }) {
  const [items, setItems] = useState<Memory[]>([]);
  const [query, setQuery] = useState("");
  const [all, setAll] = useState(false);
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const [adding, setAdding] = useState("");
  const load = () => mind("memories", { query, all });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [version, all]);
  useEffect(() => {
    if (!incoming?.ok) return;
    if (incoming.op === "memories") setItems(incoming.result);
    if (["pin", "unpin", "forget", "correct", "add"].includes(incoming.op)) {
      setEditing(null);
      load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming]);

  return (
    <div className="stack">
      <form className="search" onSubmit={(e) => { e.preventDefault(); load(); }}>
        <label className="small dim" htmlFor="memory-q">Search what Woody remembers</label>
        <input id="memory-q" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button>search</button>
      </form>
      <label className="small dim">
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> also show memories that were later corrected
      </label>
      <form
        className="search"
        onSubmit={(e) => {
          e.preventDefault();
          if (adding.trim()) mind("add", { statement: adding.trim() });
          setAdding("");
        }}
      >
        <label className="small dim" htmlFor="memory-add">Tell Woody something to remember</label>
        <input id="memory-add" value={adding} onChange={(e) => setAdding(e.target.value)} />
        <button disabled={!adding.trim()}>add</button>
      </form>
      {items.length === 0 && <p className="dim">Nothing found.</p>}
      {items.map((m) => (
        <div key={m.id} className={`record ${m.superseded_by ? "old" : ""}`}>
          <span className="dim small">
            #{m.id} · {m.kind}
            {m.subject ? ` · ${m.subject}` : ""} · <span className={m.origin === "web" ? "problem" : ""}>{ORIGIN[m.origin] ?? m.origin}</span> ·{" "}
            {new Date(m.confirmed).toLocaleDateString()}
            {m.pinned ? " · pinned" : ""}
            {m.superseded_by ? ` · replaced by #${m.superseded_by}` : ""}
          </span>
          {editing?.id === m.id ? (
            <form
              className="search"
              onSubmit={(e) => {
                e.preventDefault();
                if (editing.text.trim()) mind("correct", { id: m.id, statement: editing.text.trim() });
              }}
            >
              <label className="small dim" htmlFor={`fix-${m.id}`}>Corrected statement (the old one is kept as replaced)</label>
              <input id={`fix-${m.id}`} value={editing.text} autoFocus onChange={(e) => setEditing({ id: m.id, text: e.target.value })} />
              <button>save</button>
            </form>
          ) : (
            <span className="pre">{m.statement}</span>
          )}
          {!m.superseded_by && editing?.id !== m.id && (
            <span className="row-actions">
              <button className="ghost" onClick={() => mind(m.pinned ? "unpin" : "pin", { id: m.id })}>{m.pinned ? "unpin" : "pin"}</button>
              <button className="ghost" onClick={() => setEditing({ id: m.id, text: m.statement })}>correct</button>
              <button className="danger" onClick={() => mind("forget", { id: m.id })}>forget</button>
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function IdentityView({ mind, identity }: { mind: MindFn; identity: Identity | null }) {
  if (!identity) return <p className="dim">Loading…</p>;
  return (
    <div className="stack">
      <p className="dim small">Version {identity.current.version}. This text describes Woody's character. It cannot change its rules.</p>
      <pre>{identity.current.text}</pre>
      {identity.pending.length === 0 && <p className="dim small">No change is proposed.</p>}
      {identity.pending.map((p) => (
        <div key={p.id} className="stack">
          <h4>Woody proposes this instead</h4>
          <pre>{p.text}</pre>
          <h4>Its reason</h4>
          <p className="pre">{p.reason}</p>
          <div className="row-actions">
            <button className="primary" onClick={() => mind("identity_decide", { id: p.id, approve: true })}>approve</button>
            <button className="danger" onClick={() => mind("identity_decide", { id: p.id, approve: false })}>reject</button>
          </div>
        </div>
      ))}
      {(identity.history ?? []).length > 1 && (
        <>
          <h4>Earlier versions</h4>
          {(identity.history ?? []).slice(1).map((h) => (
            <details key={h.version} className="record">
              <summary className="small dim">
                version {h.version} · {day(h.ts)} · {h.note}
              </summary>
              <pre>{h.text}</pre>
            </details>
          ))}
        </>
      )}
    </div>
  );
}

function Settings({
  mind,
  tx,
  incoming,
  state,
  smallLimit,
  expressions,
  setExpressions,
}: {
  mind: MindFn;
  tx: Send;
  incoming: MindResult | null;
  state: AgentState | null;
  smallLimit: number;
  expressions: boolean;
  setExpressions: (on: boolean) => void;
}) {
  const [brief, setBrief] = useState<{ time: string; enabled: boolean } | null>(null);
  const [limit, setLimit] = useState(String(smallLimit));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => mind("brief"), []);
  useEffect(() => {
    if (incoming?.ok && incoming.op === "brief") setBrief(incoming.result);
  }, [incoming]);

  return (
    <div className="stack settings">
      <h4>Model</h4>
      <label className="small dim" htmlFor="set-model">Used from Woody's next session on</label>
      <select id="set-model" value={state?.model ?? ""} disabled={!state} onChange={(e) => tx({ type: "set_model", model: e.target.value })}>
        {(state?.models ?? []).map((m) => (
          <option key={m.id} value={m.id}>
            {m.label} ({m.note})
          </option>
        ))}
      </select>

      <h4>Goals</h4>
      <label className="small dim" htmlFor="set-limit">A read-only plan estimated under this many dollars starts by itself</label>
      <input
        id="set-limit"
        type="number"
        min={0}
        max={100}
        step={0.25}
        value={limit}
        onChange={(e) => {
          setLimit(e.target.value);
          const usdValue = Number(e.target.value);
          if (e.target.value !== "" && usdValue >= 0 && usdValue <= 100) mind("small_goal_limit", { usd: usdValue });
        }}
      />

      <h4>Daily brief</h4>
      {brief && (
        <>
          <label className="small">
            <input type="checkbox" checked={brief.enabled} onChange={(e) => mind("brief", { enabled: e.target.checked })} /> Woody writes a brief once a day
          </label>
          <label className="small dim" htmlFor="set-brief">At this time</label>
          <input id="set-brief" type="time" value={brief.time} onChange={(e) => /^\d\d:\d\d$/.test(e.target.value) && mind("brief", { time: e.target.value })} />
          <div className="row-actions">
            <button className="ghost" onClick={() => mind("brief", { now: true })}>brief me now</button>
            <button className="ghost" onClick={() => mind("reflect_now")}>reflect now</button>
          </div>
        </>
      )}

      <h4>The mind panel</h4>
      <label className="small">
        <input type="checkbox" checked={expressions} onChange={(e) => setExpressions(e.target.checked)} /> Show expressions (smile, wink, peck…). States and
        events are always shown.
      </label>

      <h4>Working context</h4>
      <p className="dim small">Clears what the model currently holds in mind. The conversation, journal and memory are kept, and Woody starts again from a recap.</p>
      <div className="row-actions">
        <button className="ghost" disabled={state?.busy} onClick={() => tx({ type: "new_session" })}>clear working context</button>
      </div>
    </div>
  );
}
