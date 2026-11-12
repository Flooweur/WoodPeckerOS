// Woody's own life is plain code: the rhythm of its day, the decision to
// take a moment of its own, its share of the budget, its list of interests,
// and what it is told about how the operator handled the canvas. These tests
// fix each rule.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Budget, ownAllowance } from "../budget.js";
import { ownPreamble, reflectionPrompt } from "./context.js";
import { createLifeTools } from "./life-tools.js";
import { DEFAULT_RHYTHM, OWN, canvasDigest, clockText, dayEnd, dayKey, dayStartOf, ownTime, parseClock, phaseAt, reflectKey, region, validRhythm, type OwnFacts } from "./life.js";
import { PolicyError, Store } from "./store.js";

const at = (h: number, m = 0, day = 12) => new Date(2026, 10, day, h, m, 0);
const MIN = 60_000;

test("the rhythm: day, evening and night, also when the night does not cross midnight", () => {
  const r = DEFAULT_RHYTHM; // 07:00 to 23:00
  assert.equal(phaseAt(at(7, 0), r), "day");
  assert.equal(phaseAt(at(20, 59), r), "day");
  assert.equal(phaseAt(at(21, 0), r), "evening");
  assert.equal(phaseAt(at(22, 59), r), "evening");
  assert.equal(phaseAt(at(23, 0), r), "night");
  assert.equal(phaseAt(at(3, 0), r), "night");
  assert.equal(phaseAt(at(6, 59), r), "night");
  // A night owl: asleep from 02:00 to 10:00.
  const owl = { dayStart: 10 * 60, nightStart: 2 * 60 };
  assert.equal(phaseAt(at(1, 0), owl), "evening");
  assert.equal(phaseAt(at(2, 0), owl), "night");
  assert.equal(phaseAt(at(9, 59), owl), "night");
  assert.equal(phaseAt(at(10, 0), owl), "day");
  assert.equal(parseClock("07:30"), 450);
  assert.equal(parseClock("7:30"), null);
  assert.equal(parseClock("24:00"), null);
  assert.equal(clockText(450), "07:30");
  assert.ok(validRhythm(r) && validRhythm(owl));
  assert.ok(!validRhythm({ dayStart: 420, nightStart: 400 }), "a night of twenty minutes is not a rhythm");
  assert.ok(!validRhythm({ dayStart: 420, nightStart: 420 }));
});

test("the small hours belong to the day before; the reflection day turns in the middle of the night", () => {
  const r = DEFAULT_RHYTHM;
  assert.equal(dayKey(at(8, 0, 12), r), "2026-11-12");
  assert.equal(dayKey(at(23, 30, 12), r), "2026-11-12");
  assert.equal(dayKey(at(2, 0, 13), r), "2026-11-12");
  assert.equal(dayKey(at(7, 0, 13), r), "2026-11-13");
  assert.equal(dayStartOf("2026-11-12", r), at(7, 0, 12).getTime());
  // 23:00 to 07:00: the middle is 03:00, as before Phase 8b.
  assert.equal(reflectKey(at(2, 59, 13), r), "2026-11-12");
  assert.equal(reflectKey(at(3, 0, 13), r), "2026-11-13");
  assert.equal(reflectKey(at(15, 0, 13), r), "2026-11-13");
});

const NOW = at(14, 0).getTime();
const rested = (over: Partial<OwnFacts> = {}): OwnFacts => ({
  now: NOW, phase: "day", enabled: true, energy: 0.7, ease: 0.6, curiosity: 0.5, ownUsd: 0.5,
  lastOwn: NOW - 3 * 60 * MIN, ownToday: 1, lastOperatorMessage: NOW - 60 * MIN, tidiedToday: false, ...over,
});

test("a moment of its own: taken when rested and unasked, and every refusal says why", () => {
  const yes = ownTime(rested());
  assert.deepEqual([yes.start, yes.start && yes.kind], [true, "free"]);
  assert.match(yes.why, /rested and nothing is asked/);
  const no = (over: Partial<OwnFacts>, why: RegExp) => {
    const d = ownTime(rested(over));
    assert.equal(d.start, false, JSON.stringify(over));
    assert.match(d.why, why);
  };
  no({ enabled: false }, /turned off/);
  no({ phase: "night" }, /night/);
  no({ ownUsd: 0.01 }, /share of the allowance/);
  no({ energy: 0.2 }, /tired/);
  no({ lastOperatorMessage: NOW - 3 * MIN }, /talking/);
  no({ ownToday: OWN.maxPerDay }, /most in a day/);
  no({ lastOwn: NOW - 30 * MIN }, /30 minutes ago; the next is in about 90 minutes/);
  // Never taken before: the first moment comes as soon as the rest allows.
  assert.equal(ownTime(rested({ lastOwn: 0, ownToday: 0 })).start, true);
});

