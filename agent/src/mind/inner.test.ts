// The inner state is a plain function of facts. These tests fix what moves
// each value and check that every value can say why.
import assert from "node:assert/strict";
import { test } from "node:test";
import { innerLines, innerState, type InnerEvent, type InnerFacts } from "./inner.js";

const HOUR = 3_600_000;
const NOON = new Date(2026, 10, 12, 12, 0, 0).getTime();
const quiet = (over: Partial<InnerFacts> = {}): InnerFacts => ({
  now: NOON,
  events: [],
  allowance: { autonomous_usd: 1, daily_usd: 2, exhausted: false },
  failedUnits: [],
  lastPresence: NOON - 5 * 60_000,
  waitingOnOperator: 0,
  newMemories: 0,
  apiBlocked: false,
  ...over,
});
const ev = (hoursAgo: number, kind: string, data: Record<string, unknown> = {}, actor = "woody"): InnerEvent => ({ ts: NOON - hoursAgo * HOUR, kind, actor, data });

test("a quiet day at noon: steady, even, untroubled, with the operator", () => {
  const s = innerState(quiet());
  assert.deepEqual([s.energy.word, s.ease.word, s.unease.word, s.attention.word], ["fresh", "even", "untroubled", "with you"]);
  assert.equal(s.unease.causes.length, 0);
  for (const key of ["energy", "ease", "curiosity", "attention", "unease"] as const) assert.ok(s[key].value >= 0 && s[key].value <= 1);
});

test("energy falls with work done, a spent allowance and the night; the cap empties it", () => {
  const base = innerState(quiet()).energy.value;
  const worked = innerState(quiet({ events: Array.from({ length: 10 }, (_, i) => ev(i * 0.4, "session_end", { source: "goal", tools: ["x"] })) }));
  assert.ok(worked.energy.value < base - 0.2);
  assert.match(worked.energy.causes.map((c) => c.text).join("|"), /10 work sessions in the last six hours/);
  const spent = innerState(quiet({ allowance: { autonomous_usd: 0.1, daily_usd: 2, exhausted: false } }));
  assert.ok(spent.energy.value < base);
  assert.match(spent.energy.causes[0]!.text, /nearly spent/);
  const night = innerState(quiet({ now: new Date(2026, 10, 12, 2, 0, 0).getTime(), lastPresence: 0 }));
  assert.ok(night.energy.causes.some((c) => c.text === "it is night"));
  const capped = innerState(quiet({ allowance: { autonomous_usd: 0, daily_usd: 2, exhausted: true } }));
  assert.ok(capped.energy.value <= 0.1);
  assert.equal(capped.energy.word, "tired");
});

test("ease follows what really happened, and old trouble fades", () => {
  const base = innerState(quiet()).ease.value;
  const rough = innerState(quiet({
    events: [
      ev(1, "session_end", { source: "operator", problem: "The session stopped early (error max turns)", tools: [] }),
      ev(1, "tool_result", { is_error: true }), ev(1, "tool_result", { is_error: true }),
      ev(0.5, "canvas_change", { by: "you", op: "remove", title: "A chart", thing_by: "woody" }),
      ev(0.4, "canvas_change", { by: "you", op: "undo", title: "A clock", undid_by: "woody", thing_by: "woody" }),
      ev(0.3, "canvas_change", { by: "woody", op: "change", title: "A clock", refused: "pinned by the operator", thing_by: "woody" }),
    ],
  }));
  assert.ok(rough.ease.value < base - 0.25);
  const told = rough.ease.causes.map((c) => c.text).join("|");
  assert.match(told, /you undid my change to "A clock"/);
  assert.match(told, /you took "A chart" off the canvas/);
  assert.match(told, /a session stopped early/);

  const good = innerState(quiet({
    events: [
      ev(1, "user_message", { text: "thanks, that is exactly it" }, "operator"),
      ev(1, "canvas_change", { by: "you", op: "pin", pinned: true, title: "A clock", thing_by: "woody" }),
      ev(2, "canvas_change", { by: "woody", op: "make", title: "A clock", thing_by: "woody" }),
      ev(2, "session_end", { source: "operator", problem: null, tools: ["thing_make"] }),
    ],
  }));
  assert.ok(good.ease.value > base + 0.15);
  assert.equal(good.ease.word, "at ease");
  assert.ok(good.ease.causes.some((c) => c.text === 'you pinned "A clock"' && c.effect > 0));

  // The same rough hour, two days later, weighs almost nothing.
  const faded = innerState(quiet({ events: [ev(47, "session_end", { problem: "x", tools: [] }), ev(47, "canvas_change", { by: "you", op: "undo", title: "A clock", undid_by: "woody" })] }));
  assert.ok(Math.abs(faded.ease.value - base) < 0.03);
});

test("attention is about presence, and never about blame", () => {
  const here = innerState(quiet());
  const gone = innerState(quiet({ lastPresence: NOON - 30 * HOUR }));
  assert.ok(here.attention.value > 0.9);
  assert.ok(gone.attention.value < 0.2);
  assert.equal(gone.attention.word, "on my own");
  assert.match(gone.attention.causes[0]!.text, /you were last here/);
  // Absence moves attention only: it must not make Woody uneasy or rattled.
  assert.equal(gone.unease.value, here.unease.value);
  assert.equal(gone.ease.value, here.ease.value);
});

test("unease comes from the machine and from blocked work", () => {
  const s = innerState(quiet({ failedUnits: ["backup.service"], apiBlocked: true, waitingOnOperator: 2, events: [ev(1, "wake", { source: "system" })] }));
  assert.equal(s.unease.word, "uneasy");
  const told = s.unease.causes.map((c) => c.text).join("|");
  assert.match(told, /backup\.service has failed/);
  assert.match(told, /model API is refusing/);
  assert.match(told, /2 things wait for your decision/);
});

test("curiosity rises with what was learned and sinks with empty wake-ups", () => {
  const base = innerState(quiet()).curiosity.value;
  assert.ok(innerState(quiet({ newMemories: 5, events: [ev(3, "session_tainted", { source: "web_fetch" })] })).curiosity.value > base + 0.2);
  const idle = innerState(quiet({ events: Array.from({ length: 6 }, (_, i) => ev(i + 7, "session_end", { source: "goal", tools: [] })) }));
  assert.ok(idle.curiosity.value < base - 0.1);
  assert.match(idle.curiosity.causes[0]!.text, /6 wake-ups today with nothing to do/);
});

test("what Woody is told names every value and its causes, and how to carry it", () => {
  const text = innerLines(innerState(quiet({ failedUnits: ["backup.service"] }))).join("\n");
  for (const name of ["Energy", "Ease", "Curiosity", "Attention to the operator", "Unease"]) assert.ok(text.includes(`- ${name}:`), name);
  assert.match(text, /backup\.service has failed/);
  assert.match(text, /you did not choose it/);
  assert.match(text, /never use it to press the operator/);
});
