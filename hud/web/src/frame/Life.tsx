// Woody's own life, as a record: its day and night, its share of the budget,
// what it is curious about and where each interest came from, and what it did
// with the time that was its own. The operator's handles are here too: turn
// its own time off, set the hours of its day, set how much it may add to the
// canvas unasked, suggest an interest or remove one.
import { useEffect, useState } from "react";
import type { CanvasState } from "../canvas/types";
import type { JournalEntry, Life, MindResult, Send } from "./types";
import { clock, day, money } from "./types";

const PHASE: Record<string, string> = { day: "DAY", evening: "EVENING", night: "NIGHT" };
const LIFE_OPS = ["interest_suggest", "interest_drop", "own_time", "rhythm"];

export function LifeRecord({ tx, incoming, version, canvas }: { tx: Send; incoming: MindResult | null; version: number; canvas: CanvasState }) {
  const [life, setLife] = useState<Life | null>(null);
  const [topic, setTopic] = useState("");
  const [hours, setHours] = useState({ day: "", night: "" });
  const [dropped, setDropped] = useState(false);
  const mind = (op: string, extra: Record<string, unknown> = {}) => tx({ type: "mind", op, ...extra });

  // Asked again whenever the agent says something changed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => mind("life"), [version]);
  useEffect(() => {
    if (!incoming?.ok) return;
    if (incoming.op === "life") {
      setLife(incoming.result);
      setHours({ day: incoming.result.day_start, night: incoming.result.night_start });
    } else if (LIFE_OPS.includes(incoming.op)) {
      if (incoming.op === "interest_suggest") setTopic("");
      mind("life");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming]);

  if (!life) return <p className="dim">…</p>;
  const limits = canvas.limits;
  const open = life.interests.filter((i) => i.status === "open");
  const gone = life.interests.filter((i) => i.status !== "open");
  const used = life.today.filter((m) => !m.nothing).length;
  const share = life.budget.share_usd;

  return (
    <div className="stack wide life">
      <div className="readouts">
        <div className="readout">
          <div className="label">NOW</div>
          <div className="value">
            {PHASE[life.phase] ?? life.phase}
            {life.asleep ? " · ASLEEP" : ""}
          </div>
          <div className="note">
            day {life.day_start} to {life.night_start}
          </div>
        </div>
        <div className="readout">
          <div className="label">ITS OWN SHARE</div>
          <div className="value">
            {money(life.budget.available_usd)} <span className="unit">free now</span>
          </div>
          <span className="bar small">
            <span className="amber" style={{ width: `${share > 0 ? Math.round(Math.min(1, life.budget.spent_usd / share) * 100) : 0}%` }} />
          </span>
          <div className="note">
            {money(life.budget.spent_usd)} of {money(share)} this month
          </div>
        </div>
        <div className="readout">
          <div className="label">ITS MOMENTS TODAY</div>
          <div className="value">
            {String(life.today.length).padStart(2, "0")} <span className="unit">{life.today.length ? `· used ${used}` : ""}</span>
          </div>
          <div className="note">at most {money(life.session_usd)} each</div>
        </div>
        <div className="readout">
          <div className="label">ADDED UNASKED TODAY</div>
          <div className="value">{limits ? `${limits.uninvited_today} of ${limits.uninvited_per_day}` : "–"}</div>
          <div className="note">things on the canvas</div>
        </div>
      </div>
      <p className="small">
        <span className="dim">Its next moment of its own: </span>
        {life.own_time ? life.next : "its own time is turned off"}.
      </p>

      <h4>What it is curious about, and where each interest came from</h4>
      {open.length === 0 && <p className="dim">Nothing yet. Woody adds an interest when something catches its curiosity; you can suggest one.</p>}
      {open.map((i) => (
        <details key={i.id} className="record interest">
          <summary>
            <span className="one">{i.topic}</span>
            <span className="dim small">
              {i.source === "operator" ? "you suggested it" : `from: ${i.origin}`} · {i.followed ? `followed ${i.followed} time${i.followed === 1 ? "" : "s"}, last ${day(i.last_followed)}` : "not followed yet"}
            </span>
          </summary>
          {i.notes.length === 0 && <p className="dim small">No notes yet.</p>}
          {i.notes.map((n, k) => (
            <p key={k} className="small">
              <span className="dim">{day(n.ts)}</span> {n.web && <span className="dim">[from the web] </span>}
              {n.text}
            </p>
          ))}
          <div className="row-actions">
            <button className="ghost mini" onClick={() => mind("interest_drop", { id: i.id })}>
              remove this interest
            </button>
          </div>
        </details>
      ))}
      <form
        className="search"
        onSubmit={(e) => {
          e.preventDefault();
          if (topic.trim().length >= 3) mind("interest_suggest", { topic: topic.trim() });
        }}
      >
        <label className="small dim" htmlFor="life-topic">
          Suggest something it might be curious about. It is a suggestion: Woody follows it in its own time, or drops it.
        </label>
        <input id="life-topic" value={topic} maxLength={160} onChange={(e) => setTopic(e.target.value)} />
        <button disabled={topic.trim().length < 3}>suggest</button>
      </form>
      {gone.length > 0 && (
        <label className="small dim">
          <input type="checkbox" checked={dropped} onChange={(e) => setDropped(e.target.checked)} /> show the {gone.length} it no longer follows
        </label>
      )}
      {dropped &&
        gone.map((i) => (
          <div key={i.id} className="record old">
            <span>{i.topic}</span>
            <span className="dim small">{i.dropped_reason || "dropped"}</span>
          </div>
        ))}

      <h4>What it did with its own time</h4>
      {life.journal.length === 0 && <p className="dim">Nothing yet. A day on which it takes no time of its own is recorded here as that.</p>}
      {life.journal.map((j: JournalEntry) => (
        <div key={j.id} className="record">
          <span className="dim small">
            {day(j.ts)} · {j.wake}
          </span>
          <span className="pre">{j.summary || j.outcome}</span>
        </div>
      ))}

      <h4>Your handles</h4>
      <div className="stack settings">
        <label className="small">
          <input type="checkbox" checked={life.own_time} onChange={(e) => mind("own_time", { enabled: e.target.checked })} /> Woody has time of its own, within its share of the budget
        </label>
        <label className="small dim" htmlFor="life-limit">
          Things it may add to the canvas in a day without being asked (0 to 20)
        </label>
        <input
          id="life-limit"
          type="number"
          min={0}
          max={20}
          step={1}
          value={limits?.uninvited_per_day ?? 3}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (e.target.value !== "" && Number.isInteger(n) && n >= 0 && n <= 20) tx({ type: "canvas_op", op: "set_limit", n });
          }}
        />
        <label className="small dim" htmlFor="life-day">
          Its day begins at, and its night begins at (your local time). At night it sleeps unless you are there or have work for it.
        </label>
        <div className="row-actions">
          <input id="life-day" type="time" aria-label="The day begins at" value={hours.day} onChange={(e) => setHours((h) => ({ ...h, day: e.target.value }))} />
          <input type="time" aria-label="The night begins at" value={hours.night} onChange={(e) => setHours((h) => ({ ...h, night: e.target.value }))} />
          <button
            className="ghost"
            disabled={(hours.day === life.day_start && hours.night === life.night_start) || !/^\d\d:\d\d$/.test(hours.day) || !/^\d\d:\d\d$/.test(hours.night)}
            onClick={() => mind("rhythm", { day_start: hours.day, night_start: hours.night })}
          >
            set these hours
          </button>
          <span className="dim small">now {clock(Date.now())}</span>
        </div>
      </div>
    </div>
  );
}
