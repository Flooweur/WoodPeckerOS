// The rules of the canvas store. They run in the build: a failure stops it.
import assert from "node:assert/strict";
import crypto from "node:crypto";
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

test("an explainer keeps the study it explains and the pages that were read", () => {
  const { canvas } = fresh();
  const study = {
    id: 3,
    subject: "How tides work",
    sources: [
      { url: "https://example.org/tides", title: "Tides\u0007 explained" },
      { url: "http://plain.example/", title: "not https" },
      { url: "javascript:alert(1)", title: "not an address" },
      { url: "https://other.net/moon?x=1", title: 7 },
      "nonsense",
    ],
  };
  const made = canvas.make("woody", { title: "Tides", source: CLOCK, study });
  assert.deepEqual(made.study, { id: 3, subject: "How tides work", sources: [{ url: "https://example.org/tides", title: "Tides  explained" }, { url: "https://other.net/moon?x=1", title: "" }] });
  // It stays with the thing, whatever is changed in it later.
  canvas.change("woody", { id: made.id, source: CLOCK.replace("clock", "tides") });
  assert.equal(canvas.get(made.id).study?.sources.length, 2);
  // Nothing malformed is kept, and the operator's own things have no study.
  assert.equal(canvas.make("woody", { title: "No study", source: CLOCK, study: { id: "x", subject: "s", sources: [] } }).study, undefined);
  assert.equal(canvas.make("you", { title: "Mine", source: CLOCK, study }).study, undefined);
  const many = canvas.make("woody", { title: "Many", source: CLOCK, study: { id: 4, subject: "s", sources: Array.from({ length: 500 }, (_, i) => ({ url: `https://example.org/${i}`, title: "" })) } });
  assert.equal(many.study!.sources.length, 200);
});

