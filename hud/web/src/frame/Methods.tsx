// How Woody works, as a record: its methods, one section for each part of
// its work. Woody may rewrite a section or add one by itself; every version
// is kept. Here the operator sees each change with its before and after and
// puts any version back. Woody's rules are not here: those are locked.
import { useEffect, useState } from "react";
import { diffWords, type DiffPart } from "./faceData";
import type { MindResult, Send } from "./types";
import { day } from "./types";

type Actor = "program" | "woody" | "operator";
type Version = { id: number; section: string; title: string; ts: number; text: string | null; reason: string; actor: Actor };
type Method = { section: string; title: string; text: string; id: number; ts: number; actor: Actor; reason: string; shipped: boolean };
type Answer = { sections: Method[]; history: Record<string, Version[]> };

const WHO: Record<Actor, string> = { program: "as shipped with the program", woody: "written by Woody", operator: "put back by you" };

function Diff({ parts, kind }: { parts: DiffPart[]; kind: "gone" | "new" }) {
  return <pre className="diff">{parts.map((p, i) => (p.changed ? <mark key={i} className={`diff-${kind}`}>{p.text}</mark> : <span key={i}>{p.text}</span>))}</pre>;
}

export function MethodsRecord({ tx, incoming, version }: { tx: Send; incoming: MindResult | null; version: number }) {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const mind = (op: string, extra: Record<string, unknown> = {}) => tx({ type: "mind", op, ...extra });

  // Asked again whenever the agent says something changed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => mind("methods"), [version]);
  useEffect(() => {
    if (incoming?.ok && (incoming.op === "methods" || incoming.op === "method_restore")) setAnswer(incoming.result);
  }, [incoming]);

  if (!answer) return <p className="dim">…</p>;
  const own = answer.sections.filter((m) => m.actor === "woody").length;

  return (
    <div className="stack wide methods">
      <p className="small">
        These are Woody's methods: how it does its work. {own === 0 ? "So far they read as shipped with the program." : `${own} of the ${answer.sections.length} sections ${own === 1 ? "was" : "were"} written by Woody.`} Woody may rewrite
        a section or add one by itself, and it takes effect at once. Its rules are a separate text that it cannot change.
      </p>
      {answer.sections.map((m) => {
        const versions = answer.history[m.section] ?? [];
        // The version before the current one, to show what the last change was.
        const before = versions.find((v) => v.id < m.id && v.text !== null);
        const diff = before && m.actor === "woody" ? diffWords(before.text!, m.text) : null;
        return (
          <details key={m.section} className="record interest" open={m.actor === "woody"}>
            <summary>
              <span className="one">{m.title}</span>
              <span className="small dim">
                {WHO[m.actor]} · {day(m.ts)}
                {m.actor === "woody" && m.reason ? ` · ${m.reason}` : ""}
              </span>
            </summary>
            {diff && before ? (
              <>
                <div className="pair">
                  <div>
                    <div className="label">BEFORE · {WHO[before.actor].toUpperCase()}</div>
                    <Diff parts={diff.before} kind="gone" />
                  </div>
                  <div>
                    <div className="label">NOW · WRITTEN BY WOODY</div>
                    <Diff parts={diff.after} kind="new" />
                  </div>
                </div>
                <div className="row-actions">
                  <button onClick={() => mind("method_restore", { section: m.section, id: before.id })}>put the version before back</button>
                  <span className="dim small">Nothing is lost: Woody's version stays in the versions below.</span>
                </div>
              </>
            ) : (
              <pre>{m.text}</pre>
            )}
            {versions.length > 1 && (
              <>
                <h4>Versions</h4>
                {versions.slice(1).map((v) => (
                  <details key={v.id} className="record">
                    <summary className="small dim">
                      {day(v.ts)} · {WHO[v.actor]}
                      {v.reason && v.actor !== "program" ? ` · ${v.reason}` : ""}
                    </summary>
                    {v.text === null ? (
                      <p className="dim small">The section was removed at this point.</p>
                    ) : (
                      <>
                        <pre>{v.text}</pre>
                        <div className="row-actions">
                          <button className="ghost" onClick={() => mind("method_restore", { section: m.section, id: v.id })}>
                            put this version back
                          </button>
                        </div>
                      </>
                    )}
                  </details>
                ))}
              </>
            )}
          </details>
        );
      })}
    </div>
  );
}
