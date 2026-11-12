// The canvas: where Woody's things are shown.
//
// Each thing is a document served by the gateway (/thing/<key>) in a frame
// with sandbox="allow-scripts": it has no origin of its own, no network, and
// no access to this page. Its only way out is the bridge: messages to this
// page, which knows the sender by the window the message came from, never by
// what the message claims.
//
// The operator handles things directly: every thing has a thin band along
// its top edge, which opens into a strip when the pointer is on it (drag to
// move, pin, why, close), and a grip in its corner resizes it. The band is
// part of this page, not of the thing, so it works whatever the thing does. Every such action goes to the gateway, which
// records it.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Meters, Send } from "../frame/types";
import type { Box, CanvasResult, ThingInfo } from "./types";

type Entry = { frame: HTMLIFrameElement | null; onMessage: (op: string, args: any) => void };
type Drag = { id: string; mode: "move" | "size"; startX: number; startY: number; from: Box; box: Box };

/** Feeds a thing may read through the bridge. */
const FEEDS = ["meters"];
const START_MS = 8000;

export function Canvas({
  things,
  meters,
  tx,
  result,
  onWhy,
}: {
  /** Every thing the gateway reported; the ones put away are not shown. */
  things: ThingInfo[];
  meters: Meters;
  tx: Send;
  /** The gateway's latest answer to a canvas request. */
  result: CanvasResult | null;
  /** Open the record of one thing: its source, who made it and why. */
  onWhy: (id: string) => void;
}) {
  const shown = useMemo(() => things.filter((t) => !t.removed), [things]);
  const registry = useRef(new Map<string, Entry>());
  const subs = useRef(new Map<string, Set<string>>());
  const waiting = useRef(new Map<string, { win: Window; call: number }>());
  const metersRef = useRef(meters);
  const rid = useRef(0);
  const [drag, setDrag] = useState<Drag | null>(null);

  const reply = (win: Window, call: number, ok: boolean, value: unknown, error?: string) => {
    if (call) win.postMessage({ woody: 1, re: call, ok, value, error }, "*");
  };

  // ---- the bridge, frame side ----
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const m = e.data;
      if (!m || m.woody !== 1 || typeof m.op !== "string") return;
      let id: string | null = null;
      for (const [key, entry] of registry.current) if (entry.frame?.contentWindow === e.source) id = key;
      if (!id) return; // not one of our things
      const win = e.source as Window;
      const call = typeof m.id === "number" ? m.id : 0;
      switch (m.op) {
        case "ready":
        case "error":
        case "blocked":
          registry.current.get(id)?.onMessage(m.op, m.args);
          return reply(win, call, true, true);
        case "read":
          return reply(win, call, true, m.args?.feed === "meters" ? metersRef.current : null);
        case "subscribe": {
          const feed = String(m.args?.feed);
          if (!FEEDS.includes(feed)) return reply(win, call, false, null, `there is no feed "${feed}"`);
          if (!subs.current.has(id)) subs.current.set(id, new Set());
          subs.current.get(id)!.add(feed);
          return reply(win, call, true, true);
        }
        case "state.get":
        case "state.set": {
          // Always the sender's own state: the id comes from the window, not the message.
          const r = `b${++rid.current}`;
          waiting.current.set(r, { win, call });
          tx({ type: "canvas_op", op: m.op === "state.get" ? "state_get" : "state_set", id, value: m.args?.value, rid: r });
          return;
        }
        case "emit": {
          // Tell Woody that something happened on this thing. The gateway paces it.
          const r = `b${++rid.current}`;
          waiting.current.set(r, { win, call });
          tx({ type: "canvas_op", op: "emit", id, name: String(m.args?.name ?? "").slice(0, 40), data: m.args?.data ?? null, rid: r });
          return;
        }
        default:
          return reply(win, call, false, null, "unknown request");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [tx]);

  // The gateway's answers to what things asked through the bridge.
  useEffect(() => {
    if (!result?.rid) return;
    const w = waiting.current.get(result.rid);
    if (!w) return;
    waiting.current.delete(result.rid);
    reply(w.win, w.call, result.ok, result.ok ? result.result : null, result.error);
  }, [result]);

  // Readings go to the things that asked for them.
  useEffect(() => {
    metersRef.current = meters;
    for (const [id, feeds] of subs.current) {
      if (feeds.has("meters")) registry.current.get(id)?.frame?.contentWindow?.postMessage({ woody: 1, feed: "meters", value: meters }, "*");
    }
  }, [meters]);

  // A thing that left the canvas no longer receives anything.
  useEffect(() => {
    const alive = new Set(shown.map((t) => t.id));
    for (const id of subs.current.keys()) if (!alive.has(id)) subs.current.delete(id);
  }, [shown]);

  const register = useCallback((id: string, entry: Entry | null) => {
    if (entry) registry.current.set(id, entry);
    else registry.current.delete(id);
  }, []);

  // ---- moving and resizing ----
  const begin = (e: React.PointerEvent, thing: ThingInfo, mode: Drag["mode"]) => {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ id: thing.id, mode, startX: e.clientX, startY: e.clientY, from: thing.box, box: thing.box });
  };
  const move = (e: React.PointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    const box =
      drag.mode === "move"
        ? { ...drag.from, x: Math.max(0, drag.from.x + dx), y: Math.max(0, drag.from.y + dy) }
        : { ...drag.from, w: Math.max(120, drag.from.w + dx), h: Math.max(80, drag.from.h + dy) };
    setDrag({ ...drag, box });
  };
  const end = () => {
    if (!drag) return;
    const moved = drag.box.x !== drag.from.x || drag.box.y !== drag.from.y || drag.box.w !== drag.from.w || drag.box.h !== drag.from.h;
    if (moved) tx({ type: "canvas_op", op: "place", id: drag.id, box: drag.box, raise: true });
    setDrag(null);
  };
  // Keep showing where it was dropped until the gateway's new layout arrives.
  const [held, setHeld] = useState<{ id: string; box: Box } | null>(null);
  useEffect(() => setHeld(null), [things]);

  return (
    <div className={`canvas ${drag ? "dragging" : ""}`} aria-label="Woody's canvas">
      {shown.map((thing) => (
        <ThingView
          key={thing.id}
          thing={thing}
          box={drag?.id === thing.id ? drag.box : held?.id === thing.id ? held.box : thing.box}
          active={drag?.id === thing.id}
          register={register}
          onBegin={begin}
          onMove={move}
          onEnd={() => {
            if (drag) setHeld({ id: drag.id, box: drag.box });
            end();
          }}
          onPin={() => tx({ type: "canvas_op", op: "pin", id: thing.id, pinned: !thing.pinned })}
          onClose={() => tx({ type: "canvas_op", op: "remove", id: thing.id })}
          onWhy={() => onWhy(thing.id)}
          onNoteSeen={() => tx({ type: "canvas_op", op: "note_seen", id: thing.id })}
          onHealth={(phase, faults) => tx({ type: "canvas_op", op: "health", id: thing.id, version: thing.version, phase, faults, rid: "bhealth" })}
        />
      ))}
    </div>
  );
}

