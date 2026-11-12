// The rules of the canvas store. They run in the build: a failure stops it.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Canvas, CanvasError, LIMITS, THING_POLICY, describe, wrapThing } from "./canvas.js";

const tempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "woody-canvas-"));
const CLOCK = `<div id="c"></div><script>woody.ready()</script>`;

function fresh(): { canvas: Canvas; dir: string } {
  const dir = tempDir();
  let t = 1_000;
  return { canvas: new Canvas(dir, () => (t += 1000)), dir };
}

test("a thing is made, placed where there is room, and survives a restart", () => {
  const { canvas, dir } = fresh();
  const a = canvas.make("woody", { title: "A clock", source: CLOCK, why: "you asked for one" });
  const b = canvas.make("woody", { title: "A note", source: CLOCK });
  assert.equal(a.id, "t1");
  assert.deepEqual([a.version, a.by, a.kind, a.for, a.pinned, a.removed], [1, "woody", "real", "you", false, false]);
  // The second thing does not sit on the first, and neither sits under the lattice.
  const apart = b.box.x >= a.box.x + a.box.w || b.box.y >= a.box.y + a.box.h;
  assert.ok(apart, "things overlap");
  for (const t of [a, b]) assert.ok(t.box.x + t.box.w <= canvas.viewport.w - 820 || t.box.y >= 150, "placed under the lattice");
  assert.equal(canvas.source("t1"), CLOCK);

  const again = new Canvas(dir);
  assert.deepEqual(again.list().map((t) => t.title), ["A clock", "A note"]);
  assert.equal(again.source("t1"), CLOCK);
  assert.equal(again.make("you", { title: "Third", source: CLOCK }).id, "t3"); // ids are never reused
  assert.equal(again.history().length, 3);
});

test("every version is kept, and an earlier one can be shown again", () => {
  const { canvas } = fresh();
  canvas.make("woody", { title: "Clock", source: "one" });
  canvas.change("woody", { id: "t1", source: "two", why: "bigger digits" });
  const third = canvas.change("you", { id: "t1", source: "three", title: "Big clock" });
  assert.deepEqual([third.version, third.title, third.versions.length], [3, "Big clock", 3]);
  assert.deepEqual([canvas.source("t1", 1), canvas.source("t1", 2), canvas.source("t1")], ["one", "two", "three"]);
  const back = canvas.restore("you", { id: "t1", version: 1 });
  assert.equal(back.version, 4); // a restore is a new version: nothing is overwritten
  assert.equal(canvas.source("t1"), "one");
  assert.equal(canvas.source("t1", 3), "three");
  assert.throws(() => canvas.source("t1", 9), CanvasError);
});

test("a pinned thing is out of Woody's reach, and the attempt is recorded", () => {
  const { canvas } = fresh();
  canvas.make("woody", { title: "Clock", source: "one", box: { x: 40, y: 40 } });
  assert.throws(() => canvas.pin("woody", { id: "t1", pinned: true }), /only the operator/);
  canvas.pin("you", { id: "t1", pinned: true });
  for (const attempt of [
    () => canvas.change("woody", { id: "t1", source: "hacked" }),
    () => canvas.place("woody", { id: "t1", box: { x: 900 } }),
    () => canvas.remove("woody", { id: "t1" }),
    () => canvas.restore("woody", { id: "t1", version: 1 }),
    () => canvas.pin("woody", { id: "t1", pinned: false }),
  ]) {
    assert.throws(attempt, CanvasError);
  }
  const thing = canvas.get("t1");
  assert.deepEqual([thing.version, thing.box.x, thing.removed, thing.pinned, canvas.source("t1")], [1, 40, false, true, "one"]);
  const refused = canvas.history().filter((c) => c.refused);
  assert.equal(refused.length, 6);
  assert.ok(refused.every((c) => c.by === "woody"));
  // The operator still can, and once unpinned, so can Woody.
  canvas.place("you", { id: "t1", box: { x: 200 } });
  canvas.pin("you", { id: "t1", pinned: false });
  assert.equal(canvas.change("woody", { id: "t1", source: "two" }).version, 2);
});

