// The mind panel's lattice: an 8 by 8 field that shows what Woody is doing.
//
// Three layers, in order of priority:
//   1. a state that needs the operator or means "stopped" (waiting, paused,
//      refused): shown alone, never covered;
//   2. an expression or a moment: plays once for a couple of seconds;
//   3. the ongoing state (answering, working, resting, ...).
//
// Everything is opacity on 64 cells, because the kiosk renders in software.
// The designs were chosen by the operator from the Phase 5 canvas. Since
// Phase 8c Woody may redraw most of them and invent expressions: its drawings
// arrive as data (faceData.ts) and are played as flip books. The signals in red
// stay the frame's.
import { useEffect, useMemo, useState } from "react";
import { PALETTE, RESERVED, cellOpacity, playMs, type Design } from "./faceData";

export type MindStateName =
  | "attending" | "working" | "resting" | "sleeping" | "waiting" | "paused" | "out_of_allowance" | "pacing" | "no_credential" | "api_error";

/** Shown instead of the plain state while a session is of a special kind. */
export type Overlay = "web" | "reflecting" | null;

/** What the frame knows how to draw by itself. */
export type BuiltinPlay =
  | "woke" | "message" | "tool" | "saved" | "done" | "problem" // moments
  | "smile" | "wink" | "yawn" | "peck" | "curious" | "worried" | "sparkle" | "heart" | "listening" | "asleep"; // expressions
/** A one-off by name: a built-in one, or an expression Woody invented. */
export type Play = string;

type Cell = { color?: string; opacity?: number; anim?: string; delay?: number };

const RED = "var(--red)";
const hash = (c: number, r: number) => ((c * 73 + r * 151 + c * r * 31 + 17) % 97) / 97;
const dist = (c: number, r: number) => Math.hypot(c - 3.5, r - 3.5);

function field(fn: (c: number, r: number) => Cell | null): Cell[] {
  const cells: Cell[] = [];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) cells.push(fn(c, r) ?? {});
  return cells;
}

/** A picture is eight strings; '.' is dark, any other character is lit and may have a rule. */
function picture(rows: string[], rules: Record<string, (c: number, r: number) => Cell> = {}, color?: string): Cell[] {
  return field((c, r) => {
    const ch = rows[r]![c]!;
    if (ch === ".") return { opacity: 0.1 };
    return { opacity: 1, color, ...(rules[ch]?.(c, r) ?? {}) };
  });
}

const blink = (): Cell => ({ anim: "lat-eye 4s linear infinite" });
const once = (name: string, seconds: number): string => `${name} ${seconds}s linear 1 both`;

// ---- ongoing states -------------------------------------------------------

function stateCells(state: MindStateName, overlay: Overlay): Cell[] {
  if (overlay === "web" && (state === "working" || state === "attending")) {
    // The quarantine, shown: activity stays behind a wall with one gap.
    return field((c, r) =>
      c === 4
        ? r === 3 || r === 4 ? null : { opacity: 0.9 }
        : c > 4
          ? { anim: "lat-pop 2s linear infinite", delay: hash(c, r) * 2 }
          : r === 3 || r === 4 ? { anim: "lat-pop 2s linear infinite", delay: (3 - c) * 0.15 + 0.4 } : null,
    );
  }
  if (overlay === "reflecting" && state === "working") {
    // Two halves breathing in turn: weighing one thing against another.
    return field((c) => ({ anim: "lat-breathe 4s ease-in-out infinite", delay: c < 4 ? 0 : 2 }));
  }
  switch (state) {
    case "attending": // rings spreading from the centre: something is being said
      return field((c, r) => ({ anim: "lat-sweep 1.2s linear infinite", delay: dist(c, r) * 0.13 }));
    case "working": // cells firing here and there, like thoughts
      return field((c, r) => ({ anim: "lat-pop 2.4s linear infinite", delay: hash(c, r) * 2.4 }));
    case "resting": // four centre cells breathing
      return field((c, r) => ((c === 3 || c === 4) && (r === 3 || r === 4) ? { anim: "lat-breathe 5s ease-in-out infinite" } : null));
    case "sleeping": // one low line, breathing very slowly (the face with its Zs is the expression shown over it)
      return field((c, r) => (r === 5 && c >= 2 && c <= 5 ? { anim: "lat-breathe 9s ease-in-out infinite" } : null));
    case "waiting": // the edge facing the inbox blinks
      return field((c) => (c === 0 ? { color: RED, opacity: 1, anim: "lat-blink 1.2s linear infinite" } : { opacity: 0.22 }));
    case "pacing": // a full gauge: the hour's ceiling is used
      return field((_c, r) => (r >= 2 ? { opacity: 0.85 } : null));
    case "out_of_allowance": // one ember
      return field((c, r) => (c === 0 && r === 7 ? { color: RED, anim: "lat-breathe 4s ease-in-out infinite" } : null));
    case "paused": // two bars, still
      return field((c, r) => ((c === 2 || c === 5) && r >= 1 && r <= 6 ? { color: RED, opacity: 0.95 } : null));
    case "api_error":
    case "no_credential": // a cross, the same mark as "problem"
      return field((c, r) => (c === r || c === 7 - r ? { color: RED, opacity: 0.95 } : null));
  }
}

