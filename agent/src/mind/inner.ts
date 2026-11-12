// Woody's inner state: five slow values, computed by plain code from what
// really happened. The model does not choose them and cannot change them by
// wishing. Each value keeps the list of its causes, so that "why are you like
// this today?" has a true answer.
//
// What they are not: a claim to human feeling, a random mood, or a lever on
// the operator. They colour Woody's tone and how much it takes on.

export type Cause = { text: string; effect: number };
export type Feeling = { value: number; word: string; causes: Cause[] };
export type Inner = { at: number; energy: Feeling; ease: Feeling; curiosity: Feeling; attention: Feeling; unease: Feeling };

export type InnerEvent = { ts: number; kind: string; actor: string; data: Record<string, unknown> };
export type InnerFacts = {
  now: number;
  /** The record of the last two days: sessions, tool results, messages, wake-ups, canvas changes. */
  events: InnerEvent[];
  allowance: { autonomous_usd: number; daily_usd: number; exhausted: boolean };
  failedUnits: string[];
  /** When someone was last at the screen (0 if never). */
  lastPresence: number;
  /** Requests and questions waiting for the operator. */
  waitingOnOperator: number;
  /** Memories stored in the last two days. */
  newMemories: number;
  /** The model API is refusing requests. */
  apiBlocked: boolean;
  /** It is night in Woody's rhythm. Left out, the night is taken to run from 23:00 to 07:00. */
  night?: boolean;
  /** Interests open on Woody's list, and how many of them it followed in the last two days. */
  interests?: { open: number; followed: number };
};

const HOUR = 3_600_000;
const clamp = (v: number) => Math.min(1, Math.max(0, v));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function ago(now: number, ts: number): string {
  const m = Math.max(0, Math.round((now - ts) / 60_000));
  if (m < 2) return "just now";
  if (m < 90) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  return h < 36 ? `${h} hours ago` : `${Math.round(h / 24)} days ago`;
}

/** Builds one value from a base and its causes. Causes too small to matter are dropped from the list. */
function feeling(base: number, causes: Array<Cause & { keep?: boolean }>, words: [string, string, string], cap?: number): Feeling {
  let value = clamp(base + causes.reduce((sum, c) => sum + c.effect, 0));
  if (cap !== undefined) value = Math.min(value, cap);
  const told = causes.filter((c) => c.keep || Math.abs(c.effect) >= 0.02).sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect)).slice(0, 5);
  return { value: Number(value.toFixed(2)), word: value < 0.34 ? words[0] : value > 0.66 ? words[2] : words[1], causes: told.map((c) => ({ text: c.text, effect: Number(c.effect.toFixed(2)) })) };
}