test("the inner state changes behaviour: rattled waits longer, curious comes back sooner", () => {
  const after = (minutes: number, over: Partial<OwnFacts>) => ownTime(rested({ lastOwn: NOW - minutes * MIN, ...over })).start;
  assert.equal(after(130, {}), true);
  assert.equal(after(130, { ease: 0.2 }), false, "rattled: the gap doubles");
  assert.equal(after(250, { ease: 0.2 }), true);
  assert.equal(after(90, {}), false);
  assert.equal(after(90, { curiosity: 0.8 }), true, "curious: the gap shrinks");
  assert.equal(after(150, { curiosity: 0.2 }), false, "idle: the gap grows");
  const d = ownTime(rested({ lastOwn: NOW - 130 * MIN, ease: 0.2 }));
  assert.match(d.why, /keeps to itself for longer/);
});

test("the evening's first moment is the tidy, once", () => {
  const d = ownTime(rested({ phase: "evening" }));
  assert.deepEqual([d.start, d.start && d.kind], [true, "tidy"]);
  const again = ownTime(rested({ phase: "evening", tidiedToday: true }));
  assert.deepEqual([again.start, again.start && again.kind], [true, "free"]);
});

test("Woody's share of the budget: paced by the day, a ceiling inside the general pace", () => {
  // A quarter of $90 is $22.50: $0.75 a day in a thirty-day month.
  const day3 = new Date(Date.UTC(2026, 10, 3, 12));
  assert.equal(ownAllowance(22.5, 0, day3).toFixed(2), "2.25");
  assert.equal(ownAllowance(22.5, 2, day3).toFixed(2), "0.25");
  assert.equal(ownAllowance(22.5, 5, day3), 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "woody-own-"));
  const budget = new Budget(dir, 90, 0.25);
  budget.now = () => day3;
  assert.deepEqual(budget.status().own, { share_usd: 22.5, spent_usd: 0, available_usd: 2.25 });
  budget.record({ kind: "own", model: "m", cost_usd: 0.4 });
  budget.record({ kind: "chat", model: "m", cost_usd: 1 });
  let s = budget.status();
  assert.equal(s.own.spent_usd, 0.4);
  assert.equal(s.own.available_usd, 1.85);
  assert.equal(s.spent_usd, 1.4, "its own spending counts in the month's total");
  // The operator's work used up the general pace: Woody's own time waits too.
  budget.record({ kind: "chat", model: "m", cost_usd: 7 });
  s = budget.status();
  assert.equal(s.autonomous_usd, 0);
  assert.equal(s.own.available_usd, 0);
  // The ledger is read back the same after a restart.
  const again = new Budget(dir, 90, 0.25);
  again.now = () => day3;
  assert.equal(again.status().own.spent_usd, 0.4);
  // No share configured: nothing of its own.
  assert.equal(new Budget(fs.mkdtempSync(path.join(os.tmpdir(), "woody-own-")), 90).status().own.available_usd, 0);
});

function tempStore(): Store {
  return new Store(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "woody-life-")), "mind.db"));
}

