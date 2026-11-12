// Two records of the canvas, drawn by the frame so that they are true
// whatever is on the canvas: every thing with its source, who made it and
// why; and every change, with the one that undo would take back.
import { useEffect, useState } from "react";
import type { CanvasChange, CanvasResult, CanvasState, ThingInfo } from "../canvas/types";
import type { Send } from "./types";
import { clock, day } from "./types";

const who = (by: string) => (by === "you" ? "you" : "Woody");

export function ThingsRecord({ canvas, tx, result, pick }: { canvas: CanvasState; tx: Send; result: CanvasResult | null; pick?: string }) {
  const [picked, setPicked] = useState<string | undefined>(pick);
  const [shown, setShown] = useState<{ id: string; version: number; source: string } | null>(null);
  const things = canvas.things;
  const thing = things.find((t) => t.id === picked);

  useEffect(() => setPicked(pick), [pick]);
  // Ask for the source of what is picked, again whenever its version changes.
  useEffect(() => {
    if (thing) tx({ type: "canvas_op", op: "get", id: thing.id, rid: `get:${thing.id}:${thing.version}` });
  }, [thing?.id, thing?.version, tx]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (result?.ok && result.op === "get" && result.result?.thing) setShown({ id: result.result.thing.id, version: result.result.thing.version, source: result.result.source });
  }, [result]);

  if (things.length === 0) return <p className="dim">Nothing has been put on the canvas yet.</p>;
  const op = (name: string, extra: Record<string, unknown> = {}) => thing && tx({ type: "canvas_op", op: name, id: thing.id, ...extra });

  return (
    <div className="things-record">
      <div>
        {things.map((t: ThingInfo) => (
          <button key={t.id} className={`entry ${t.id === picked ? "picked" : ""} ${t.removed ? "away" : ""}`} onClick={() => setPicked(t.id)}>
            <span className="num">{t.id}</span>
            <span className="entry-text">
              <span className="one">{t.title}</span>
              <span className="two">
                {t.removed ? "off the canvas" : t.pinned ? "pinned" : `for ${t.for === "you" ? "you" : "itself"}`} · by {who(t.by)} · v{t.version}
              </span>
            </span>
          </button>
        ))}
      </div>
      {!thing ? (
        <p className="dim">Pick a thing to see who made it, why, and its source.</p>
      ) : (
        <div className="stack wide">
          <h3>{thing.title}</h3>
          <p className="small">
            Made by {who(thing.by)} on {day(thing.created)}, for {thing.for === "you" ? "you" : "itself"}
            {thing.kind === "pretend" ? ". It is marked as pretend: what it shows is invented" : ""}.
            {thing.uninvited ? " Woody put it there on its own: nobody asked for it." : ""}
          </p>
          {thing.why && <p>{thing.why}</p>}
          {thing.note && (
            <p>
              <span className="dim small">Woody's note to you: </span>
              {thing.note}
            </p>
          )}
          {thing.study && (
            <div className="sources">
              <h4>
                Sources · {thing.study.sources.length} <span className="dim small">· the pages Woody read for its study of "{thing.study.subject}"</span>
              </h4>
              <p className="dim small">Listed by the frame from the record of pages that were fetched. Woody did not write this list and cannot leave a page out.</p>
              {thing.study.sources.length === 0 && <p className="dim small">No page was read for this study.</p>}
              {thing.study.sources.map((s) => (
                <div key={s.url} className="source">
                  <span>{s.title || s.url.replace(/^https:\/\//, "").split("/")[0]}</span>
                  <span className="dim small url">{s.url}</span>
                </div>
              ))}
            </div>
          )}
          <div className="row-actions">
            {thing.removed ? (
              <button className="primary" onClick={() => op("bring_back")}>put it back on the canvas</button>
            ) : (
              <>
                <button onClick={() => op("pin", { pinned: !thing.pinned })}>{thing.pinned ? "unpin" : "pin"}</button>
                <button className="ghost" onClick={() => op("remove")}>take it off the canvas</button>
              </>
            )}
            <span className="dim small">{thing.pinned ? "Pinned: Woody cannot change, move or remove it." : "Not pinned: Woody may change it."}</span>
          </div>
          <h4>Versions</h4>
          {[...thing.versions].reverse().map((v) => (
            <div key={v.v} className="record inline">
              <span className={v.v === thing.version ? "" : "dim"}>
                v{v.v} · {who(v.by)} · {day(v.ts)} · {v.bytes} bytes{v.why ? ` · ${v.why}` : ""}
                {v.v === thing.version ? " · shown now" : ""}
              </span>
              {v.v !== thing.version && (
                <button className="ghost mini" onClick={() => op("restore", { version: v.v })}>
                  show this one again
                </button>
              )}
            </div>
          ))}
          <h4>Source of version {thing.version}</h4>
          <pre>{shown && shown.id === thing.id && shown.version === thing.version ? shown.source : "…"}</pre>
        </div>
      )}
    </div>
  );
}

export function ChangesRecord({ canvas, tx, result }: { canvas: CanvasState; tx: Send; result: CanvasResult | null }) {
  const [changes, setChanges] = useState<CanvasChange[]>([]);
  // Ask again whenever the canvas changes.
  useEffect(() => tx({ type: "canvas_op", op: "history", n: 200, rid: "history" }), [canvas, tx]);
  useEffect(() => {
    if (result?.ok && result.op === "history" && Array.isArray(result.result)) setChanges(result.result);
  }, [result]);

  return (
    <div className="stack wide">
      <div className="row-actions">
        <button className="primary" disabled={!canvas.undo} onClick={() => tx({ type: "canvas_op", op: "undo" })}>
          undo the last change
        </button>
        <span className="dim small">{canvas.undo ? `${who(canvas.undo.by)} ${canvas.undo.text}` : "There is nothing to undo."}</span>
      </div>
      {changes.length === 0 && <p className="dim">Nothing has changed on the canvas yet.</p>}
      {changes.map((c) => (
        <div key={c.seq} className={`change ${c.by} ${c.undone ? "undone" : ""} ${c.refused ? "refused" : ""}`}>
          <span className="dim">{clock(c.ts)}</span>
          <span className="who">{who(c.by)}</span>
          <span className="what">
            {c.refused ? `tried: ${c.text} · refused: ${c.refused}` : c.text}
            {c.uninvited ? " (on its own)" : ""}
            {c.why && c.op !== "undo" && c.op !== "pin" ? ` · ${c.why}` : ""}
            {c.undone ? " (undone)" : ""}
          </span>
        </div>
      ))}
    </div>
  );
}