// ---- moments and expressions: play once ----------------------------------

const DURATION: Record<BuiltinPlay, number> = {
  woke: 1800, message: 1300, tool: 900, saved: 1500, done: 2200, problem: 2000,
  smile: 2800, wink: 2600, yawn: 2600, peck: 1500, curious: 2600, worried: 2600, sparkle: 2400, heart: 2400,
  listening: 0, asleep: 0, // these two last as long as their cause does
};

const FACE = {
  smile: ["........", ".ee..ee.", ".ee..ee.", "........", "#......#", ".#....#.", "..####..", "........"],
  wink: ["........", ".##..ww.", ".##..ww.", "........", "#......#", ".#....#.", "..####..", "........"],
  asleep: ["......Z.", ".....z..", "........", "###..###", "........", "........", "...##...", "........"],
  yawn: ["........", "........", ".##..##.", "........", "..mmmm..", ".m....m.", ".m....m.", "..mmmm.."],
  listening: ["........", "ee..ee..", "ee..ee..", "........", "........", "........", ".####...", "........"],
  curious: ["........", ".ee.....", ".ee..ee.", ".....ee.", "........", "...##...", "........", "........"],
  worried: ["........", ".ee..ee.", ".ee..ee.", "........", "........", "..#..#..", ".#.##.#.", "........"],
  sparkle: ["...#....", "...#....", ".#.#.#..", "..###...", "#######.", "..###...", ".#.#.#..", "...#...."],
  heart: ["........", ".##..##.", "########", "########", ".######.", "..####..", "...##...", "........"],
  tick: ["........", ".......#", "......#.", ".....#..", "#...#...", ".#.#....", "..#.....", "........"],
  bang: ["...##...", "...##...", "...##...", "...##...", "...##...", "........", "...##...", "...##..."],
};

function playCells(play: BuiltinPlay, seed: number): Cell[] {
  switch (play) {
    case "woke": // a line in the middle opens like an eye
      return field((_c, r) => ({ anim: once("lat-show", 1.8), delay: Math.abs(r - 3.5) * 0.1 }));
    case "message": // a dot comes in from the conversation side
      return field((c, r) => (r === 3 || r === 4 ? { anim: once("lat-pop", 1.3), delay: c * 0.06 } : null));
    case "tool": { // one bright cell, somewhere different each call
      const at = seed % 64;
      return field((c, r) => (r * 8 + c === at ? { anim: once("lat-flash", 0.9) } : null));
    }
    case "saved": // lit cells settle downwards
      return field((c, r) => ({ anim: once("lat-pop", 1.5), delay: r * 0.07 + hash(c, r) * 0.12 }));
    case "done":
      return picture(FACE.tick, { "#": () => ({ opacity: 0.1, anim: once("lat-show", 2.2) }) });
    case "problem":
      return picture(FACE.bang, { "#": () => ({ opacity: 0.1, anim: once("lat-show", 2) }) }, RED);
    case "peck": // three quick taps on the edge
      return field((c) => ({ anim: once("lat-tap", 1.5), delay: c * 0.02 }));
    case "smile":
      return picture(FACE.smile, { e: blink });
    case "wink":
      return picture(FACE.wink, { w: () => ({ anim: "lat-wink 2.6s linear 1 both" }) });
    case "yawn":
      return picture(FACE.yawn, { m: () => ({ anim: "lat-breathe 2.6s ease-in-out 1" }) });
    case "curious":
      return picture(FACE.curious, { e: blink });
    case "worried":
      return picture(FACE.worried, { e: blink }, RED);
    case "sparkle":
      return picture(FACE.sparkle, { "#": (c, r) => ({ anim: "lat-breathe 1.2s ease-in-out infinite", delay: hash(c, r) * 1.2 }) });
    case "heart":
      return picture(FACE.heart, { "#": () => ({ anim: "lat-breathe 1.2s ease-in-out infinite" }) });
    case "listening":
      return picture(FACE.listening, { e: blink });
    case "asleep":
      return picture(FACE.asleep, {
        z: () => ({ anim: "lat-blink 2.4s linear infinite" }),
        Z: () => ({ anim: "lat-blink 2.4s linear infinite", delay: 1.2 }),
      });
  }
}

