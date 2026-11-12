// What Woody may change about itself: its identity, by small steps, and the
// designs of its lattice. The limits are plain code; these tests fix each one.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { briefPreamble, reflectionPrompt, systemPrompt } from "./context.js";
import { innerState } from "./inner.js";
import { createSelfTools } from "./self-tools.js";
import { BUILTIN, FACE, IDENTITY, RESERVED, changedShare, checkDesign, nameProblem, remainingShare, words } from "./self.js";
import { INITIAL_IDENTITY, PolicyError, Store } from "./store.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function tempStore(): Store {
  return new Store(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "woody-self-")), "mind.db"));
}

/** A store whose clock the test moves. */
function clocked(): { store: Store; pass: (ms: number) => void } {
  const store = tempStore();
  let now = new Date(2026, 10, 12, 3, 0, 0).getTime();
  store.now = () => now;
  return { store, pass: (ms) => (now += ms) };
}

const row = (lit: string) => lit.padEnd(8, ".");
const blank = Array.from({ length: 8 }, () => "........");
const dot = [...blank.slice(0, 3), row("...99"), row("...99"), ...blank.slice(5)];

test("the size of a step is measured in words, whatever the punctuation or the case", () => {
  assert.deepEqual(words("You are warm, and never at THEIR expense."), ["you", "are", "warm", "and", "never", "at", "their", "expense"]);
  assert.equal(changedShare("one two three four", "one two three four"), 0);
  assert.equal(changedShare("One two, three four.", "one two three four"), 0);
  assert.equal(changedShare("one two three four", "one two three five"), 0.25);
  assert.equal(changedShare("one two three four", "five six seven eight"), 1);
  // Adding counts too: a text a third longer has changed by a quarter.
  assert.equal(changedShare("a b c", "a b c d"), 0.25);
  assert.equal(remainingShare("one two three four", "one two three four and more"), 1);
  assert.equal(remainingShare("one two three four", "one two"), 0.5);
  assert.equal(remainingShare("one two three four", "four three two one"), 0.25); // order matters
});

test("identity: Woody changes it itself, by one small step a day, and the operator is shown", () => {
  const { store, pass } = clocked();
  assert.equal(store.identityAnchor().author, "initial");
  assert.equal(store.identityState().blocked, null);
  assert.equal(store.identityState().remaining, 1);

  const step = `${INITIAL_IDENTITY}\n\nWith this operator you keep answers short.`;
  assert.throws(() => store.changeIdentity(step, "short"), /what you observed/);
  assert.throws(() => store.changeIdentity(INITIAL_IDENTITY, "Nothing changed, really."), /already your identity/);
  // A rewrite is refused, with the measure.
  assert.throws(
    () => store.changeIdentity("You are a stern machine that answers in one word and never explains anything to anyone at all, whatever is asked.", "I want to be different."),
    /changes \d+% of the words; one step may change at most 25%/,
  );
  assert.equal(store.identity().version, 1);

  const v2 = store.changeIdentity(step, "They asked for shorter answers three times this week.");
  assert.equal(v2.version, 2);
  assert.equal(v2.author, "woody");
  assert.equal(v2.seen, false);
  assert.equal(store.identity().text, step);
  assert.deepEqual(store.identityState().unseen, [2]);
  // The new text is what the next session is given, after the rules.
  const system = systemPrompt("RULES FIRST", store);
  assert.ok(system.indexOf("RULES FIRST") < system.indexOf("you keep answers short"));

  // One step a day.
  assert.throws(() => store.changeIdentity(`${step} You like trains.`, "They talked about trains all day."), /one step a day/);
  pass(IDENTITY.hoursBetween * HOUR + 1);
  assert.equal(store.changeIdentity(`${step} You like trains.`, "They talked about trains all day.").version, 3);

  // The operator looks: the notice goes.
  store.seeIdentity();
  assert.deepEqual(store.identityState().unseen, []);
  const events = store.recentEvents(["identity_changed"], 5);
  assert.equal(events.length, 2);
  assert.equal(events[0]!.data.from, 2);
});

