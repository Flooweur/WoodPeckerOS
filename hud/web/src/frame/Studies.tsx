// The studies, as a record: what Woody is learning or has learned, for you
// or for itself, what it found, and the pages that were actually read. The
// operator starts a study here, changes its size or drops it.
import { useEffect, useState } from "react";
import type { MindResult, Send } from "./types";
import { day, money } from "./types";

type Note = { id: number; ts: number; text: string; sources: string[] };
type Page = { url: string; title: string; ts: number };
export type Study = {
  id: number;
  subject: string;
  why: string;
  owner: "operator" | "woody";
  status: "reading" | "explaining" | "done" | "dropped";
  created: number;
  updated: number;
  budget_usd: number;
  spent_usd: number;
  max_readings: number;
  readings: number;
  plan: string;
  thing_id: string | null;
  outcome: string;
  notes: Note[];
  pages: Page[];
};

const STUDY_OPS = ["studies", "study_add", "study_drop", "study_size"];
const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

function stage(s: Study): string {
  if (s.status === "reading") return `reading · session ${Math.min(s.readings + 1, s.max_readings)} of ${s.max_readings}`;
  if (s.status === "explaining") return "read · the explainer is being built";
  return s.status === "done" ? "done" : "given up";
}

export function StudiesRecord({ tx, incoming, version, openThing }: { tx: Send; incoming: MindResult | null; version: number; openThing: (id: string) => void }) {
  const [studies, setStudies] = useState<Study[] | null>(null);
  const [subject, setSubject] = useState("");
  const [size, setSize] = useState("medium");
  const mind = (op: string, extra: Record<string, unknown> = {}) => tx({ type: "mind", op, ...extra });

  // Asked again whenever the agent says something changed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => mind("studies"), [version]);
  useEffect(() => {
    if (!incoming?.ok || !STUDY_OPS.includes(incoming.op)) return;
    setStudies(incoming.result.studies);
    if (incoming.op === "study_add") setSubject("");
  }, [incoming]);

  if (!studies) return <p className="dim">…</p>;
  const open = studies.filter((s) => s.status === "reading" || s.status === "explaining");
  const closed = studies.filter((s) => s.status === "done" || s.status === "dropped").reverse();

  const body = (s: Study, live: boolean) => (
    <>
      <p className="small">
        {s.owner === "woody" ? "Woody's own study, paid from its share" : "For you"} · {s.why}
      </p>
      {live && s.plan && (
        <p className="small">
          <span className="dim">Next it wants to find out: </span>
          {s.plan}
        </p>
      )}
      {s.outcome && (
        <p className="small">
          <span className="dim">{s.status === "done" ? "What the explainer shows: " : "Why it ended: "}</span>
          {s.outcome}
        </p>
      )}
      {s.thing_id && (
        <div className="row-actions">
          <button className="ghost" onClick={() => openThing(s.thing_id!)}>
            show the explainer's record
          </button>
        </div>
      )}
      <h4>Findings · {s.notes.length}</h4>
      {s.notes.length === 0 && <p className="dim small">Nothing written down yet.</p>}
      <ol className="findings">
        {s.notes.map((n) => (
          <li key={n.id}>
            {n.text}
            {n.sources.length > 0 && <span className="dim small"> · read at {[...new Set(n.sources.map(host))].join(", ")}</span>}
          </li>
        ))}
      </ol>
      <h4>Pages read · {s.pages.length}</h4>
      <p className="dim small">Recorded when each page was fetched. Woody does not write this list.</p>
      {s.pages.map((p) => (
        <div key={p.url} className="source">
          <span>{p.title || host(p.url)}</span>
          <span className="dim small url">{p.url}</span>
        </div>
      ))}
      {live && (
        <div className="row-actions">
          <button className="ghost" onClick={() => mind("study_size", { id: s.id, budget_usd: Math.min(10, Number((s.budget_usd + 1).toFixed(2))), max_readings: Math.min(20, s.max_readings + 2) })}>
            give it $1 and two sessions more
          </button>
          <button className="danger" onClick={() => mind("study_drop", { id: s.id })}>
            drop this study
          </button>
        </div>
      )}
    </>
  );

  return (
    <div className="stack wide studies">
      <form
        className="search three"
        onSubmit={(e) => {
          e.preventDefault();
          if (subject.trim().length >= 3) mind("study_add", { subject: subject.trim(), size });
        }}
      >
        <label className="small dim" htmlFor="study-subject">
          Have Woody learn a subject. It reads over several sessions, writes down what it finds, then puts a thing on the canvas that explains it.
        </label>
        <input id="study-subject" value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} />
        <select aria-label="Size of the study" value={size} onChange={(e) => setSize(e.target.value)}>
          <option value="small">small · $0.50, 2 sessions</option>
          <option value="medium">medium · $1.50, 5 sessions</option>
          <option value="large">large · $4, 10 sessions</option>
        </select>
        <button disabled={subject.trim().length < 3}>study</button>
      </form>
      {open.length === 0 && <p className="dim">No study is under way.</p>}
      {open.map((s) => (
        <details key={s.id} className="record interest" open={open.length === 1}>
          <summary>
            <span className="one">{s.subject}</span>
            <span className="small dim">
              {stage(s)} · {count(s.notes.length, "finding")} from {count(s.pages.length, "page")} · {money(s.spent_usd)} of {money(s.budget_usd)}
            </span>
            <span className="bar small">
              <span className="amber" style={{ width: `${Math.round(Math.min(1, s.spent_usd / s.budget_usd) * 100)}%` }} />
            </span>
          </summary>
          {body(s, true)}
        </details>
      ))}
      {closed.length > 0 && <h4>Finished</h4>}
      {closed.map((s) => (
        <details key={s.id} className={`record interest ${s.status === "dropped" ? "old" : ""}`}>
          <summary>
            <span className="one">{s.subject}</span>
            <span className="small dim">
              {stage(s)} · {day(s.updated)} · {count(s.notes.length, "finding")} from {count(s.pages.length, "page")} · {money(s.spent_usd)}
            </span>
          </summary>
          {body(s, false)}
        </details>
      ))}
    </div>
  );
}
