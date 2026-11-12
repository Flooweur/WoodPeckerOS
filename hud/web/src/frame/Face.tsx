// Woody's face, as a record: every design its lattice can show, which of
// them Woody drew itself and why, and the frame's own signals that it cannot
// redraw. The operator can put any earlier version back, or the built-in one.
import { useEffect, useState } from "react";
import { FacePreview } from "./Lattice";
import { RESERVED, checkDesign, type FaceAnswer, type FaceEntry, type FaceVersion } from "./faceData";
import type { MindResult, Send } from "./types";
import { day } from "./types";

/** The frame's signals, shown so that the operator knows what each one says. */
const SIGNALS: Array<{ name: string; says: string }> = [
  { name: "waiting", says: "Woody waits for your approval" },
  { name: "paused", says: "you paused Woody" },
  { name: "api_error", says: "the model cannot be reached, or no key is set" },
  { name: "out_of_allowance", says: "the allowance is spent for now" },
  { name: "pacing", says: "the hour's ceiling of sessions is reached" },
  { name: "web", says: "this session has read the web and may no longer act" },
  { name: "problem", says: "something failed" },
];

const GROUPS: Array<{ title: string; note: string; pick: (f: FaceEntry) => boolean }> = [
  { title: "States", note: "shown for as long as they last", pick: (f) => f.builtin && f.kind === "state" },
  { title: "Moments", note: "played once when something happens", pick: (f) => f.builtin && f.kind === "moment" },
  { title: "Expressions", note: "played once, from a real cause or when Woody chooses", pick: (f) => f.builtin && f.kind === "expression" },
  { title: "Expressions Woody invented", note: "", pick: (f) => !f.builtin },
];

export function FaceRecord({ tx, incoming, faceVersion }: { tx: Send; incoming: MindResult | null; faceVersion: number }) {
  const [face, setFace] = useState<FaceAnswer | null>(null);
  const mind = (op: string, extra: Record<string, unknown> = {}) => tx({ type: "mind", op, ...extra });

  // Asked again whenever Woody redraws something.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => mind("face"), [faceVersion]);
  useEffect(() => {
    if (!incoming?.ok || (incoming.op !== "face" && incoming.op !== "face_restore")) return;
    const answer = incoming.result as FaceAnswer;
    // A design under one of the frame's own names is not Woody's to have: it is not listed, as it is not drawn.
    setFace({ ...answer, designs: (answer.designs ?? []).filter((f) => !RESERVED.includes(f.name)), history: answer.history ?? {} });
  }, [incoming]);

  if (!face) return <p className="dim">…</p>;
  const own = face.designs.filter((f) => checkDesign(f.design)).length;

  const entry = (f: FaceEntry) => {
    const design = checkDesign(f.design);
    const versions: FaceVersion[] = (face.history[f.name] ?? []).slice(1).filter((v) => v.design).slice(0, 3);
    return (
      <div key={f.name} className="face-entry">
        <FacePreview name={f.name} design={design} />
        <div className="face-text">
          <div className="one">
            <b>{f.name}</b> <span className="dim small">· {f.about}</span>
          </div>
          {f.design ? (
            <div className="small">
              Drawn by Woody{f.ts ? ` on ${day(f.ts)}` : ""}
              {f.reason ? `: ${f.reason}` : "."}
              {!design && <span className="problem"> This drawing is not well formed, so the frame does not show it.</span>}
            </div>
          ) : (
            <div className="small dim">Built-in: {f.looks}.</div>
          )}
          {(f.design || versions.length > 0) && (
            <div className="row-actions">
              {f.design && (
                <button className="ghost" onClick={() => mind("face_restore", { name: f.name })}>
                  {f.builtin ? "put the built-in back" : "remove"}
                </button>
              )}
              {versions.map((v) => (
                <button key={v.id} className="ghost" title={v.reason} onClick={() => mind("face_restore", { name: f.name, id: v.id })}>
                  back to {day(v.ts)}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="stack wide face">
      <p className="small">
        The lattice is Woody's face. {own === 0 ? "So far it shows the built-in designs." : `${own} of its ${face.designs.length} designs are Woody's own drawings.`} Woody may redraw
        any of them and invent expressions; every version is kept.
      </p>
      {GROUPS.map((g) => {
        const list = face.designs.filter(g.pick);
        if (!list.length) return null;
        return (
          <section key={g.title}>
            <h4>
              {g.title} {g.note && <span className="dim small">· {g.note}</span>}
            </h4>
            <div className="face-grid">{list.map(entry)}</div>
          </section>
        );
      })}
      {Object.entries(face.history)
        .filter(([name]) => !face.designs.some((f) => f.name === name))
        .map(([name, versions]) => {
          const last = versions.find((v) => v.design);
          return last ? (
            <div key={name} className="record inline">
              <span className="small dim">"{name}", an expression Woody invented, was removed.</span>
              <button className="ghost" onClick={() => mind("face_restore", { name, id: last.id })}>
                bring it back
              </button>
            </div>
          ) : null;
        })}
      <section>
        <h4>
          The frame's own signals <span className="dim small">· Woody cannot redraw these, and red is theirs alone</span>
        </h4>
        <div className="face-grid">
          {SIGNALS.map((s) => (
            <div key={s.name} className="face-entry">
              <FacePreview name={s.name} design={null} />
              <div className="face-text">
                <div className="one">
                  <b>{s.name.replaceAll("_", " ")}</b>
                </div>
                <div className="small dim">{s.says}</div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