test("identity: the operator restores any version in one action, and Woody then leaves it alone for a while", () => {
  const { store, pass } = clocked();
  const step = `${INITIAL_IDENTITY}\n\nWith this operator you keep answers short.`;
  store.changeIdentity(step, "They asked for shorter answers three times this week.");
  const back = store.restoreIdentity(1);
  assert.equal(back.version, 3); // a new version: nothing is lost
  assert.equal(back.author, "operator");
  assert.equal(store.identity().text, INITIAL_IDENTITY);
  assert.deepEqual(store.identityState().unseen, []);
  assert.match(back.note, /version 1 restored by the operator/);
  assert.throws(() => store.restoreIdentity(3), /current version/);
  assert.throws(() => store.restoreIdentity(99), /no identity version/);
  // Their restore is their answer: no change for three days, even a day later.
  pass(DAY + HOUR);
  assert.match(store.identityState().blocked!, /the operator set your identity themselves/);
  assert.throws(() => store.changeIdentity(step, "They asked for shorter answers again."), /leave it as they put it for 3 days/);
  pass(IDENTITY.quietDaysAfterOperator * DAY);
  assert.equal(store.identityState().blocked, null);
  // The restore weighs on Woody's ease, as a named cause.
  const inner = innerState({
    now: store.now(),
    events: store.eventsSince(0, ["identity_restored"]).map((e) => ({ ...e, ts: store.now() - HOUR })),
    allowance: { daily_usd: 3, autonomous_usd: 3, exhausted: false },
    failedUnits: [],
    lastPresence: 0,
    waitingOnOperator: 0,
    newMemories: 0,
    apiBlocked: false,
  });
  assert.ok(inner.ease.causes.some((c) => /put my identity back/.test(c.text) && c.effect < 0));
});

test("identity: far from the first version, changes wait for the operator; they can also switch them off", () => {
  const { store, pass } = clocked();
  // Drift away one small step a day, replacing the text sentence by sentence.
  const target = "You are a careful archivist of this machine. You weigh each claim against the record before you speak. You prefer a short true sentence to a long clever one. You keep a quiet humour for the moments that earn it. You say what you checked and what you only assume. You treat the operator's time as the scarce thing it is, and their goals as yours to carry.".split(" ");
  let text = INITIAL_IDENTITY;
  let steps = 0;
  while (!store.identityState().paused && steps < 40) {
    // Replace the next few words of the current text with words of the target.
    const cur = text.split(/\s+/);
    const at = steps * 10;
    const next = [...cur.slice(0, at), ...target.slice(at, at + 10), ...cur.slice(at + 10)].join(" ");
    text = store.changeIdentity(next, "A slow drift, for the test of the anchor.").text;
    steps += 1;
    pass(IDENTITY.hoursBetween * HOUR + 1);
  }
  const state = store.identityState();
  assert.ok(state.paused, "less than half of the first version remains");
  assert.ok(state.remaining < IDENTITY.anchorFloor);
  assert.ok(steps >= 4, `the drift took several days (${steps})`);
  assert.throws(() => store.changeIdentity(`${text} And more.`, "One more step, please."), /less than half of your first identity remains/);
  // The operator looks and lets it continue.
  store.continueIdentity();
  assert.equal(store.identityState().paused, false);
  const further = store.changeIdentity(`${text} And more.`, "One more step, after they looked.");
  // Restoring the first version re-arms the pause for the next drift.
  store.restoreIdentity(1);
  assert.equal(store.getMeta("identity_drift_ok"), null);
  assert.ok(further.version > 1);

  // The switch.
  pass(10 * DAY);
  store.freezeIdentity(true);
  assert.match(store.identityState().blocked!, /switched off/);
  assert.throws(() => store.changeIdentity(`${INITIAL_IDENTITY} You like trains.`, "They talked about trains."), /switched off/);
  store.freezeIdentity(false);
  assert.equal(store.identityState().blocked, null);
});

test("identity_change works only in the reflection, and the reflection and the brief say where the identity stands", async () => {
  const { store, pass } = clocked();
  let reflecting = false;
  const tools = createSelfTools(store, { reflecting: () => reflecting, express: () => null, faceChanged: () => {} });
  const call = async (name: string, args: Record<string, unknown>) => {
    const t = tools.find((x) => x.name === name)!;
    const r = (await t.handler(args as never, {})) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: r.content[0]!.text, error: Boolean(r.isError) };
  };
  const step = `${INITIAL_IDENTITY}\n\nWith this operator you keep answers short.`;
  const args = { text: step, reason: "They asked for shorter answers three times this week." };
  const outside = await call("identity_change", args);
  assert.ok(outside.error);
  assert.match(outside.text, /only be changed during your daily reflection/);
  assert.equal(store.identity().version, 1);

  const before = reflectionPrompt(store, store.now() - DAY);
  assert.match(before, /version 1 of your identity; 100% of the first version's words remain/);
  assert.match(before, /You may change it in this reflection, by one small step/);
  assert.match(before, /identity_change/);
  assert.doesNotMatch(before, /identity_propose/);

  reflecting = true;
  const done = await call("identity_change", args);
  assert.ok(!done.error, done.text);
  assert.match(done.text, /now version 2/);
  const after = reflectionPrompt(store, store.now() - DAY);
  assert.match(after, /You may not change it in this reflection: you already changed it/);
  assert.match(after, /version 2, .* by you: They asked for shorter answers/);

  // The next brief tells the operator.
  pass(HOUR);
  const brief = briefPreamble(store, store.mainThread(), "daily", store.now() - DAY, "$1 of $100");
  assert.match(brief, /You changed your identity in this period:\n- version 2/);
  assert.match(brief, /put the earlier one back/);
  // After the operator restores, the reflection says so.
  store.restoreIdentity(1);
  assert.match(reflectionPrompt(store, store.now() - DAY), /by the operator \(version 1 restored by the operator\)/);
});

