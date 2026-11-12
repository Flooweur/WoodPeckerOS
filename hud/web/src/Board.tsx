// Plain views of Woody's mind: what needs you (inbox), the goals board, and
// the journal. The proper design comes with the full HUD (Phase 5).
import { useEffect, useState } from "react";

export type MindResult = { seq: number; op: string; ok: boolean; result?: any; error?: string };

type Review = {
  understanding: string;
  judgement: string;
  recommendation: "proceed" | "reconsider";
  plan: string[];
  estimate_usd: number;
  estimate_minutes: number;
  changes_system: boolean;
  questions: string[];
};
type Standing = { enabled: boolean; cadence_minutes: number; weekly_usd: number; week_spent_usd: number };
type Goal = {
  id: number;
  title: string;
  description: string;
  reasoning: string;
  owner: "operator" | "woody";
  status: string;
  review: Review | null;
  accepted: boolean;
  auto_started: boolean;
  budget_usd: number;
  spent_usd: number;
  dossier: string;
  next_step: string;
  waiting_reason: string;
  outcome: string;
  standing: Standing | null;
};
type ThreadItem = { kind: string; text?: string; name?: string; ts?: number };
type Journal = { id: number; ts: number; wake: string; did: string; outcome: string; next: string; summary: string };
type InboxItem = { kind: "plan" | "blocked" | "proposal"; goal: Goal };
type IdentityProposal = { id: number; ts: number; text: string; reason: string };
type Identity = { current: { version: number; text: string }; pending: IdentityProposal[] };

export type Tab = "inbox" | "goals" | "journal";

const STATUS_LABEL: Record<string, string> = {
  inbox: "to be reviewed",
  review: "plan awaits you",
  ready: "ready",
  active: "active",
  waiting: "waiting on you",
  done: "done",
  dropped: "dropped",
  proposed: "proposed by Woody",
  standing: "standing",
};
const INBOX_LABEL: Record<InboxItem["kind"], string> = {
  plan: "Plan to accept",
  blocked: "Needs your answer",
  proposal: "Woody proposes",
};

const when = (ts: number) => new Date(ts).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
const money = (n: number) => `$${n.toFixed(2)}`;

