// The records whose data the frame itself holds: what needs you, the goals,
// the activity, Woody and the machine, the conversation. The other records
// ask the agent or the gateway for their own data (Panels.tsx and the files
// beside it).
import type { MutableRefObject, RefObject } from "react";
import type { MindStateName } from "./Lattice";
import type { Panel } from "./Panels";
import { Bar, GOAL_WORD, INNER, MarkIcon, Meter, STATE_LABEL, TalkRow, goalMark } from "./parts";
import type { ActivityRow, AgentState, Approval, Goal, InboxItem, Item, Meters } from "./types";
import { clock, money, until, usd } from "./types";

type Open = (panel: Panel) => void;

/** What waits for the operator: approvals, plans to accept, questions, goals Woody proposed. */
export function NeedsRecord({ approvals, inbox, openRecord }: { approvals: Approval[]; inbox: InboxItem[]; openRecord: Open }) {
  const needs = approvals.length + inbox.length;
  return (
  <div className="stack wide">
    {needs === 0 && <p className="dim">Nothing needs you.</p>}
    {approvals.map((a) => (
      <div key={a.approval_id} className="entry static">
        <MarkIcon mark="problem" />
        <span className="entry-text">
          <span className="one">approve or deny: {a.action}</span>
          <span className="two">shown as a prompt</span>
        </span>
      </div>
    ))}
    {inbox.map((item) => (
      <button key={item.goal.id} className="entry" onClick={() => openRecord({ kind: "goal", id: item.goal.id })}>
        <MarkIcon mark={item.kind === "plan" ? "saved" : "said"} tone="red" />
        <span className="entry-text">
          <span className="one">
            {String(item.goal.id).padStart(2, "0")} {item.goal.title}
          </span>
          <span className="two">
            {item.kind === "plan" && item.goal.review
              ? `plan to accept · ${money(item.goal.review.estimate_usd)} · ${item.goal.review.changes_system ? "changes the system" : "read-only"}`
              : item.kind === "blocked"
                ? item.goal.waiting_reason
                : `Woody proposes · ${item.goal.reasoning}`}
          </span>
        </span>
      </button>
    ))}
  </div>
  );
}

/** The goals board and the standing duties. */
export function GoalsRecord({ open, duties, smallLimit, now, openRecord }: { open: Goal[]; duties: Goal[]; smallLimit: number; now: number; openRecord: Open }) {
  return (
  <div className="stack wide">
    <div className="row-actions">
      <button className="primary" onClick={() => openRecord({ kind: "new-goal" })}>
        + new goal
      </button>
      <span className="dim small">Your order is the priority. A read-only plan under {money(smallLimit)} starts by itself.</span>
    </div>
    <h4>Goals</h4>
    {open.length === 0 && <p className="dim">No goals yet. Give Woody something to work towards.</p>}
    {open.map((g) => (
      <button key={g.id} className="entry goal" onClick={() => openRecord({ kind: "goal", id: g.id })}>
        <span className={`goal-mark ${goalMark(g)}`} role="img" aria-label={g.status} />
        <span className="num">{String(g.id).padStart(2, "0")}</span>
        <span className="entry-text">
          <span className="one">{g.title}</span>
          <Bar fraction={g.budget_usd > 0 ? g.spent_usd / g.budget_usd : 0} small />
        </span>
        <span className="side">
          <span className={goalMark(g) === "half" ? "word alert" : g.status === "active" ? "word amber" : "word"}>{GOAL_WORD[g.status] ?? g.status}</span>
          <span className="dim">
            {g.budget_usd > 0 ? `${money(g.spent_usd)}/${g.budget_usd.toFixed(2)}` : g.review ? `est. ${money(g.review.estimate_usd)}` : ""}
          </span>
        </span>
      </button>
    ))}
    <h4>Standing duties · next run · share of the week's budget used</h4>
    {duties.map((d) => {
      const s = d.standing!;
      const due = d.last_worked + s.cadence_minutes * 60_000;
      return (
        <button key={d.id} className={`entry duty ${s.enabled ? "" : "off"}`} onClick={() => openRecord({ kind: "goal", id: d.id })}>
          <span className="one">{d.title}</span>
          <span className="when">{!s.enabled ? "off" : due <= now ? "due" : until(due, now).replace("in ", "")}</span>
          <span className="when">{s.enabled && s.weekly_usd > 0 ? `${Math.round((s.week_spent_usd / s.weekly_usd) * 100)} %` : ""}</span>
        </button>
      );
    })}
  </div>
  );
}