test("undo takes back one change at a time, newest first, and only for the operator", () => {
  const { canvas } = fresh();
  canvas.make("woody", { title: "Clock", source: "one", box: { x: 40, y: 40, w: 300, h: 200 } });
  canvas.change("woody", { id: "t1", source: "two", title: "Clock 2" });
  canvas.place("woody", { id: "t1", box: { x: 500, y: 300 } });
  canvas.remove("woody", { id: "t1", why: "tidying" });
  assert.throws(() => canvas.undo("woody"), /only the operator/);

  assert.equal(describe(canvas.undoable()!), 'removed "Clock 2"');
  canvas.undo("you"); // the removal
  assert.equal(canvas.get("t1").removed, false);
  canvas.undo("you"); // the move
  assert.deepEqual([canvas.get("t1").box.x, canvas.get("t1").box.y], [40, 40]);
  canvas.undo("you"); // the change
  assert.deepEqual([canvas.get("t1").version, canvas.get("t1").title, canvas.source("t1")], [1, "Clock", "one"]);
  assert.equal(canvas.get("t1").versions.length, 2); // version 2 is still kept
  canvas.undo("you"); // the making
  assert.equal(canvas.get("t1").removed, true);
  assert.throws(() => canvas.undo("you"), /nothing to undo/);

  // A change made after an undo gets a new version number; nothing is overwritten.
  canvas.bringBack("you", { id: "t1" });
  assert.equal(canvas.change("woody", { id: "t1", source: "three" }).version, 3);
  assert.equal(canvas.source("t1", 2), "two");
});

test("undo state survives a restart", () => {
  const { canvas, dir } = fresh();
  canvas.make("woody", { title: "A", source: "a" });
  canvas.make("woody", { title: "B", source: "b" });
  canvas.undo("you");
  const again = new Canvas(dir);
  assert.equal(describe(again.undoable()!), 'made "A"');
  assert.deepEqual(again.list().map((t) => [t.title, t.removed]), [["A", false], ["B", true]]);
});

test("a change that does not work is taken back, and the record says why", () => {
  const { canvas } = fresh();
  canvas.make("woody", { title: "Clock", source: "one" });
  canvas.change("woody", { id: "t1", source: "broken" });
  canvas.takeBack(canvas.last()!.seq, "it did not start");
  assert.deepEqual([canvas.get("t1").version, canvas.source("t1")], [1, "one"]);
  assert.equal(canvas.get("t1").versions.length, 2); // the broken version is kept for the record
  assert.equal(canvas.history()[0]!.why, 'changed "Clock" (it did not start)');
  canvas.takeBack(canvas.history()[1]!.seq, "again"); // taking back twice does nothing
  assert.equal(canvas.history().length, 3);

  canvas.make("woody", { title: "Never", source: "x" });
  canvas.takeBack(canvas.last()!.seq, "it did not start");
  assert.equal(canvas.get("t2").removed, true);
  // What was taken back is not offered to the operator's undo.
  assert.equal(describe(canvas.undoable()!), 'made "Clock"');
});

test("limits and bad input are refused", () => {
  const { canvas } = fresh();
  assert.throws(() => canvas.make("woody", { title: "", source: "x" }), /title/);
  assert.throws(() => canvas.make("woody", { title: "x", source: "" }), /source/);
  assert.throws(() => canvas.make("woody", { title: "x", source: "a".repeat(LIMITS.source + 1) }), /300 KB/);
  assert.throws(() => canvas.change("woody", { id: "nope", source: "x" }), /no thing/);
  const t = canvas.make("woody", { title: "  spaced\u0001title  ", source: "x", kind: "nonsense", box: { x: -50, y: 1e9, w: 5, h: 99999 } });
  assert.equal(t.title, "spaced title");
  assert.equal(t.kind, "real");
  assert.deepEqual([t.box.x, t.box.y, t.box.w, t.box.h], [0, 20_000, 80, 4000]);
  canvas.setState("t1", { done: [1, 2] });
  assert.deepEqual(canvas.state("t1"), { done: [1, 2] });
  assert.throws(() => canvas.setState("t1", "x".repeat(LIMITS.state)), /256 KB/);
  assert.throws(() => canvas.setState("../etc", 1), /no thing/);
  for (let i = 0; i < LIMITS.things - 1; i++) canvas.make("woody", { title: `n${i}`, source: "x" });
  assert.throws(() => canvas.make("woody", { title: "one too many", source: "x" }), /at most/);
});

test("a thing is served as a sealed document", () => {
  const page = wrapThing("<p>hello</p>");
  assert.ok(page.indexOf("RTCPeerConnection") < page.indexOf("window.woody"), "the WebRTC interfaces go before the bridge");
  assert.ok(page.indexOf("window.woody") < page.indexOf("<p>hello</p>"), "the bridge is defined before the thing's own code");
  for (const rule of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "form-action 'none'", "sandbox allow-scripts"]) {
    assert.ok(THING_POLICY.includes(rule), rule);
  }
  assert.ok(!/allow-same-origin|allow-top-navigation|allow-popups|allow-forms/.test(THING_POLICY));
});
