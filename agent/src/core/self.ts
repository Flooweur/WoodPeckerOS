// What Woody may change about itself without asking: the text that says who
// it is, and the designs its lattice shows. Plain code, no model: the limits
// on a change are measured here, so they hold whatever the model writes.

// ---- identity: the size of a step, and the distance from the first version ------

export const IDENTITY = {
  /** At most this share of the words may differ from the version before. */
  stepShare: 0.25,
  /** One step a day: this many hours must pass between two of Woody's changes. */
  hoursBetween: 20,
  /** Once less than this share of the first version remains, changes wait for the operator. */
  anchorFloor: 0.5,
  /** After the operator restores or rewrites the identity, Woody leaves it alone for this many days. */
  quietDaysAfterOperator: 3,
  minChars: 40,
  maxChars: 3000,
};

/** The words of a text, lowercased, without punctuation. */
export function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) ?? [];
}

/** How many words two texts share, in order (the longest common subsequence). */
function common(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) row[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, row[j - 1]!);
    prev = row;
  }
  return prev[b.length]!;
}

/** The share of words that differ between two versions, 0 (same) to 1 (nothing in common). */
export function changedShare(before: string, after: string): number {
  const a = words(before);
  const b = words(after);
  const longest = Math.max(a.length, b.length);
  return longest ? 1 - common(a, b) / longest : 0;
}

/** The share of the first version's words still present, in order, in the current one. */
export function remainingShare(anchor: string, current: string): number {
  const a = words(anchor);
  return a.length ? common(a, words(current)) / a.length : 1;
}

// ---- the lattice: what is Woody's to draw, and what is the frame's ----------------

export const PALETTE = ["amber", "white", "green", "blue", "violet"] as const;
export type Colour = (typeof PALETTE)[number];

/** A design is a flip book: up to sixteen pictures of 8 by 8 cells, each shown for a time. */
export type Frame = { rows: string[]; ms: number };
export type Design = {
  colour: Colour;
  /** Cells change smoothly from one picture to the next instead of switching. */
  fade: boolean;
  /** For a moment or an expression: how many times the pictures are played. A state loops for as long as it lasts. */
  repeat: number;
  frames: Frame[];
};

export const FACE = { maxFrames: 16, minMs: 80, maxMs: 5000, maxRepeat: 4, maxPlayMs: 8000, maxInvented: 12, keepVersions: 30 };

export type FaceKind = "state" | "moment" | "expression";

/** The designs that exist from the start, drawn by the frame until Woody redraws them. */
export const BUILTIN: Record<string, { kind: FaceKind; about: string; looks: string }> = {
  attending: { kind: "state", about: "while you answer the operator", looks: "rings spreading from the centre" },
  working: { kind: "state", about: "while you work on something by yourself", looks: "cells firing here and there, like thoughts" },
  resting: { kind: "state", about: "while nothing is asked of you", looks: "four centre cells breathing" },
  sleeping: { kind: "state", about: "at night, while you sleep", looks: "one low line breathing very slowly" },
  reflecting: { kind: "state", about: "during your daily reflection", looks: "two halves breathing in turn" },
  woke: { kind: "moment", about: "a session starts", looks: "a line in the middle opens like an eye" },
  message: { kind: "moment", about: "a message from the operator arrives", looks: "a dot comes in from the side" },
  tool: { kind: "moment", about: "you call a tool", looks: "one bright cell, somewhere different each time" },
  saved: { kind: "moment", about: "you stored a memory", looks: "lit cells settle downwards" },
  done: { kind: "moment", about: "a session ended well", looks: "a tick" },
  smile: { kind: "expression", about: "the operator comes back after a while", looks: "a face with blinking eyes and a smile" },
  wink: { kind: "expression", about: "a goal was finished within its budget", looks: "a smiling face, one eye winking" },
  yawn: { kind: "expression", about: "you start again after a long rest", looks: "closed eyes and an open mouth" },
  peck: { kind: "expression", about: "you start work on a goal", looks: "three quick taps of the whole field" },
  curious: { kind: "expression", about: "a goal needs the operator's answer", looks: "eyes at different heights, a small mouth" },
  worried: { kind: "expression", about: "something is wrong on the machine", looks: "a face with a wavering mouth" },
  sparkle: { kind: "expression", about: "the operator took up an idea of yours", looks: "a star twinkling" },
  heart: { kind: "expression", about: "the operator thanked you", looks: "a heart beating" },
  listening: { kind: "expression", about: "the operator is typing", looks: "eyes turned to the side where they type" },
  asleep: { kind: "expression", about: "you are asleep", looks: "closed eyes and two Zs" },
};