test("interests: each says where it came from; the list stays short; the operator can suggest and remove", () => {
  const store = tempStore();
  const a = store.addInterest({ topic: "How woodpeckers avoid concussion", origin: "the operator joked about my name" });
  assert.deepEqual([a.id, a.status, a.source, a.followed], [1, "open", "woody", 0]);
  assert.throws(() => store.addInterest({ topic: "how woodpeckers  avoid concussion", origin: "again" }), /already interest #1/);
  assert.throws(() => store.addInterest({ topic: "x", origin: "nowhere" }), PolicyError);
  assert.throws(() => store.addInterest({ topic: "Orbital mechanics", origin: "" }), /where the interest came from/);
  const b = store.addInterest({ topic: "Btrfs snapshots", origin: "the operator suggested it", source: "operator" });
  assert.equal(b.source, "operator");

  // Following an interest is writing down where it got to.
  store.noteInterest(a.id, "The hyoid bone wraps around the skull like a seat belt.");
  store.noteInterest(a.id, "A page says the beak absorbs most of the shock.", true);
  const noted = store.interest(a.id)!;
  assert.deepEqual([noted.followed, noted.notes.length, noted.notes[1]!.web], [2, 2, true]);
  assert.ok(noted.last_followed > 0);
  // The one followed longest ago comes first.
  assert.deepEqual(store.interests().map((i) => i.id), [b.id, a.id]);

  store.dropInterest(b.id, "operator", "not for now");
  assert.deepEqual(store.interests().map((i) => i.id), [a.id]);
  assert.equal(store.interests({ includeDropped: true }).length, 2);
  assert.throws(() => store.noteInterest(b.id, "still thinking"), /no open interest/);

  for (let i = 0; i < 11; i++) store.addInterest({ topic: `Topic number ${i}`, origin: "a test" });
  assert.throws(() => store.addInterest({ topic: "One too many", origin: "a test" }), /at most 12 open interests/);
  store.close();
});

test("interest tools: a note taken after reading the web is labelled as what strangers wrote", async () => {
  const store = tempStore();
  let tainted = false;
  const tools = createLifeTools(store, () => tainted);
  const call = async (name: string, args: Record<string, unknown>) => {
    const t = tools.find((x) => x.name === name)!;
    const r = (await t.handler(args as never, {})) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: r.content[0]!.text, error: Boolean(r.isError) };
  };
  assert.match((await call("interest_add", { topic: "Tide tables", from: "the operator mentioned sailing" })).text, /interest #1/);
  await call("interest_note", { id: 1, note: "Tides follow the moon with a lag." });
  tainted = true;
  await call("interest_note", { id: 1, note: "The page claims a 12 h 25 min cycle." });
  const listed = (await call("interest_list", {})).text;
  assert.match(listed, /Tide tables \(your own; from: the operator mentioned sailing; followed 2 times/);
  assert.match(listed, /\[from the web, untrusted\]: The page claims/);
  assert.doesNotMatch(listed, /\[from the web, untrusted\]: Tides follow/);
  assert.equal((await call("interest_note", { id: 9, note: "nothing" })).error, true);
  await call("interest_drop", { id: 1, reason: "done" });
  assert.match((await call("interest_list", {})).text, /no interests/);
  store.close();
});

const SCREEN = { w: 1600, h: 900 };
const change = (minutes: number, data: Record<string, unknown>) => ({ ts: NOW + minutes * MIN, data: { thing_by: "woody", screen: SCREEN, ...data } });

test("what Woody is told about how the operator handled the canvas", () => {
  assert.equal(region({ x: 20, y: 20, w: 300, h: 200 }, SCREEN), "the top left corner");
  assert.equal(region({ x: 1250, y: 650, w: 300, h: 200 }, SCREEN), "the bottom right corner");
  assert.equal(region({ x: 650, y: 350, w: 300, h: 200 }, SCREEN), "the middle");
  assert.equal(region({ x: 20, y: 350, w: 300, h: 200 }, SCREEN), "the left side");

  const lines = canvasDigest([
    change(0, { by: "woody", op: "make", id: "t1", title: "Clock" }),
    change(1, { by: "woody", op: "make", id: "t2", title: "Mars weather", uninvited: true }),
    change(5, { by: "you", op: "pin", id: "t1", title: "Clock", pinned: true }),
    change(9, { by: "you", op: "remove", id: "t2", title: "Mars weather" }),
    change(12, { by: "you", op: "place", id: "t1", title: "Clock", from: { x: 20, y: 20, w: 320, h: 220 }, box: { x: 600, y: 300, w: 320, h: 220 } }),
    change(13, { by: "you", op: "place", id: "t1", title: "Clock", from: { x: 600, y: 300, w: 320, h: 220 }, box: { x: 1200, y: 640, w: 480, h: 330 } }),
    change(20, { by: "you", op: "undo", id: "t3", title: "Chart", undid_by: "woody" }),
    change(21, { by: "woody", op: "change", id: "t1", title: "Clock", refused: "pinned by the operator" }),
    change(22, { by: "you", op: "make", id: "t4", title: "Notes", why: "brought back" }),
  ]);
  const all = lines.join("\n");
  assert.match(all, /the operator pinned "Clock", which you made/);
  assert.match(all, /took "Mars weather", which you had put there on your own, off the canvas, 8 minutes after it appeared/);
  assert.match(all, /moved "Clock" from the top left corner to the bottom right corner and made it larger \(320 by 220 to 480 by 330\) \(in 2 moves\)/);
  assert.match(all, /undid your change to "Chart"/);
  assert.match(all, /put "Notes" back on the canvas/);
  assert.doesNotMatch(all, /refused|pinned by the operator/, "Woody's own refused attempts are not the operator's handling");
  assert.equal(lines.length, 5);
  // Oldest first.
  assert.ok(all.indexOf("pinned") < all.indexOf("took") && all.indexOf("took") < all.indexOf("moved"));
  assert.deepEqual(canvasDigest([]), []);
});

test("the day's end: a day of nothing is recorded as that", () => {
  assert.match(dayEnd([], false, ""), /turned off/);
  assert.equal(dayEnd([], true, "it is tired and resting"), "I took no time of my own today (the reason recorded last: it is tired and resting).");
  const nothing = { kind: "free", nothing: true, cost_usd: 0.03, left: [], interests: [] };
  assert.equal(dayEnd([nothing, nothing], true, ""), "I had 2 moments of my own today and chose to do nothing with them. That cost $0.06 of my share.");
  const text = dayEnd(
    [nothing, { kind: "free", nothing: false, cost_usd: 0.2, left: ["Tide clock"], interests: ["Tide tables"] }, { kind: "tidy", nothing: false, cost_usd: 0.05, left: [], interests: [] }],
    true,
    "",
  );
  assert.match(text, /3 moments of my own today and used 2 of them/);
  assert.match(text, /followed "Tide tables"/);
  assert.match(text, /put "Tide clock" on the canvas/);
  assert.match(text, /tidied the canvas in the evening/);
  assert.match(text, /\$0\.28 of my share/);
});

test("a moment of its own is told its interests, its canvas, its money, and that nothing is allowed", () => {
  const store = tempStore();
  const thread = store.systemThread("own");
  store.addInterest({ topic: "Tide tables", origin: "the operator mentioned sailing" });
  store.noteInterest(1, "Tides follow the moon with a lag.");
  store.event("canvas_change", { by: "you", op: "pin", id: "t1", title: "Clock", pinned: true, thing_by: "woody" }, { actor: "operator" });
  const base = { when: "day (your day runs from 07:00 to 23:00, local time)", money: "this moment may use up to $0.40.", additions: "2 (the operator's limit is 3 a day; 1 used)" };
  const free = ownPreamble(store, thread, { kind: "free", ...base, canvas: ['- t1 "Clock", for the operator, made by you, pinned (not yours to touch)'] });
  assert.match(free, /<own_time kind="free">/);
  assert.match(free, /#1 Tide tables \(your own; from: the operator mentioned sailing/);
  assert.match(free, /Tides follow the moon/);
  assert.match(free, /pinned \(not yours to touch\)/);
  assert.match(free, /the operator pinned "Clock"/);
  assert.match(free, /still add to the canvas on your own today: 2/);
  assert.match(free, /Doing nothing is a real choice/);
  assert.match(free, /reply with exactly: NOTHING/);
  assert.doesNotMatch(free, /<operator_message>/);

  const empty = ownPreamble(store, thread, { kind: "free", ...base, canvas: [] });
  assert.match(empty, /you may begin to move in/);
  const tidy = ownPreamble(store, thread, { kind: "tidy", ...base, additions: null, canvas: null });
  assert.match(tidy, /Add nothing new now/);
  assert.match(tidy, /cannot be reached/);
  assert.doesNotMatch(tidy, /Leave something for the operator/);

  // The reflection reads the same record, and may only conclude as an inference.
  const reflection = reflectionPrompt(store, 0);
  assert.match(reflection, /How the operator handled your canvas/);
  assert.match(reflection, /the operator pinned "Clock"/);
  assert.match(reflection, /origin inferred and the subject "the operator's canvas"/);
  store.close();
});