/** States that must never be covered by a moment or an expression. */
const BLOCKING: MindStateName[] = ["waiting", "paused", "api_error", "no_credential", "out_of_allowance"];
/** States only the frame draws, whatever Woody has drawn: they tell the operator the truth about the machine. */
const FRAME_STATES: MindStateName[] = [...BLOCKING, "pacing"];
/** Moments play even when expressions are turned off. */
const MOMENTS = ["woke", "message", "tool", "saved", "done", "problem"];
const isBuiltin = (name: string): name is BuiltinPlay => Object.hasOwn(DURATION, name);

function Cells({ cells, label, mini }: { cells: Cell[]; label: string; mini?: boolean }) {
  return (
    <div className={`lattice ${mini ? "mini" : ""}`} role="img" aria-label={`Woody: ${label.replaceAll("_", " ")}`}>
      {cells.map((cell, i) => (
        <i
          key={i}
          style={{
            background: cell.color ?? "var(--amber)",
            opacity: cell.opacity ?? 0.12,
            animation: cell.anim,
            animationDelay: cell.delay ? `${cell.delay.toFixed(2)}s` : undefined,
          }}
        />
      ))}
    </div>
  );
}

/** Plays a flip book Woody drew: one picture after the other, each for its time. */
function Flip({ design, loop, pace = 1, label, mini }: { design: Design; loop: boolean; pace?: number; label: string; mini?: boolean }) {
  const [at, setAt] = useState(0);
  useEffect(() => {
    setAt(0);
    if (design.frames.length < 2) return; // a still picture
    let i = 0;
    let plays = 0;
    let timer = 0;
    const next = () => {
      timer = window.setTimeout(() => {
        i += 1;
        if (i >= design.frames.length) {
          plays += 1;
          if (!loop && plays >= design.repeat) return; // the last picture stays until the lattice moves on
          i = 0;
        }
        setAt(i);
        next();
      }, design.frames[i]!.ms * pace);
    };
    next();
    return () => window.clearTimeout(timer);
  }, [design, loop, pace]);

  const frame = design.frames[Math.min(at, design.frames.length - 1)]!;
  const colour = PALETTE[design.colour] ?? PALETTE.amber;
  const fade = design.fade ? `opacity ${Math.min(600, Math.round(frame.ms * pace * 0.8))}ms linear` : undefined;
  return (
    <div className={`lattice ${mini ? "mini" : ""}`} role="img" aria-label={`Woody: ${label.replaceAll("_", " ")}`} data-own="1">
      {frame.rows.flatMap((row, r) => [...row].map((ch, c) => <i key={r * 8 + c} style={{ background: colour, opacity: cellOpacity(ch), transition: fade }} />))}
    </div>
  );
}