function ThingView({
  thing,
  box,
  active,
  register,
  onBegin,
  onMove,
  onEnd,
  onPin,
  onClose,
  onWhy,
  onNoteSeen,
  onHealth,
}: {
  thing: ThingInfo;
  box: Box;
  active: boolean;
  register: (id: string, entry: Entry | null) => void;
  onBegin: (e: React.PointerEvent, thing: ThingInfo, mode: Drag["mode"]) => void;
  onMove: (e: React.PointerEvent) => void;
  onEnd: () => void;
  onPin: () => void;
  onClose: () => void;
  onWhy: () => void;
  /** The operator has read the note Woody left on this thing. */
  onNoteSeen: () => void;
  /** Tell the gateway whether this version started: Woody's change is kept only if it did. */
  onHealth: (phase: "ready" | "failed", faults: string[]) => void;
}) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  // A thing is shown once it says it is working. One that never does is not shown.
  const [phase, setPhase] = useState<"starting" | "ready" | "failed">("starting");
  const [faults, setFaults] = useState<string[]>([]);
  const loads = useRef(0);

  useEffect(() => {
    loads.current = 0;
    setPhase("starting");
    setFaults([]);
    const timer = window.setTimeout(() => setPhase((p) => (p === "starting" ? "failed" : p)), START_MS);
    return () => window.clearTimeout(timer);
  }, [thing.version, thing.key]);

  useEffect(() => {
    if (phase !== "starting") onHealth(phase, faults);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, faults]);

  useEffect(() => {
    register(thing.id, {
      get frame() {
        return frame.current;
      },
      onMessage: (op, args) => {
        if (op === "ready") setPhase("ready");
        else if (op === "error") setFaults((f) => [...f, String(args?.message ?? "error")].slice(-5));
        else if (op === "blocked") setFaults((f) => [...f, `blocked: ${String(args?.directive ?? "")} ${String(args?.uri ?? "")}`].slice(-5));
      },
    });
    return () => register(thing.id, null);
  }, [thing.id, register]);

  return (
    <div
      className={`thing ${thing.kind} ${phase} ${thing.pinned ? "pinned" : ""} ${faults.length ? "faulty" : ""} ${active ? "active" : ""}`}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h, zIndex: box.z }}
      data-thing={thing.id}
    >
      <iframe
        key={`${thing.key}:${thing.version}`}
        ref={frame}
        sandbox="allow-scripts"
        src={`/thing/${thing.key}?v=${thing.version}`}
        title={thing.title}
        onLoad={() => {
          // A second load means the thing tried to take its frame somewhere else.
          if (++loads.current > 1) {
            setFaults((f) => [...f, "it tried to leave its frame"].slice(-5));
            setPhase("failed");
          }
        }}
      />
      {phase !== "ready" && (
        <div className="thing-cover">
          {phase === "starting" ? `${thing.title} · starting…` : `"${thing.title}" did not start${faults.length ? `: ${faults[faults.length - 1]}` : ""}`}
        </div>
      )}
      <div className="thing-strip" onPointerDown={(e) => onBegin(e, thing, "move")} onPointerMove={onMove} onPointerUp={onEnd} onPointerCancel={onEnd}>
        <span className="thing-title" title={faults.length ? faults.join("\n") : thing.why || thing.title}>
          {faults.length ? "! " : ""}
          {thing.title}
        </span>
        <button onPointerDown={(e) => e.stopPropagation()} onClick={onPin} title={thing.pinned ? "Unpin: Woody may change it again" : "Pin: Woody cannot change, move or remove it"}>
          {thing.pinned ? "unpin" : "pin"}
        </button>
        <button onPointerDown={(e) => e.stopPropagation()} onClick={onWhy} title="Who made it, why, and its source">
          why
        </button>
        <button onPointerDown={(e) => e.stopPropagation()} onClick={onClose} title="Take it off the canvas (it is kept)">
          ×
        </button>
      </div>
      {thing.kind === "pretend" && <span className="thing-mark">pretend</span>}
      {/* An explainer's sources are the frame's to show: the pages that were read, from the record. */}
      {thing.study && phase === "ready" && (
        <button className="thing-sources" onPointerDown={(e) => e.stopPropagation()} onClick={onWhy} title={`It explains Woody's study of "${thing.study.subject}". Click for the pages that were read.`}>
          sources · {thing.study.sources.length}
        </button>
      )}
      {/* What Woody left without being asked says so, in the frame's own hand, until the operator has read it. */}
      {thing.uninvited && thing.note && !thing.note_seen && phase === "ready" && (
        <div className="thing-note">
          <span className="thing-note-from">{thing.for === "woody" ? "Woody put this here for itself" : "Woody left this for you"}</span>
          <span className="thing-note-text">{thing.note}</span>
          <button onClick={onNoteSeen} title="Keep the thing and put the note away. It stays in the thing's record.">
            ok
          </button>
        </div>
      )}
      <div className="thing-grip" title="Resize" onPointerDown={(e) => onBegin(e, thing, "size")} onPointerMove={onMove} onPointerUp={onEnd} onPointerCancel={onEnd} />
    </div>
  );
}