test("pictures from the web: kept as the executor converted them, shown only by the thing they were given to", () => {
  const { canvas } = fresh();
  // The smallest file that says it is WebP; its name is its own fingerprint.
  const bytes = Buffer.concat([Buffer.from("RIFF"), Buffer.from([4, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(18)]);
  const id = `p-${crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`;
  const picture = { id, base64: bytes.toString("base64"), source: "https://example.org/tides.png", width: 640, height: 480, about: "A diagram of the two tidal bulges." };
  assert.throws(() => canvas.putPicture("you", picture), /not from a screen/);
  assert.throws(() => canvas.putPicture("woody", { ...picture, id: "p-0000000000000000" }), /does not match its name/);
  assert.throws(() => canvas.putPicture("woody", { ...picture, id: "../../etc/passwd" }), /not a picture/);
  assert.throws(() => canvas.putPicture("woody", { ...picture, source: "javascript:alert(1)" }), /address it came from/);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.throws(() => canvas.putPicture("woody", { ...picture, id: `p-${crypto.createHash("sha256").update(png).digest("hex").slice(0, 16)}`, base64: png.toString("base64") }), /only re-encoded WebP/);
  const kept = canvas.putPicture("woody", picture);
  assert.deepEqual([kept.id, kept.source, kept.width, kept.bytes], [id, "https://example.org/tides.png", 640, bytes.length]);
  assert.equal(canvas.pictureList().length, 1);
  canvas.putPicture("woody", picture); // the same picture twice is one picture
  assert.equal(canvas.pictureList().length, 1);

  // A thing is given pictures by their id; an unknown one is refused before anything is made.
  assert.throws(() => canvas.make("woody", { title: "Tides", source: CLOCK, pictures: ["p-ffffffffffffffff"] }), /no picture .* is kept/);
  const before = canvas.list().length;
  const thing = canvas.make("woody", { title: "Tides", source: CLOCK, pictures: [id, id] });
  assert.deepEqual(thing.pictures, [{ id, source: "https://example.org/tides.png" }]);
  assert.equal(canvas.list().length, before + 1);
  const other = canvas.make("woody", { title: "Other", source: CLOCK });
  assert.equal(other.pictures, undefined);
  assert.equal(canvas.make("you", { title: "Mine", source: CLOCK, pictures: [id] }).pictures, undefined);

  // Only the thing it was given to can load it.
  assert.equal(canvas.pictureFor(thing.id, id), `data:image/webp;base64,${bytes.toString("base64")}`);
  assert.throws(() => canvas.pictureFor(other.id, id), /was not given to this thing/);
  assert.throws(() => canvas.pictureFor(thing.id, "../canvas.json"), /was not given to this thing/);
  // A change can give a thing other pictures, or none.
  assert.deepEqual(canvas.change("woody", { id: other.id, source: CLOCK.replace("c", "d"), pictures: [id] }).pictures, [{ id, source: "https://example.org/tides.png" }]);
  assert.equal(canvas.change("woody", { id: other.id, source: CLOCK, pictures: [] }).pictures, undefined);
  assert.equal(canvas.change("woody", { id: thing.id, source: CLOCK.replace("c", "e") }).pictures?.length, 1); // left alone when not mentioned

  // They survive a restart.
  const again = new Canvas(canvas["dir" as keyof Canvas] as unknown as string);
  assert.equal(again.pictureList()[0]!.about, "A diagram of the two tidal bulges.");
  assert.equal(again.pictureFor(thing.id, id).length > 30, true);
});

test("what Woody adds on its own: marked, with a note, within the operator's daily limit", () => {
  const dir = tempDir();
  let now = new Date(2026, 10, 12, 9, 0, 0).getTime();
  const canvas = new Canvas(dir, () => (now += 1000));
  assert.deepEqual(canvas.limits(), { uninvited_per_day: 3, uninvited_today: 0 });

  // Asked for: not uninvited, no note needed, does not count.
  const asked = canvas.make("woody", { title: "Clock", source: CLOCK, why: "you asked" });
  assert.equal(asked.uninvited, undefined);
  // The operator's own things are never uninvited, whatever the request says.
  assert.equal(canvas.make("you", { title: "Mine", source: CLOCK, uninvited: true, note: "x" }).uninvited, undefined);
  assert.equal(canvas.uninvitedToday(), 0);

  // Left for the operator without being asked: it needs a note.
  assert.throws(() => canvas.make("woody", { title: "Tides", source: CLOCK, uninvited: true }), /needs a note/);
  assert.equal(canvas.last()!.refused, "it had no note for the operator");
  const left = canvas.make("woody", { title: "Tides", source: CLOCK, uninvited: true, note: "You mentioned sailing: today's tides.", why: "from my interest in tides" });
  assert.deepEqual([left.uninvited, left.note, left.note_seen], [true, "You mentioned sailing: today's tides.", undefined]);
  assert.equal(canvas.last()!.uninvited, true);
  // Something of its own needs no note, and counts all the same.
  const own = canvas.make("woody", { title: "My notes", source: CLOCK, uninvited: true, for: "woody" });
  assert.equal(own.note, undefined);
  assert.equal(canvas.uninvitedToday(), 2);

  // One that did not start and was taken back does not count.
  canvas.make("woody", { title: "Broken", source: CLOCK, uninvited: true, for: "woody" });
  canvas.takeBack(canvas.last()!.seq, "it did not start");
  assert.equal(canvas.uninvitedToday(), 2);
  // One the operator undid still counts: it did appear on their screen.
  canvas.make("woody", { title: "Third", source: CLOCK, uninvited: true, for: "woody" });
  canvas.undo("you");
  assert.equal(canvas.uninvitedToday(), 3);

  // The limit: refused, recorded, nothing made.
  const before = canvas.list().length;
  assert.throws(() => canvas.mayAdd({ for: "woody" }), /already added 3 things on your own today/);
  assert.throws(() => canvas.make("woody", { title: "Fourth", source: CLOCK, uninvited: true, for: "woody" }), /limit the operator set/);
  assert.equal(canvas.list().length, before);
  assert.match(canvas.last()!.refused ?? "", /today's limit/);
  // Putting back what was taken away is an addition too.
  canvas.remove("woody", { id: own.id, uninvited: true, why: "tidying" });
  assert.equal(canvas.last()!.uninvited, true);
  assert.throws(() => canvas.bringBack("woody", { id: own.id, uninvited: true }), /limit the operator set/);
  // What the operator asks for is never limited.
  assert.equal(canvas.make("woody", { title: "Asked again", source: CLOCK }).removed, false);

  // Only the operator sets the limit, and it survives a restart.
  assert.throws(() => canvas.setLimit("woody", 10), /only the operator/);
  assert.throws(() => canvas.setLimit("you", 99), /whole number from 0 to 20/);
  assert.equal(canvas.setLimit("you", 5).uninvited_per_day, 5);
  assert.equal(canvas.make("woody", { title: "Fourth", source: CLOCK, uninvited: true, for: "woody" }).uninvited, true);
  const again = new Canvas(dir, () => now);
  assert.deepEqual(again.limits(), { uninvited_per_day: 5, uninvited_today: 4 });
  assert.equal(again.get(left.id).note, "You mentioned sailing: today's tides.");

  // The note is read by the operator, not by Woody.
  assert.throws(() => again.seeNote("woody", left.id), /only the operator/);
  assert.equal(again.seeNote("you", left.id).note_seen, true);

  // A new day starts a new count; a limit of none refuses everything uninvited.
  now += 24 * 3_600_000;
  assert.equal(again.uninvitedToday(), 0);
  again.setLimit("you", 0);
  assert.throws(() => again.mayAdd({ for: "woody" }), /limit of uninvited additions to none/);
});