test("a lattice design is a flip book, checked cell by cell", () => {
  const good = checkDesign({ colour: "green", fade: true, repeat: 2, frames: [{ rows: dot, ms: 400 }, { rows: blank, ms: 400 }] }, "expression");
  assert.ok("design" in good);
  assert.deepEqual("design" in good && good.design, { colour: "green", fade: true, repeat: 2, frames: [{ rows: dot, ms: 400 }, { rows: blank, ms: 400 }] });
  // Defaults, and a state always loops.
  const state = checkDesign({ frames: [{ rows: dot.map((r) => r.replaceAll("9", "0").replace("00", "05")), ms: 900 }], repeat: 3 }, "state");
  assert.ok("design" in state && state.design.colour === "amber" && state.design.repeat === 1 && !state.design.fade);
  assert.ok("design" in state && state.design.frames[0]!.rows[3] === "....5...", "0 is dark, like a dot");

  const bad = (d: unknown, kind: "state" | "moment" | "expression" = "expression") => {
    const r = checkDesign(d, kind);
    assert.ok("error" in r, JSON.stringify(d).slice(0, 80));
    return "error" in r ? r.error : "";
  };
  assert.match(bad(null), /an object with frames/);
  assert.match(bad({ colour: "red", frames: [{ rows: dot, ms: 400 }] }), /red is the frame's/);
  assert.match(bad({ colour: "#ff0000", frames: [{ rows: dot, ms: 400 }] }), /one of: amber/);
  assert.match(bad({ frames: [] }), /1 to 16 frames/);
  assert.match(bad({ frames: Array.from({ length: 17 }, () => ({ rows: dot, ms: 100 })) }), /1 to 16 frames/);
  assert.match(bad({ frames: [{ rows: dot.slice(1), ms: 400 }] }), /8 strings/);
  assert.match(bad({ frames: [{ rows: [...dot.slice(0, 7), "#......."], ms: 400 }] }), /8 characters/);
  assert.match(bad({ frames: [{ rows: [...dot.slice(0, 7), "<b>....."], ms: 400 }] }), /8 characters/);
  assert.match(bad({ frames: [{ rows: dot, ms: 20 }] }), /ms must be between 80 and 5000/);
  assert.match(bad({ frames: [{ rows: blank, ms: 400 }] }), /at least one cell must be lit/);
  assert.match(bad({ repeat: 9, frames: [{ rows: dot, ms: 400 }] }), /repeat/);
  assert.match(bad({ repeat: 4, frames: [{ rows: dot, ms: 3000 }] }), /at most 8000 ms/);
  assert.match(bad({ frames: [{ rows: dot, ms: 100 }] }), /too short/);
  // A state may be one still picture, or long.
  assert.ok("design" in checkDesign({ frames: [{ rows: dot, ms: 100 }] }, "state"));

  assert.equal(nameProblem("shrug"), null);
  assert.match(nameProblem("Shrug")!, /lowercase/);
  for (const name of RESERVED) assert.match(nameProblem(name)!, /frame's own signals/);
  for (const name of Object.keys(BUILTIN)) assert.equal(nameProblem(name), null);
});

test("the lattice: Woody redraws a design, invents expressions, and every version can be put back", () => {
  const store = tempStore();
  const design = { colour: "blue", frames: [{ rows: dot, ms: 600 }, { rows: blank, ms: 600 }] };
  assert.equal(store.faceVersion(), 0);
  assert.equal(store.face().length, Object.keys(BUILTIN).length);
  assert.ok(store.face().every((f) => f.builtin && f.design === null));

  const resting = store.setFace({ name: "resting", design, reason: "A slower, cooler rest." });
  assert.equal(resting.kind, "state");
  assert.equal(resting.design!.colour, "blue");
  assert.ok(store.faceVersion() > 0);
  // The frame's signals cannot be redrawn, by any name.
  assert.throws(() => store.setFace({ name: "paused", design, reason: "Prettier bars." }), /frame's own signals/);
  assert.throws(() => store.setFace({ name: "waiting", design, reason: "x y z" }), PolicyError);
  assert.throws(() => store.setFace({ name: "resting", design: { ...design, colour: "red" }, reason: "Red rest." }), /not accepted: the colour/);

  // An invented expression needs to say what it expresses.
  assert.throws(() => store.setFace({ name: "shrug", design, reason: "New." }), /needs 'about'/);
  const shrug = store.setFace({ name: "shrug", about: "I do not know, and it is fine", design: { ...design, repeat: 2 }, reason: "I had no way to show it." });
  assert.equal(shrug.kind, "expression");
  assert.equal(shrug.builtin, false);
  assert.equal(store.face().length, Object.keys(BUILTIN).length + 1);
  for (let i = 0; i < FACE.maxInvented - 1; i++) store.setFace({ name: `mine-${i}`, about: "one more of my own", design, reason: "Filling up." });
  assert.throws(() => store.setFace({ name: "one-too-many", about: "one more of my own", design, reason: "Too many." }), /which is the most/);

  // Redrawn again, then the operator goes back to the first drawing, then to the built-in one.
  const first = store.face().find((f) => f.name === "resting")!.version!;
  store.setFace({ name: "resting", design: { ...design, colour: "violet" }, reason: "Violet, on reflection." });
  assert.equal(store.face().find((f) => f.name === "resting")!.design!.colour, "violet");
  assert.equal(store.restoreFace("resting", first).design!.colour, "blue");
  assert.equal(store.faceHistory("resting")[0]!.actor, "operator");
  store.resetFace("resting", "put back by the operator", "operator");
  assert.equal(store.face().find((f) => f.name === "resting")!.design, null);
  assert.throws(() => store.resetFace("resting", ""), /already has its built-in design/);
  assert.equal(store.faceHistory("resting").length, 4);
  // Removing an invented one frees its place; the operator can bring it back.
  const old = store.face().find((f) => f.name === "shrug")!.version!;
  store.resetFace("shrug", "It never fitted.");
  assert.ok(!store.face().some((f) => f.name === "shrug"));
  assert.equal(store.restoreFace("shrug", old).about, "I do not know, and it is fine");
  assert.equal(store.recentEvents(["face_changed", "face_reset"], 100).filter((e) => e.data.name === "resting").length, 4);
});

test("the face tools: list, draw, reset and express", async () => {
  const store = tempStore();
  const shown: string[] = [];
  let changed = 0;
  const tools = createSelfTools(store, {
    reflecting: () => false,
    express: (name) => (store.face().some((f) => f.name === name && f.kind === "expression") ? (shown.push(name), null) : `"${name}" is not one of your expressions (see face_list).`),
    faceChanged: () => (changed += 1),
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const t = tools.find((x) => x.name === name)!;
    const r = (await t.handler(args as never, {})) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: r.content[0]!.text, error: Boolean(r.isError) };
  };
  const list = await call("face_list", {});
  assert.match(list.text, /- resting: while nothing is asked of you \[built-in: four centre cells breathing\]/);
  assert.match(list.text, /You have invented no expression yet/);
  assert.match(list.text, /cannot redraw: waiting, paused/);

  const design = { colour: "white", fade: true, frames: [{ rows: dot, ms: 700 }, { rows: blank, ms: 700 }] };
  const drawn = await call("face_design", { name: "resting", design, reason: "Calmer." });
  assert.ok(!drawn.error, drawn.text);
  assert.equal(changed, 1);
  const refused = await call("face_design", { name: "paused", design, reason: "Prettier." });
  assert.ok(refused.error);
  assert.equal(changed, 1);
  const one = await call("face_list", { name: "resting" });
  assert.match(one.text, /Drawn by you \(version \d+: Calmer\.\)\. Colour white, fading:/);
  assert.match(one.text, /frame 1 \(700 ms\)\n {4}\.{8}/);

  await call("face_design", { name: "shrug", about: "I do not know, and it is fine", design, reason: "I had no way to show it." });
  assert.match((await call("face_list", {})).text, /Expressions you invented:\n- shrug: I do not know, and it is fine \[yours\]/);
  assert.ok(!(await call("express", { name: "shrug" })).error);
  assert.ok((await call("express", { name: "nonsense" })).error);
  assert.deepEqual(shown, ["shrug"]);
  assert.ok(!(await call("face_reset", { name: "resting" })).error);
  assert.match((await call("face_list", { name: "resting" })).text, /Built-in design, drawn by the frame/);
});

test("an older store gains the new columns and keeps its identity versions", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "woody-self-")), "mind.db");
  const first = new Store(file);
  const p = first.proposeIdentity(`${INITIAL_IDENTITY}\n\nYou keep answers short.`, "They asked for it, under the old rule.");
  first.decideIdentity(p.id, true);
  first.setMeta("schema_version", "7");
  first.close();
  const again = new Store(file);
  assert.equal(again.getMeta("schema_version"), "9");
  const history = again.identityHistory();
  assert.deepEqual(history.map((v) => v.author), ["woody", "initial"]);
  assert.ok(history.every((v) => v.seen));
  // The version approved under the old rule counts as Woody's step for that day.
  assert.match(again.identityState().blocked!, /one step a day/);
  again.close();
});
