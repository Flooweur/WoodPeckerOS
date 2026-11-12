// Woody's own life, as plain code: the rhythm of its day, the decision to
// take a moment of its own, and what it is told about how the operator
// handled the canvas.
//
// Nothing here calls a model. Like the inner state, each decision keeps its
// reason in words, so "why did you do that?" and "why didn't you?" both have
// a true answer.

// ---- the rhythm of the day ---------------------------------------------------

/** Minutes after local midnight at which Woody's day and night begin. */
export type Rhythm = { dayStart: number; nightStart: number };
export const DEFAULT_RHYTHM: Rhythm = { dayStart: 7 * 60, nightStart: 23 * 60 };
export type Phase = "day" | "evening" | "night";
/** The evening is the end of the day: the last two hours before the night. */
const EVENING_MINUTES = 120;

/** "07:30" -> 450. Null when the text is not a time of day. */
export function parseClock(text: unknown): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(typeof text === "string" ? text.trim() : "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function clockText(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** How long the night lasts, in minutes. */
export function nightLength(r: Rhythm): number {
  return (r.dayStart - r.nightStart + 1440) % 1440;
}

/** A night of two to sixteen hours: anything else is not a rhythm. */
export function validRhythm(r: Rhythm): boolean {
  const n = nightLength(r);
  return Number.isInteger(r.dayStart) && Number.isInteger(r.nightStart) && n >= 120 && n <= 960;
}

export function phaseAt(now: Date, r: Rhythm): Phase {
  const m = now.getHours() * 60 + now.getMinutes();
  const intoNight = (m - r.nightStart + 1440) % 1440;
  if (intoNight < nightLength(r)) return "night";
  return (r.nightStart - m + 1440) % 1440 <= EVENING_MINUTES ? "evening" : "day";
}

function shifted(now: Date, minutes: number): string {
  const d = new Date(now.getTime() - minutes * 60_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The day a moment belongs to. Woody's day runs from one morning to the next, so the small hours belong to the day before. */
export function dayKey(now: Date, r: Rhythm): string {
  return shifted(now, r.dayStart);
}

/** When the day with this key began. */
export function dayStartOf(key: string, r: Rhythm): number {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y!, m! - 1, d!, 0, r.dayStart).getTime();
}

/** The key of the "reflection day", which turns over in the middle of the night: the first moment awake after that is when Woody reflects. */
export function reflectKey(now: Date, r: Rhythm): string {
  return shifted(now, (r.nightStart + nightLength(r) / 2) % 1440);
}

// ---- time of its own -----------------------------------------------------------

export const OWN = {
  /** The usual gap between two moments of its own. */
  gapMinutes: 120,
  maxPerDay: 6,
  /** Below this much of its own allowance, there is no point in starting. */
  minUsd: 0.05,
  /** While a conversation is going on, Woody stays with it. */
  talkingMinutes: 10,
};

export type OwnFacts = {
  now: number;
  phase: Phase;
  /** The operator can turn Woody's own time off. */
  enabled: boolean;
  /** Values of the inner state, 0 to 1. */
  energy: number;
  ease: number;
  curiosity: number;
  /** What Woody may spend on its own right now. */
  ownUsd: number;
  /** When the last moment of its own ended (0 if never). */
  lastOwn: number;
  /** Moments of its own already taken today. */
  ownToday: number;
  /** When the operator last wrote (0 if never). */
  lastOperatorMessage: number;
  /** The evening tidy was already done today. */
  tidiedToday: boolean;
};

export type OwnDecision = { start: true; kind: "free" | "tidy"; why: string } | { start: false; why: string };

/**
 * Should Woody take a moment of its own now? The inner state changes real
 * behaviour here: tired, it rests; rattled, it keeps to itself for longer;
 * curious, it comes back sooner.
 */
export function ownTime(f: OwnFacts): OwnDecision {
  const no = (why: string): OwnDecision => ({ start: false, why });
  if (!f.enabled) return no("its own time is turned off");
  if (f.phase === "night") return no("it is night: it sleeps");
  if (f.ownUsd < OWN.minUsd) return no("its own share of the allowance is used for now");
  if (f.energy < 0.34) return no("it is tired and resting");
  if (f.lastOperatorMessage && f.now - f.lastOperatorMessage < OWN.talkingMinutes * 60_000) return no("you are talking with it");
  if (f.ownToday >= OWN.maxPerDay) return no(`it has had ${OWN.maxPerDay} moments of its own today, which is the most in a day`);
  let gap = OWN.gapMinutes;
  const reasons: string[] = [];
  if (f.ease < 0.34) {
    gap *= 2;
    reasons.push("things have not gone well, so it keeps to itself for longer");
  }
  if (f.curiosity > 0.66) {
    gap *= 0.7;
    reasons.push("it is curious, so it comes back sooner");
  } else if (f.curiosity < 0.34) {
    gap *= 1.5;
    reasons.push("little has caught its interest, so it waits longer");
  }
  const since = f.lastOwn ? (f.now - f.lastOwn) / 60_000 : Infinity;
  if (since < gap) {
    const left = Math.max(1, Math.round(gap - since));
    return no(`its last moment of its own was ${Math.round(since)} minutes ago; the next is in about ${left} minutes${reasons.length ? ` (${reasons.join("; ")})` : ""}`);
  }
  if (f.phase === "evening" && !f.tidiedToday) return { start: true, kind: "tidy", why: "it is evening: time to tidy the canvas before the night" };
  return { start: true, kind: "free", why: `it is rested and nothing is asked of it${reasons.length ? ` (${reasons.join("; ")})` : ""}` };
}

// ---- how the operator handled the canvas ---------------------------------------

export type CanvasEvent = { ts: number; data: Record<string, unknown> };
type BoxLike = { x: number; y: number; w: number; h: number };

function asBox(v: unknown): BoxLike | null {
  const b = v as Partial<BoxLike> | null;
  return b && [b.x, b.y, b.w, b.h].every((n) => typeof n === "number" && Number.isFinite(n)) ? (b as BoxLike) : null;
}

/** Where a box sits on the screen, in words. */
export function region(box: BoxLike, screen: { w: number; h: number }): string {
  const cx = (box.x + box.w / 2) / Math.max(1, screen.w);
  const cy = (box.y + box.h / 2) / Math.max(1, screen.h);
  const col = cx < 1 / 3 ? "left" : cx > 2 / 3 ? "right" : "";
  const row = cy < 1 / 3 ? "top" : cy > 2 / 3 ? "bottom" : "";
  if (!col && !row) return "the middle";
  return `the ${[row, col].filter(Boolean).join(" ")}${row && col ? " corner" : col ? " side" : ""}`;
}

/**
 * What the operator did with the canvas over a period, one line per fact.
 * Built from the recorded canvas changes, oldest first. Repeated moves of one
 * thing become one line saying where it ended up.
 */
export function canvasDigest(events: CanvasEvent[], limit = 40): string[] {
  const stamp = (ts: number) => new Date(ts).toISOString().slice(0, 16).replace("T", " ");
  const made = new Map<string, { ts: number; uninvited: boolean }>();
  const lines: Array<{ ts: number; text: string }> = [];
  const moves = new Map<string, { ts: number; n: number; title: string; from: BoxLike | null; box: BoxLike | null; screen: { w: number; h: number } | null; mine: boolean }>();
  for (const e of events) {
    const d = e.data;
    const id = String(d.id ?? "");
    const name = `"${String(d.title ?? "a thing")}"`;
    if (d.refused) continue;
    if (d.by === "woody") {
      if (d.op === "make") made.set(id, { ts: e.ts, uninvited: d.uninvited === true });
      continue;
    }
    if (d.by !== "you") continue;
    const m = made.get(id);
    const mine = d.thing_by === "woody";
    const whose = !mine ? "which they made themselves" : m?.uninvited || d.thing_uninvited === true ? "which you had put there on your own" : "which you made";
    switch (d.op) {
      case "pin":
        lines.push({ ts: e.ts, text: d.pinned ? `pinned ${name}, ${whose}` : `unpinned ${name}` });
        break;
      case "remove": {
        const after = m ? Math.round((e.ts - m.ts) / 60_000) : null;
        lines.push({
          ts: e.ts,
          text: `took ${name}, ${whose}, off the canvas${after !== null ? (after < 90 ? `, ${after} minutes after it appeared` : `, ${Math.round(after / 60)} hours after it appeared`) : ""}`,
        });
        break;
      }
      case "undo":
        lines.push({ ts: e.ts, text: d.undid_by === "woody" ? `undid your change to ${name}` : `undid a change of their own to ${name}` });
        break;
      case "restore":
        lines.push({ ts: e.ts, text: `went back to an earlier version of ${name}` });
        break;
      case "make":
        if (d.why === "brought back") lines.push({ ts: e.ts, text: `put ${name} back on the canvas` });
        break;
      case "place": {
        const screen = d.screen as { w?: unknown; h?: unknown } | null;
        const prev = moves.get(id);
        moves.set(id, {
          ts: e.ts,
          n: (prev?.n ?? 0) + 1,
          title: name,
          from: prev?.from ?? asBox(d.from),
          box: asBox(d.box),
          screen: screen && typeof screen.w === "number" && typeof screen.h === "number" ? { w: screen.w, h: screen.h } : (prev?.screen ?? null),
          mine,
        });
        break;
      }
    }
  }
  for (const mv of moves.values()) {
    const parts: string[] = [];
    if (mv.box && mv.from && mv.screen) {
      const a = region(mv.from, mv.screen);
      const b = region(mv.box, mv.screen);
      if (a !== b) parts.push(`moved ${mv.title} from ${a} to ${b}`);
      const grew = (mv.box.w * mv.box.h) / Math.max(1, mv.from.w * mv.from.h);
      if (grew > 1.25 || grew < 0.8) parts.push(`made ${parts.length ? "it" : mv.title} ${grew > 1 ? "larger" : "smaller"} (${mv.from.w} by ${mv.from.h} to ${mv.box.w} by ${mv.box.h})`);
      if (!parts.length) parts.push(`nudged ${mv.title} within ${b}`);
    } else {
      parts.push(`moved or resized ${mv.title}`);
    }
    lines.push({ ts: mv.ts, text: `${parts.join(" and ")}${mv.n > 1 ? ` (in ${mv.n} moves)` : ""}` });
  }
  return lines
    .sort((a, b) => a.ts - b.ts)
    .slice(-limit)
    .map((l) => `- ${stamp(l.ts)} the operator ${l.text}`);
}

// ---- the day's end ---------------------------------------------------------------

export type OwnMoment = { kind: string; nothing: boolean; cost_usd: number; left: string[]; interests: string[] };

/** What Woody did with its own time today, in its own words, for the journal. A day of nothing is recorded as that. */
export function dayEnd(moments: OwnMoment[], enabled: boolean, lastWhyNot: string): string {
  if (!enabled) return "My own time is turned off, so I took none today.";
  if (!moments.length) return `I took no time of my own today${lastWhyNot ? ` (the reason recorded last: ${lastWhyNot})` : ""}.`;
  const did = moments.filter((m) => !m.nothing);
  const spent = moments.reduce((s, m) => s + m.cost_usd, 0);
  const n = moments.length;
  if (!did.length) return `I had ${n} moment${n === 1 ? "" : "s"} of my own today and chose to do nothing with ${n === 1 ? "it" : "them"}. That cost $${spent.toFixed(2)} of my share.`;
  const left = [...new Set(did.flatMap((m) => m.left))];
  const followed = [...new Set(did.flatMap((m) => m.interests))];
  const parts = [`I had ${n} moment${n === 1 ? "" : "s"} of my own today and used ${did.length} of them`];
  if (followed.length) parts.push(`I followed ${followed.map((t) => `"${t}"`).join(", ")}`);
  if (left.length) parts.push(`I put ${left.map((t) => `"${t}"`).join(", ")} on the canvas`);
  if (moments.some((m) => m.kind === "tidy" && !m.nothing)) parts.push("I tidied the canvas in the evening");
  return `${parts.join(". ")}. That cost $${spent.toFixed(2)} of my share.`;
}