export function innerState(f: InnerFacts): Inner {
  const { now, events } = f;
  /** How much something still weighs: half as much after each half-life. */
  const weight = (ts: number, halfLifeHours: number) => 0.5 ** ((now - ts) / (halfLifeHours * HOUR));
  const within = (hours: number) => events.filter((e) => now - e.ts <= hours * HOUR);
  const sessions = events.filter((e) => e.kind === "session_end");
  const hour = new Date(now).getHours();
  const night = f.night ?? (hour >= 23 || hour < 7);

  // ---- energy: what is left to work with, and how much was just spent ----
  const energy: Cause[] = [];
  const share = f.allowance.daily_usd > 0 ? Math.min(1, f.allowance.autonomous_usd / f.allowance.daily_usd) : 0;
  energy.push({ text: share < 0.25 ? "today's allowance is nearly spent" : share > 0.75 ? "there is allowance to spare" : "about half of today's allowance is left", effect: (share - 0.5) * 0.5 });
  const recent = sessions.filter((e) => now - e.ts <= 6 * HOUR).length;
  if (recent) energy.push({ text: `${plural(recent, "work session")} in the last six hours`, effect: -0.35 * Math.min(1, recent / 12) });
  const lastSession = sessions.reduce((latest, e) => Math.max(latest, e.ts), 0);
  if (lastSession && now - lastSession >= HOUR) energy.push({ text: `rested since ${ago(now, lastSession)}`, effect: Math.min(0.15, 0.05 * ((now - lastSession) / HOUR)) });
  if (night) energy.push({ text: "it is night", effect: -0.15 });
  if (f.allowance.exhausted) energy.push({ text: "the month's spending cap is reached", effect: -0.6 });

  // ---- ease: how things have been going ----
  const ease: Cause[] = [];
  const add = (list: Cause[], text: string, effect: number) => {
    const same = list.find((c) => c.text === text);
    if (same) same.effect += effect;
    else list.push({ text, effect });
  };
  let fine = 0;
  let toolErrors = 0;
  for (const e of events) {
    const d = e.data;
    const w = weight(e.ts, 12);
    switch (e.kind) {
      case "session_end":
        if (d.problem) add(ease, "a session stopped early", -0.12 * w);
        else fine += 0.02 * w;
        break;
      case "tool_result":
        if (d.is_error) toolErrors += 0.03 * w;
        break;
      case "api_error":
        add(ease, "the model API refused a request", -0.15 * w);
        break;
      case "interrupted_by_restart":
        add(ease, "I was restarted in the middle of something", -0.08 * w);
        break;
      case "identity_restored":
        add(ease, "you put my identity back to an earlier version", -0.1 * w);
        break;
      case "user_message":
        if (/\b(thanks|thank you|thx|merci|well done|nice|bravo)\b/i.test(String(d.text ?? ""))) add(ease, "you thanked me", 0.15 * w);
        break;
      case "canvas_change": {
        const title = `"${String(d.title ?? "a thing")}"`;
        const mine = d.thing_by === "woody";
        if (d.by === "woody" && d.refused) add(ease, `I was refused on ${title}: ${String(d.refused)}`, -0.05 * w);
        else if (d.by === "you" && d.op === "remove" && mine && d.thing_uninvited === true) add(ease, `you took away ${title}, which I had put there on my own`, -0.12 * w);
        else if (d.by === "woody" && d.op === "undo") add(ease, `${title} did not start and was taken back`, -0.06 * w);
        else if (d.by === "woody" && (d.op === "make" || d.op === "change")) add(ease, "things I made started and stayed", 0.03 * w);
        else if (d.by === "you" && d.op === "remove" && mine) add(ease, `you took ${title} off the canvas`, -0.08 * w);
        else if (d.by === "you" && d.op === "undo" && d.undid_by === "woody") add(ease, `you undid my change to ${title}`, -0.1 * w);
        else if (d.by === "you" && d.op === "pin" && d.pinned && mine) add(ease, `you pinned ${title}`, 0.1 * w);
        break;
      }
    }
  }
  if (fine) ease.push({ text: "recent work went through without trouble", effect: Math.min(0.2, fine) });
  if (toolErrors) ease.push({ text: "some of my tool calls failed", effect: -Math.min(0.25, toolErrors) });

  // ---- curiosity: something new to chew on, or only routine ----
  const curiosity: Cause[] = [];
  if (f.newMemories) curiosity.push({ text: `${plural(f.newMemories, "new thing")} learned in the last two days`, effect: Math.min(0.25, 0.04 * f.newMemories) });
  if (f.interests?.followed) curiosity.push({ text: `I followed ${plural(f.interests.followed, "interest")} of my own lately`, effect: Math.min(0.15, 0.06 * f.interests.followed) });
  else if (f.interests?.open) curiosity.push({ text: `${plural(f.interests.open, "interest")} on my list that I have not followed lately`, effect: Math.min(0.1, 0.03 * f.interests.open) });
  const read = events.filter((e) => e.kind === "session_tainted").reduce((s, e) => s + 0.08 * weight(e.ts, 24), 0);
  if (read) curiosity.push({ text: "I have been reading the web", effect: Math.min(0.2, read) });
  const quiet = within(24).filter((e) => e.kind === "session_end" && e.data.source !== "operator" && Array.isArray(e.data.tools) && e.data.tools.length === 0).length;
  if (quiet) curiosity.push({ text: `${plural(quiet, "wake-up")} today with nothing to do`, effect: -Math.min(0.2, 0.03 * quiet) });
  const talked = within(6).filter((e) => e.kind === "user_message").length;
  if (talked) curiosity.push({ text: "you gave me things to think about", effect: Math.min(0.15, 0.03 * talked) });

  // ---- attention: how present the operator is ----
  // The presence line is always told, however little it weighs: it is the reason for a low value too.
  const attention: Array<Cause & { keep?: boolean }> = [];
  const away = f.lastPresence ? (now - f.lastPresence) / HOUR : 48;
  attention.push({
    text: !f.lastPresence ? "nobody has been at the screen yet" : away < 0.25 ? "you are here" : `you were last here ${ago(now, f.lastPresence)}`,
    effect: 0.85 * 0.5 ** (away / 4),
    keep: true,
  });
  if (talked) attention.push({ text: `we spoke ${plural(talked, "time")} in the last six hours`, effect: Math.min(0.15, 0.03 * talked) });

  // ---- unease: something is wrong on the machine, or with me ----
  const unease: Cause[] = [];
  if (f.failedUnits.length) unease.push({ text: `${f.failedUnits.slice(0, 3).join(", ")} ${f.failedUnits.length === 1 ? "has" : "have"} failed`, effect: Math.min(0.5, 0.2 + 0.1 * (f.failedUnits.length - 1)) });
  if (f.apiBlocked) unease.push({ text: "the model API is refusing requests", effect: 0.3 });
  const alarms = events.filter((e) => e.kind === "wake" && e.data.source === "system").reduce((s, e) => s + 0.08 * weight(e.ts, 12), 0);
  if (alarms) unease.push({ text: "the system woke me about a problem", effect: Math.min(0.3, alarms) });
  const restarts = events.filter((e) => e.kind === "interrupted_by_restart").reduce((s, e) => s + 0.1 * weight(e.ts, 12), 0);
  if (restarts) unease.push({ text: "I was restarted in the middle of something", effect: Math.min(0.2, restarts) });
  if (f.waitingOnOperator) unease.push({ text: `${plural(f.waitingOnOperator, "thing")} wait${f.waitingOnOperator === 1 ? "s" : ""} for your decision`, effect: Math.min(0.15, 0.05 * f.waitingOnOperator) });

  return {
    at: now,
    energy: feeling(0.75, energy, ["tired", "steady", "fresh"], f.allowance.exhausted ? 0.1 : undefined),
    ease: feeling(0.6, ease, ["rattled", "even", "at ease"]),
    curiosity: feeling(0.45, curiosity, ["idle", "interested", "eager"]),
    attention: feeling(0.15, attention, ["on my own", "aware of you", "with you"]),
    unease: feeling(0.05, unease, ["untroubled", "watchful", "uneasy"]),
  };
}

const NAMES: Array<[keyof Omit<Inner, "at">, string]> = [
  ["energy", "Energy"], ["ease", "Ease"], ["curiosity", "Curiosity"], ["attention", "Attention to the operator"], ["unease", "Unease"],
];

/** The state as Woody is told it, at the start of each session. */
export function innerLines(inner: Inner): string[] {
  return [
    "How you are right now. The system computed this from the record of what happened; you did not choose it and cannot change it by wishing:",
    ...NAMES.map(([key, name]) => {
      const f = inner[key];
      return `- ${name}: ${f.word} (${f.value.toFixed(2)})${f.causes.length ? `. Because: ${f.causes.slice(0, 3).map((c) => c.text).join("; ")}` : ""}.`;
    }),
    "Let it colour your tone and how much you take on. Do not announce it unprompted, never use it to press the operator, and if they ask why you are like this, give these true causes.",
  ];
}