export function Board({
  tab,
  setTab,
  onClose,
  tx,
  incoming,
  version,
  approvals,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  onClose: () => void;
  tx: (message: Record<string, unknown>) => void;
  incoming: MindResult | null;
  /** Bumped whenever the agent says the board changed. */
  version: number;
  approvals: number;
}) {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [smallLimit, setSmallLimit] = useState(1);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [journal, setJournal] = useState<Journal[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [detail, setDetail] = useState<{ goal: Goal; messages: ThreadItem[] } | null>(null);
  const [error, setError] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [reply, setReply] = useState("");
  const [showClosed, setShowClosed] = useState(false);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [showIdentity, setShowIdentity] = useState(false);
  const [brief, setBrief] = useState<{ time: string; enabled: boolean } | null>(null);

  const mind = (op: string, extra: Record<string, unknown> = {}) => tx({ type: "mind", op, ...extra });

  // Load what the current view shows, and again whenever the board changes.
  useEffect(() => {
    mind("inbox");
    mind("identity");
    if (tab === "inbox") mind("brief");
    if (tab === "goals") mind("goals", { all: showClosed });
    if (tab === "journal") mind("journal", { n: 40 });
    if (open !== null) mind("goal", { id: open });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, version, open, showClosed]);

  useEffect(() => {
    if (!incoming) return;
    if (!incoming.ok) {
      setError(incoming.error ?? "The request failed.");
      return;
    }
    setError("");
    switch (incoming.op) {
      case "goals":
        setGoals(incoming.result.goals);
        setSmallLimit(incoming.result.small_goal_usd);
        break;
      case "inbox":
        setInbox(incoming.result);
        break;
      case "journal":
        setJournal([...incoming.result].reverse());
        break;
      case "goal":
        setDetail(incoming.result);
        break;
      case "identity":
      case "identity_decide":
        setIdentity(incoming.result);
        break;
      case "brief":
        setBrief(incoming.result);
        break;
      case "goal_add":
        setTitle("");
        setDescription("");
        break;
      case "small_goal_limit":
        setSmallLimit(incoming.result.small_goal_usd);
        break;
    }
  }, [incoming]);

  const act = (op: string, id: number, extra: Record<string, unknown> = {}) => mind(op, { id, ...extra });

  const goalView = detail && open === detail.goal.id ? detail : null;

  return (
    <aside className="board" aria-label="Woody's mind">
      <header>
        <nav>
          <button className={tab === "inbox" ? "on" : "ghost"} onClick={() => { setOpen(null); setShowIdentity(false); setTab("inbox"); }}>
            inbox{inbox.length + approvals + (identity?.pending.length ?? 0) > 0 ? ` (${inbox.length + approvals + (identity?.pending.length ?? 0)})` : ""}
          </button>
          <button className={tab === "goals" ? "on" : "ghost"} onClick={() => { setOpen(null); setTab("goals"); }}>
            goals
          </button>
          <button className={tab === "journal" ? "on" : "ghost"} onClick={() => { setOpen(null); setTab("journal"); }}>
            journal
          </button>
        </nav>
        <button className="ghost" onClick={onClose}>
          close
        </button>
      </header>

      {error && <div className="row error">{error}</div>}

      <div className="board-body">
        {showIdentity && identity ? (
          <div className="goal-detail">
            <button className="ghost" onClick={() => setShowIdentity(false)}>
              ← back
            </button>
            <h3>Who Woody is</h3>
            <p className="dim small">Version {identity.current.version}. This text describes Woody's character; it cannot change its rules.</p>
            <pre>{identity.current.text}</pre>
            {identity.pending.map((p) => (
              <div key={p.id}>
                <h4>Woody proposes this instead</h4>
                <pre>{p.text}</pre>
                <h4>Its reason</h4>
                <p className="pre">{p.reason}</p>
                <div className="actions left">
                  <button onClick={() => mind("identity_decide", { id: p.id, approve: true })}>approve</button>
                  <button className="danger" onClick={() => mind("identity_decide", { id: p.id, approve: false })}>
                    reject
                  </button>
                </div>
              </div>
            ))}
            {identity.pending.length === 0 && <p className="dim small">No change is proposed.</p>}
          </div>
        ) : goalView ? (
          <GoalDetail
            goal={goalView.goal}
            messages={goalView.messages}
            reply={reply}
            setReply={setReply}
            onBack={() => setOpen(null)}
            act={act}
          />
        ) : tab === "inbox" ? (
          <>
            {approvals > 0 && <p className="dim">{approvals} action(s) await your approval (shown as a prompt).</p>}
            {inbox.length === 0 && approvals === 0 && !identity?.pending.length && <p className="dim">Nothing needs you.</p>}
            {(identity?.pending ?? []).map((p) => (
              <button key={`id${p.id}`} className="card" onClick={() => setShowIdentity(true)}>
                <em className="alert-text">Woody proposes a change to who it is</em>
                <strong>Identity change #{p.id}</strong>
                <span>{p.reason}</span>
              </button>
            ))}
            {inbox.map((item) => (
              <button key={item.goal.id} className="card" onClick={() => setOpen(item.goal.id)}>
                <em className={item.kind === "blocked" ? "alert-text" : ""}>{INBOX_LABEL[item.kind]}</em>
                <strong>
                  #{item.goal.id} {item.goal.title}
                </strong>
                <span>
                  {item.kind === "plan" && item.goal.review
                    ? `${money(item.goal.review.estimate_usd)}, ${item.goal.review.estimate_minutes} min, ${item.goal.review.changes_system ? "changes the system" : "read-only"}`
                    : item.kind === "blocked"
                      ? item.goal.waiting_reason
                      : item.goal.reasoning}
                </span>
              </button>
            ))}
            <p className="dim small board-foot">
              <button className="ghost" onClick={() => setShowIdentity(true)}>
                who Woody is
              </button>{" "}
              {brief && (
                <>
                  <label>
                    <input type="checkbox" checked={brief.enabled} onChange={(e) => mind("brief", { enabled: e.target.checked })} /> daily brief at{" "}
                  </label>
                  <input
                    className="inline-number"
                    type="time"
                    value={brief.time}
                    onChange={(e) => {
                      if (/^\d\d:\d\d$/.test(e.target.value)) mind("brief", { time: e.target.value });
                    }}
                  />{" "}
                  <button className="ghost" onClick={() => mind("brief", { now: true })}>
                    brief me now
                  </button>
                </>
              )}
            </p>
          </>
        ) : tab === "goals" ? (
          <>
            <form
              className="add-goal"
              onSubmit={(e) => {
                e.preventDefault();
                if (title.trim().length >= 3) mind("goal_add", { title, description });
              }}
            >
              <input value={title} placeholder="A new goal for Woody" maxLength={140} onChange={(e) => setTitle(e.target.value)} />
              <textarea value={description} placeholder="Details (optional): what you want, why, any limits" rows={3} onChange={(e) => setDescription(e.target.value)} />
              <button disabled={title.trim().length < 3}>add goal</button>
            </form>
            <p className="dim small">
              Woody reviews each goal. A read-only plan estimated under{" "}
              <input
                className="inline-number"
                type="number"
                min={0}
                max={100}
                step={0.25}
                value={smallLimit}
                onChange={(e) => {
                  const usd = Number(e.target.value);
                  setSmallLimit(usd);
                  if (usd >= 0 && usd <= 100) mind("small_goal_limit", { usd });
                }}
              />{" "}
              dollars starts by itself; anything else waits for you to accept the plan.
            </p>
            {goals.length === 0 && <p className="dim">No goals yet.</p>}
            {goals.map((g) => (
              <div key={g.id} className={`card goal ${g.status}`}>
                <button className="card-main" onClick={() => setOpen(g.id)}>
                  <em>{STATUS_LABEL[g.status] ?? g.status}{g.standing && !g.standing.enabled ? " (off)" : ""}</em>
                  <strong>
                    #{g.id} {g.title}
                  </strong>
                  <span>
                    {g.standing
                      ? `${money(g.standing.week_spent_usd)} of ${money(g.standing.weekly_usd)} this week`
                      : g.budget_usd > 0
                        ? `${money(g.spent_usd)} of ${money(g.budget_usd)}`
                        : ""}
                    {g.next_step ? ` · next: ${g.next_step}` : ""}
                  </span>
                </button>
                {!g.standing && g.status !== "done" && g.status !== "dropped" && (
                  <div className="card-side">
                    <button className="ghost" title="Higher priority" onClick={() => act("goal_move", g.id, { where: "up" })}>
                      ↑
                    </button>
                    <button className="ghost" title="Lower priority" onClick={() => act("goal_move", g.id, { where: "down" })}>
                      ↓
                    </button>
                  </div>
                )}
              </div>
            ))}
            <label className="dim small">
              <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> show finished and dropped goals
            </label>
          </>
        ) : (
          <>
            {journal.length === 0 && <p className="dim">The journal is empty.</p>}
            {journal.map((j) => (
              <div key={j.id} className="card static">
                <em>{when(j.ts)}</em>
                <span>{j.summary || `${j.wake} ${j.did} ${j.outcome}`}</span>
                {j.next && <span className="dim">Next: {j.next}</span>}
              </div>
            ))}
          </>
        )}
      </div>
    </aside>
  );
}

function GoalDetail({
  goal,
  messages,
  reply,
  setReply,
  onBack,
  act,
}: {
  goal: Goal;
  messages: ThreadItem[];
  reply: string;
  setReply: (s: string) => void;
  onBack: () => void;
  act: (op: string, id: number, extra?: Record<string, unknown>) => void;
}) {
  const r = goal.review;
  const closed = goal.status === "done" || goal.status === "dropped";
  const retryReview = goal.status === "waiting" && !goal.accepted && !r;
  const canAccept =
    goal.status === "proposed" || (goal.status === "review" && r && r.questions.length === 0) || (goal.status === "waiting" && goal.accepted) || retryReview;
  const acceptLabel =
    goal.status === "proposed" ? "accept the idea" : goal.status === "review" ? "accept the plan" : retryReview ? "try the review again" : "let it continue";

  return (
    <div className="goal-detail">
      <button className="ghost" onClick={onBack}>
        ← back
      </button>
      <h3>
        #{goal.id} {goal.title}
      </h3>
      <p className="dim small">
        {STATUS_LABEL[goal.status] ?? goal.status} · written by {goal.owner === "operator" ? "you" : "Woody"}
        {goal.auto_started && " · started by itself (observe-only)"}
        {goal.accepted && !goal.auto_started && " · plan accepted by you"}
      </p>
      {goal.description && <p className="pre">{goal.description}</p>}
      {goal.reasoning && (
        <>
          <h4>Why Woody proposes it</h4>
          <p className="pre">{goal.reasoning}</p>
        </>
      )}
      {goal.waiting_reason && <p className="alert-text pre">{goal.waiting_reason}</p>}

      {r && (
        <>
          <h4>Woody's review</h4>
          <p className="pre">{r.understanding}</p>
          <p className={r.recommendation === "reconsider" ? "alert-text pre" : "pre"}>
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
            <span className={r.changes_system ? "alert-text" : ""}>{r.changes_system ? "changes the system" : "read-only"}</span>
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
        <div className="actions left">
          <button onClick={() => act("standing", goal.id, { enabled: !goal.standing!.enabled })}>{goal.standing.enabled ? "turn off" : "turn on"}</button>
          <span className="dim small">
            every {Math.round(goal.standing.cadence_minutes / 60)} h · {money(goal.standing.weekly_usd)} a week
          </span>
        </div>
      ) : (
        !closed && (
          <div className="actions left">
            {canAccept && <button onClick={() => act("goal_accept", goal.id)}>{acceptLabel}</button>}
            <button className="danger" onClick={() => act("goal_drop", goal.id)}>
              {goal.status === "proposed" ? "reject" : "drop"}
            </button>
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
      {messages.length === 0 && <p className="dim small">Nothing said yet.</p>}
      {messages.map((m, i) =>
        m.kind === "tool" ? (
          <p key={i} className="dim small">
            used {String(m.name).replace("mcp__woody__", "")}
          </p>
        ) : m.kind === "user" || m.kind === "assistant" ? (
          <p key={i} className={`pre ${m.kind === "user" ? "strong" : ""}`}>
            <span className="dim small">{m.kind === "user" ? "you" : "woody"} </span>
            {m.text}
          </p>
        ) : (
          <p key={i} className="dim small">
            {m.text}
          </p>
        ),
      )}
      {!closed && (
        <form
          className="add-goal"
          onSubmit={(e) => {
            e.preventDefault();
            if (!reply.trim()) return;
            act("goal_message", goal.id, { text: reply.trim() });
            setReply("");
          }}
        >
          <textarea value={reply} placeholder="Write to Woody about this goal" rows={3} onChange={(e) => setReply(e.target.value)} />
          <button disabled={!reply.trim()}>send</button>
        </form>
      )}
    </div>
  );
}