export function Lattice({
  state,
  overlay,
  play,
  hold,
  expressions,
  pace = 1,
  designs = {},
}: {
  state: MindStateName;
  overlay: Overlay;
  /** A one-off to play now. `seq` changes for each new one, even if the name repeats. */
  play: { name: Play; seq: number } | null;
  /** An expression that lasts as long as its cause: listening while typing, asleep at night. */
  hold: "listening" | "asleep" | null;
  /** The operator can turn expressions off; moments still play. */
  expressions: boolean;
  /** How fast the ongoing state moves: below 1 is quicker, above 1 slower. Set by Woody's energy. */
  pace?: number;
  /** The designs Woody drew itself, by name, already checked (faceData.ts). The frame's own signals are never taken from here. */
  designs?: Record<string, Design>;
}) {
  const [current, setCurrent] = useState<{ name: Play; seq: number } | null>(null);
  /** Woody's own design for a name, unless the name is one of the frame's. */
  const own = (name: string): Design | undefined => (RESERVED.includes(name) ? undefined : designs[name]);

  useEffect(() => {
    if (!play) return;
    if (!expressions && !MOMENTS.includes(play.name)) return;
    const mine = own(play.name);
    const ms = mine ? playMs(mine) : isBuiltin(play.name) ? DURATION[play.name] : 0;
    if (!ms) return; // an unknown name, or one that only shows while its cause lasts
    setCurrent(play);
    const timer = window.setTimeout(() => setCurrent((cur) => (cur?.seq === play.seq ? null : cur)), ms);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [play, expressions]);

  const blocking = BLOCKING.includes(state);
  type Shown = { key: string; label: string } & ({ cells: Cell[] } | { design: Design; loop: boolean; pace: number });
  const shown: Shown = useMemo(() => {
    if (!blocking && current) {
      const mine = own(current.name);
      if (mine) return { key: `p${current.seq}`, design: mine, loop: false, pace: 1, label: current.name };
      if (isBuiltin(current.name)) return { key: `p${current.seq}`, cells: playCells(current.name, current.seq * 37), label: current.name };
    }
    if (!blocking && hold && expressions && (hold !== "asleep" || state === "sleeping")) {
      const mine = own(hold);
      return mine ? { key: `h-${hold}`, design: mine, loop: true, pace: 1, label: hold } : { key: `h-${hold}`, cells: playCells(hold, 0), label: hold };
    }
    const web = overlay === "web" && (state === "working" || state === "attending");
    const name = overlay === "reflecting" && state === "working" ? "reflecting" : state;
    // The frame's signals are drawn by the frame, whatever Woody's data holds.
    const mine = web || FRAME_STATES.includes(state) ? undefined : own(name);
    if (mine) return { key: `s-${name}-${pace}`, design: mine, loop: true, pace, label: name };
    // Only the ongoing state follows the pace. A state that needs the operator never changes its look.
    const cells = stateCells(state, overlay);
    const paced = blocking || pace === 1 ? cells : cells.map((c) => (c.anim ? { ...c, anim: c.anim.replace(/(\d+(?:\.\d+)?)s\b/, (_, n: string) => `${(Number(n) * pace).toFixed(2)}s`) } : c));
    return { key: `s-${state}-${overlay ?? ""}-${pace}`, cells: paced, label: web ? "web" : name };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocking, current, hold, expressions, state, overlay, pace, designs]);

  return "design" in shown ? (
    <Flip key={shown.key} design={shown.design} loop={shown.loop} pace={shown.pace} label={shown.label} />
  ) : (
    <Cells key={shown.key} cells={shown.cells} label={shown.label} />
  );
}

/** A small lattice showing one design by name, for the record of Woody's face: its own drawing if it has one, the built-in otherwise. */
export function FacePreview({ name, design }: { name: string; design: Design | null }) {
  const [round, setRound] = useState(0);
  // A built-in moment or expression plays once: start it again every few seconds.
  const once = !design && isBuiltin(name) && DURATION[name] > 0;
  useEffect(() => {
    if (!once) return;
    const timer = window.setInterval(() => setRound((r) => r + 1), DURATION[name as BuiltinPlay] + 900);
    return () => window.clearInterval(timer);
  }, [once, name]);
  if (design) return <Flip design={design} loop label={name} mini />;
  const cells =
    name === "reflecting" ? stateCells("working", "reflecting")
    : name === "web" ? stateCells("working", "web")
    : isBuiltin(name) ? playCells(name, round * 37 + 11)
    : stateCells(name as MindStateName, null);
  return <Cells key={round} cells={cells} label={name} mini />;
}