export function ActivityRecord({ activity }: { activity: ActivityRow[] }) {
  return (
  <div className="stack wide">
    {activity.length === 0 && <p className="dim">Nothing yet.</p>}
    {activity.map((a, i) => (
      <div key={`${a.ts}-${i}`} className="act">
        <span className="dim">{new Date(a.ts).toLocaleTimeString(undefined, { hourCycle: "h23" })}</span>
        <MarkIcon mark={a.mark} tone={a.text.startsWith("you") ? "amber" : "dim"} size={10} />
        <span className="one">{a.text}</span>
      </div>
    ))}
  </div>
  );
}

/** Woody's state, its allowance, how it is and why, and the machine's readings. */
export function MachineRecord(p: {
  state: AgentState | null;
  mindName: MindStateName;
  alertState: boolean;
  sub: string;
  trouble: string;
  busy: boolean;
  session: { steps: number; cost: number | null };
  meters: Meters;
  now: number;
  link: string;
  agentUp: boolean;
  executorUp: boolean;
}) {
  const { state, mindName, alertState, sub, trouble, busy, session, meters, now, link, agentUp, executorUp } = p;
  const mind = state?.mind_state;
  const budget = state?.budget;
  const memUsed = meters.mem_used_kb !== undefined && meters.mem_total_kb ? meters.mem_used_kb / meters.mem_total_kb : undefined;
  const diskUsed = meters.disk_free_pct !== undefined ? 1 - meters.disk_free_pct / 100 : undefined;
  const failed = mind?.failed_units ?? [];
  return (
  <div className="stack wide">
    <h4>Woody</h4>
    <div className="readouts">
      <div className="readout">
        <div className="label">STATE</div>
        <div className={`value ${alertState ? "problem" : ""}`}>{STATE_LABEL[mindName]}</div>
        <div className="note">{sub || trouble || (mind ? `since ${clock(mind.since)}` : "")}</div>
      </div>
      <div className="readout">
        <div className="label">NEXT ALARM</div>
        <div className="value">{mind?.next_alarm ? clock(mind.next_alarm.due) : "none"}</div>
        <div className="note">{mind?.next_alarm ? `${until(mind.next_alarm.due, now)} · ${mind.next_alarm.reason}` : "nothing scheduled"}</div>
      </div>
      <div className="readout">
        <div className="label">QUEUE</div>
        <div className="value">{String((mind?.queue.operator ?? 0) + (mind?.queue.autonomous ?? 0)).padStart(2, "0")}</div>
        <div className="note">
          {mind?.queue.operator ?? 0} from you · {mind?.queue.autonomous ?? 0} its own
        </div>
      </div>
      <div className="readout">
        <div className="label">ALLOWANCE</div>
        <div className="value">
          {budget ? money(budget.autonomous_usd ?? 0) : "…"} <span className="unit">free today</span>
        </div>
        {budget && <Bar fraction={budget.cap_usd > 0 ? budget.spent_usd / budget.cap_usd : 0} tone={budget.spent_usd / budget.cap_usd > 0.85 ? "red" : "amber"} small />}
        <div className="note">
          {budget ? `${money(budget.spent_usd)} of $${budget.cap_usd} this month${budget.own ? ` · Woody's own: ${money(budget.own.spent_usd)} of ${money(budget.own.share_usd)}` : ""}` : ""}
        </div>
      </div>
    </div>
    <div className="readouts">
      <div className="readout">
        <div className="label">MODEL</div>
        <div className="value">{state?.models.find((m) => m.id === state.model)?.label ?? "–"}</div>
      </div>
      <div className="readout">
        <div className="label">STEP</div>
        <div className="value">{busy ? `${String(session.steps).padStart(2, "0")}/40` : "–"}</div>
      </div>
      <div className="readout">
        <div className="label">COST OF THIS SESSION</div>
        <div className="value">{session.cost === null ? "–" : usd(session.cost)}</div>
      </div>
      <div className="readout">
        <div className="label">MODE</div>
        <div className="value">{mind?.tainted ? "notes only" : mind?.mode ?? "–"}</div>
      </div>
    </div>
    {state?.inner && (
      <>
        <h4>How Woody is, and why</h4>
        <div className="inner">
          {INNER.map(([key, name]) => {
            const f = state.inner![key];
            return (
              <div key={key} className="inner-row">
                <span className="dim">{name}</span>
                <Bar fraction={f.value} tone={key === "unease" && f.value > 0.66 ? "red" : "amber"} />
                <span>{f.word}</span>
                <span className="dim small">{f.causes.map((c) => c.text).join(" · ") || "nothing in particular"}</span>
              </div>
            );
          })}
        </div>
        <p className="dim small">Computed from the record of what happened. Woody does not choose it, and can tell you these same causes if you ask.</p>
      </>
    )}
    <h4>
      The machine
      {meters.generation ? ` · generation ${meters.generation}` : ""}
      {meters.uptime_s ? ` · up ${meters.uptime_s > 172_800 ? `${Math.floor(meters.uptime_s / 86_400)} d` : `${Math.floor(meters.uptime_s / 3600)} h`}` : ""}
    </h4>
    <div className="meters">
      <Meter label="CPU" fraction={meters.cpu_pct !== undefined ? meters.cpu_pct / 100 : undefined} value={meters.cpu_pct !== undefined ? `${meters.cpu_pct} %` : "–"} />
      <Meter
        label="MEM"
        fraction={memUsed}
        value={meters.mem_used_kb !== undefined ? `${(meters.mem_used_kb / 1_048_576).toFixed(1)} GB` : "–"}
        alert={memUsed !== undefined && memUsed > 0.9}
      />
      <Meter
        label="DISK"
        fraction={diskUsed}
        value={meters.disk_free_pct !== undefined ? `${meters.disk_free_pct.toFixed(0)} % free` : "–"}
        alert={meters.disk_free_pct !== undefined && meters.disk_free_pct < 10}
      />
      <Meter label="NET" fraction={meters.net_kbps !== undefined ? Math.min(1, meters.net_kbps / 1024) : undefined} value={meters.net_kbps !== undefined ? `${meters.net_kbps} kB/s` : "–"} />
    </div>
    <p className={failed.length ? "problem" : "dim"}>
      {failed.length ? `${failed.length} failed: ${failed.join(", ")}` : "No failed services."}
    </p>
    <h4>Services</h4>
    <p className="links-row">
      <span className={link === "open" ? "up" : "down"}>HUD gateway</span>
      <span className={agentUp ? "up" : "down"}>agent</span>
      <span className={executorUp ? "up" : "down"}>executor</span>
    </p>
  </div>
  );
}

/** The conversation, with everything Woody did in it. */
export function TalkRecord({ items, busy, mindName, scroller, stick }: { items: Item[]; busy: boolean; mindName: MindStateName; scroller: RefObject<HTMLDivElement | null>; stick: MutableRefObject<boolean> }) {
  return (
  <>
    <div
      className="talk"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {items.length === 0 && <div className="line dim empty">Nothing has been said yet. Type anywhere to write to Woody.</div>}
      {items.map((it) => (
        <TalkRow key={it.key} item={it} />
      ))}
      {busy && <div className="line dim working">{mindName === "working" ? "working on its own…" : "working…"}</div>}
    </div>
    <div className="legend">
      <span><MarkIcon mark="said" size={9} /> said</span>
      <span><MarkIcon mark="tool" size={9} /> tool</span>
      <span><MarkIcon mark="woke" size={9} /> woke</span>
      <span><MarkIcon mark="saved" size={9} /> saved</span>
      <span><MarkIcon mark="problem" size={9} /> problem</span>
    </div>
  </>
  );
}
