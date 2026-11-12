// The lattice's designs that Woody drew itself, as the frame receives them.
//
// The frame never trusts what it is sent: every design is checked here before
// a single cell is drawn, whatever the agent already checked. Anything that
// does not fit is ignored and the built-in design is shown instead.

/** Woody's colours. Red is not among them: it belongs to the frame's own signals. */
export const PALETTE: Record<string, string> = {
  amber: "var(--amber)",
  white: "#efe6d2",
  green: "#7fcf95",
  blue: "#7fb2f5",
  violet: "#b59cf0",
};

export type Frame = { rows: string[]; ms: number };
/** A flip book: up to sixteen pictures of 8 by 8 cells, each shown for a time. */
export type Design = { colour: string; fade: boolean; repeat: number; frames: Frame[] };
export type FaceKind = "state" | "moment" | "expression";

/** One design as the agent's "face" answer lists it. */
export type FaceEntry = {
  name: string;
  kind: FaceKind;
  about: string;
  builtin: boolean;
  looks: string;
  design: Design | null;
  version: number | null;
  ts: number | null;
  reason: string;
};
export type FaceVersion = { id: number; name: string; ts: number; design: Design | null; about: string; reason: string; actor: string };
export type FaceAnswer = { version: number; designs: FaceEntry[]; history: Record<string, FaceVersion[]> };

/** What only the frame draws, whatever Woody's data says. */
export const RESERVED = ["waiting", "paused", "stopped", "api_error", "no_credential", "out_of_allowance", "pacing", "web", "problem"];

const LIMIT = { frames: 16, minMs: 80, maxMs: 5000, repeat: 4 };

/** The design in its exact form, or null if anything about it is not as it must be. */
export function checkDesign(input: unknown): Design | null {
  const d = input as Partial<Design> | null;
  if (!d || typeof d !== "object" || !Array.isArray(d.frames)) return null;
  if (d.frames.length < 1 || d.frames.length > LIMIT.frames) return null;
  if (typeof d.colour !== "string" || !Object.hasOwn(PALETTE, d.colour)) return null;
  const frames: Frame[] = [];
  for (const f of d.frames) {
    if (!f || !Array.isArray(f.rows) || f.rows.length !== 8) return null;
    if (!f.rows.every((r) => typeof r === "string" && /^[.0-9]{8}$/.test(r))) return null;
    if (typeof f.ms !== "number" || !Number.isFinite(f.ms) || f.ms < LIMIT.minMs || f.ms > LIMIT.maxMs) return null;
    frames.push({ rows: [...f.rows], ms: f.ms });
  }
  const repeat = Number.isInteger(d.repeat) && d.repeat! >= 1 && d.repeat! <= LIMIT.repeat ? d.repeat! : 1;
  return { colour: d.colour, fade: d.fade === true, repeat, frames };
}

/** The designs Woody drew, by name, from the agent's answer: only the well-formed ones, and never a reserved name. */
export function ownDesigns(answer: unknown): Record<string, Design> {
  const out: Record<string, Design> = {};
  const list = (answer as { designs?: unknown } | null)?.designs;
  if (!Array.isArray(list)) return out;
  for (const e of list as Array<Partial<FaceEntry>>) {
    if (typeof e?.name !== "string" || !/^[a-z][a-z0-9-]{1,23}$/.test(e.name) || RESERVED.includes(e.name)) continue;
    const design = checkDesign(e.design);
    if (design) out[e.name] = design;
  }
  return out;
}

/** How long one play of a design lasts, in milliseconds. */
export const playMs = (d: Design) => d.frames.reduce((s, f) => s + f.ms, 0) * d.repeat;

/** The opacity of a cell: '.' is the lattice's dark, 1 to 9 go from dim to full. */
export function cellOpacity(ch: string): number {
  const n = ch === "." ? 0 : Number(ch);
  return n ? 0.2 + (n / 9) * 0.8 : 0.1;
}

// ---- before and after, for the identity record ---------------------------------

export type DiffPart = { text: string; changed: boolean };

/**
 * Two texts, each split into runs of words that are in both (in order) and
 * runs that are only in that one. Used to show what changed between two
 * versions of the identity.
 */
export function diffWords(before: string, after: string): { before: DiffPart[]; after: DiffPart[] } {
  const split = (t: string) => t.split(/(\s+)/).filter((s) => s.length > 0);
  const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const a = split(before);
  const b = split(after);
  const wa = a.map((t, i) => ({ t, i })).filter((x) => /\S/.test(x.t));
  const wb = b.map((t, i) => ({ t, i })).filter((x) => /\S/.test(x.t));
  const n = wa.length;
  const m = wb.length;
  // Longest common subsequence of the words, then walk it back.
  const table: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = norm(wa[i]!.t) === norm(wb[j]!.t) ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const keptA = new Set<number>();
  const keptB = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (norm(wa[i]!.t) === norm(wb[j]!.t)) {
      keptA.add(wa[i]!.i);
      keptB.add(wb[j]!.i);
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) i++;
    else j++;
  }
  const parts = (tokens: string[], kept: Set<number>): DiffPart[] => {
    const out: DiffPart[] = [];
    tokens.forEach((t, k) => {
      // Whitespace takes the colour of what precedes it, so a changed run reads as one block.
      const changed = /\S/.test(t) ? !kept.has(k) : (out[out.length - 1]?.changed ?? false);
      const last = out[out.length - 1];
      if (last && last.changed === changed) last.text += t;
      else out.push({ text: t, changed });
    });
    return out;
  };
  return { before: parts(a, keptA), after: parts(b, keptB) };
}