/** Signals that tell the operator the truth about the machine. Only the frame draws them, in red. */
export const RESERVED = ["waiting", "paused", "stopped", "api_error", "no_credential", "out_of_allowance", "pacing", "web", "problem"];

const NAME = /^[a-z][a-z0-9-]{1,23}$/;

/** Whether this is a name Woody may give to an expression of its own. */
export function nameProblem(name: string): string | null {
  if (RESERVED.includes(name)) return `"${name}" is one of the frame's own signals; it cannot be redrawn or imitated by name`;
  if (!NAME.test(name)) return "a name is 2 to 24 lowercase letters, digits or hyphens, starting with a letter";
  return null;
}

/**
 * Checks a design as it was written and returns it in its exact form, or says
 * what is wrong with it. The frame checks again before drawing.
 */
export function checkDesign(input: unknown, kind: FaceKind): { design: Design } | { error: string } {
  const no = (error: string) => ({ error });
  const d = input as { colour?: unknown; color?: unknown; fade?: unknown; repeat?: unknown; frames?: unknown } | null;
  if (!d || typeof d !== "object") return no("a design is an object with frames");
  const colour = (d.colour ?? d.color ?? "amber") as Colour;
  if (!PALETTE.includes(colour)) return no(`the colour must be one of: ${PALETTE.join(", ")} (red is the frame's)`);
  if (!Array.isArray(d.frames) || d.frames.length < 1 || d.frames.length > FACE.maxFrames) return no(`a design has 1 to ${FACE.maxFrames} frames`);
  const frames: Frame[] = [];
  let lit = false;
  for (const [i, f] of (d.frames as Array<{ rows?: unknown; ms?: unknown }>).entries()) {
    const at = `frame ${i + 1}`;
    if (!f || !Array.isArray(f.rows) || f.rows.length !== 8) return no(`${at}: rows must be 8 strings`);
    for (const row of f.rows) {
      if (typeof row !== "string" || !/^[.0-9]{8}$/.test(row)) return no(`${at}: each row is 8 characters, '.' for dark or a digit 1 to 9 for brightness`);
      if (/[1-9]/.test(row)) lit = true;
    }
    const ms = Number(f.ms);
    if (!Number.isFinite(ms) || ms < FACE.minMs || ms > FACE.maxMs) return no(`${at}: ms must be between ${FACE.minMs} and ${FACE.maxMs}`);
    frames.push({ rows: (f.rows as string[]).map((r) => r.replaceAll("0", ".")), ms: Math.round(ms) });
  }
  if (!lit) return no("at least one cell must be lit in one frame: a lattice that is dark throughout looks broken");
  const repeat = d.repeat === undefined ? 1 : Number(d.repeat);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > FACE.maxRepeat) return no(`repeat must be a whole number from 1 to ${FACE.maxRepeat}`);
  const once = frames.reduce((s, f) => s + f.ms, 0);
  if (kind !== "state" && once * repeat > FACE.maxPlayMs) return no(`played ${repeat} time(s) this lasts ${once * repeat} ms; a moment or an expression lasts at most ${FACE.maxPlayMs} ms`);
  if (kind !== "state" && once * repeat < 300) return no("too short to be seen: make it last at least 300 ms");
  return { design: { colour, fade: d.fade === true, repeat: kind === "state" ? 1 : repeat, frames } };
}
