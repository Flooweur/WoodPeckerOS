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

/** Feeds the frame itself holds: the machine's meters, and the thing's own content when Woody writes into it. */
const LOCAL_FEEDS = ["meters", "state"];
/**
 * Feeds the gateway reads (hud/server/feeds.ts), and how often a thing that
 * follows one gets it read again, in milliseconds. The thing hears of it only
 * when what was read differs from the last time.
 */
const FEED_EVERY: Record<string, number> = { services: 10_000, logs: 10_000, goals: 15_000, journal: 15_000, memory: 30_000, conversation: 10_000, files: 5_000, file: 5_000 };
const MAX_FOLLOWED = 8;
const START_MS = 8000;

/** What a thing asked through the bridge and the gateway answered. */
export type BridgeAnswer = { rid: string; ok: boolean; result?: unknown; error?: string };

export function Canvas({
  things,
  meters,
  tx,
  result,
  onWhy,
  bridge,
  pushed,
}: {
  /** Every thing the gateway reported; the ones put away are not shown. */
  things: ThingInfo[];
  meters: Meters;
  tx: Send;
  /** The gateway's latest answer to a canvas request. */
  result: CanvasResult | null;
  /** Open the record of one thing: its source, who made it and why. */
  onWhy: (id: string) => void;
  /** Where the page hands over the gateway's answers to what things asked: each one, as it arrives. */
  bridge: React.MutableRefObject<((answer: BridgeAnswer) => void) | null>;
  /** Content Woody just wrote into a thing. */
  pushed: { id: string; value: unknown; seq: number } | null;
}) {
  const shown = useMemo(() => things.filter((t) => !t.removed), [things]);
  const registry = useRef(new Map<string, Entry>());
  const subs = useRef(new Map<string, Set<string>>());
  const waiting = useRef(new Map<string, { win: Window; call: number }>());
  /** The feeds each thing follows: read again on a timer, delivered when they change. */
  const followed = useRef(new Map<string, Map<string, { last: string; timer: number }>>());
  const followAsks = useRef(new Map<string, { id: string; key: string }>());
  const versions = useRef(new Map<string, number>());
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
        case "read": {
          const feed = String(m.args?.feed);
          if (feed === "meters") return reply(win, call, true, metersRef.current);
          // Every other feed is read by the gateway, which checks what is asked.
          const r = `b${++rid.current}`;
          waiting.current.set(r, { win, call });
          tx({ type: "canvas_op", op: "feed", id, feed: feed.slice(0, 40), args: m.args?.args ?? {}, rid: r });
          return;
        }
        case "subscribe": {
          const feed = String(m.args?.feed);
          if (LOCAL_FEEDS.includes(feed)) {
            if (!subs.current.has(id)) subs.current.set(id, new Set());
            subs.current.get(id)!.add(feed);
            return reply(win, call, true, true);
          }
          const every = FEED_EVERY[feed];
          if (!every) return reply(win, call, false, null, `there is no feed "${feed}"`);
          const key = String(m.args?.key ?? feed).slice(0, 500);
          const mine = followed.current.get(id) ?? new Map<string, { last: string; timer: number }>();
          followed.current.set(id, mine);
          if (!mine.has(key)) {
            if (mine.size >= MAX_FOLLOWED) return reply(win, call, false, null, `a thing follows at most ${MAX_FOLLOWED} feeds`);
            const thing = id;
            const ask = () => {
              const r = `bs${++rid.current}`;
              followAsks.current.set(r, { id: thing, key });
              tx({ type: "canvas_op", op: "feed", id: thing, feed, args: m.args?.args ?? {}, rid: r });
            };
            mine.set(key, { last: "", timer: window.setInterval(ask, every) });
            ask();
          }
          return reply(win, call, true, true);
        }
        case "state.get":
        case "state.set": {
          // Always the sender's own state: the id comes from the window, not the message.
          const r = `b${++rid.current}`;
          waiting.current.set(r, { win, call });
          // "touched": someone was clicking or typing in the thing when it saved, as far as the browser can tell.
          tx({ type: "canvas_op", op: m.op === "state.get" ? "state_get" : "state_set", id, value: m.args?.value, touched: m.args?.touched === true, rid: r });
          return;
        }
        case "picture": {
          // A picture from the web that this thing was given. The gateway checks that it was.
          const r = `b${++rid.current}`;
          waiting.current.set(r, { win, call });
          tx({ type: "canvas_op", op: "picture", id, picture: String(m.args?.id ?? "").slice(0, 40), rid: r });
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

  // The gateway's answers to what things asked through the bridge. They are
  // handed over one by one as they arrive: none may be lost, or a thing would
  // wait for ever.
  useEffect(() => {
    bridge.current = (answer) => {
      const follow = followAsks.current.get(answer.rid);
      if (follow) {
        // A feed a thing follows was read again: the thing hears of it only if it changed.
        followAsks.current.delete(answer.rid);
        const entry = followed.current.get(follow.id)?.get(follow.key);
        if (!entry || !answer.ok) return;
        const body = JSON.stringify(answer.result ?? null);
        if (body === entry.last) return;
        entry.last = body;
        registry.current.get(follow.id)?.frame?.contentWindow?.postMessage({ woody: 1, feed: follow.key, value: answer.result ?? null }, "*");
        return;
      }
      const w = waiting.current.get(answer.rid);
      if (!w) return;
      waiting.current.delete(answer.rid);
      reply(w.win, w.call, answer.ok, answer.ok ? answer.result : null, answer.error);
    };
    return () => {
      bridge.current = null;
    };
  }, [bridge]);

  // What Woody wrote into a thing reaches it at once, if it listens (woody.state.onChange).
  useEffect(() => {
    if (pushed) registry.current.get(pushed.id)?.frame?.contentWindow?.postMessage({ woody: 1, feed: "state", value: pushed.value }, "*");
  }, [pushed]);

  // Readings go to the things that asked for them.
  useEffect(() => {
    metersRef.current = meters;
    for (const [id, feeds] of subs.current) {
      if (feeds.has("meters")) registry.current.get(id)?.frame?.contentWindow?.postMessage({ woody: 1, feed: "meters", value: meters }, "*");
    }
  }, [meters]);

  // A thing that left the canvas, or was replaced by a new version of itself, no longer receives anything:
  // the new version asks again for what it wants.
  useEffect(() => {
    const now = new Map(shown.map((t) => [t.id, t.version]));
    const stop = (id: string) => {
      subs.current.delete(id);
      for (const f of followed.current.get(id)?.values() ?? []) window.clearInterval(f.timer);
      followed.current.delete(id);
    };
    for (const id of new Set([...subs.current.keys(), ...followed.current.keys()])) {
      if (!now.has(id) || (versions.current.has(id) && versions.current.get(id) !== now.get(id))) stop(id);
    }
    versions.current = now;
  }, [shown]);
  useEffect(
    () => () => {
      for (const feeds of followed.current.values()) for (const f of feeds.values()) window.clearInterval(f.timer);
    },
    [],
  );

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
      {(thing.study || (thing.pictures?.length ?? 0) > 0) && phase === "ready" && (
        <button
          className="thing-sources"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onWhy}
          title={`${thing.study ? `It explains Woody's study of "${thing.study.subject}". ` : ""}Click for the pages that were read and where its pictures come from.`}
        >
          sources · {(thing.study?.sources.length ?? 0) + (thing.pictures?.length ?? 0)}
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
