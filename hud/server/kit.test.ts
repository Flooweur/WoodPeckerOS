// The kit's parts: each builds a thing's source from its values, and refuses
// values that are wrong. Whether each one starts in the sandbox is checked by
// the scripted browser run (hud/dev/check).
import assert from "node:assert/strict";
import { test } from "node:test";
import { CanvasError } from "./canvas.js";
import { KIT, KIT_SAMPLES as SAMPLES, buildPart, kitCatalogue } from "./kit.js";

test("every part builds, and the samples cover the whole kit", () => {
  assert.deepEqual(Object.keys(SAMPLES).sort(), Object.keys(KIT).sort());
  for (const [part, props] of Object.entries(SAMPLES)) {
    const source = buildPart(part, props);
    assert.match(source, /woody\.ready\(\)/, `${part} never says it is ready`);
    assert.doesNotMatch(source, /https?:\/\/(?!www\.w3\.org)/, `${part} refers to the network`);
  }
  assert.equal(kitCatalogue().length, Object.keys(KIT).length);
});

test("values are data: text cannot break out of the part", () => {
  const source = buildPart("note", { title: "x", body: '</script><script>parent.postMessage("got out","*")</script>' });
  // The only script end is the part's own, after the embedded values.
  assert.equal(source.split("</script>").length, 2);
  assert.ok(source.includes("\\u003c/script>"));
});

test("wrong values are refused with a reason", () => {
  const bad: Array<[string, unknown, RegExp]> = [
    ["nope", {}, /no kit part/],
    ["text", {}, /needs "text"/],
    ["text", { text: "x", size: "huge" }, /one of/],
    ["text", { text: "x".repeat(2001) }, /limited/],
    ["list", { items: [] }, /list of texts/],
    ["list", { items: "a,b" }, /list of texts/],
    ["table", { columns: ["a"], rows: "x" }, /rows/],
    ["chart", { feed: "weather" }, /one of/],
    ["clock", { timezone: "Mars/Olympus" }, /time zone/],
    ["picture", { svg: "<img src=x>" }, /<svg>/],
    ["buttons", { buttons: [] }, /one to eight/],
    ["buttons", { buttons: [{ label: "x", event: "rm -rf $(x)" }] }, /short name/],
    ["input", { label: "x" }, /needs "event"/],
    ["note", "not values", /values/],
  ];
  for (const [part, props, reason] of bad) assert.throws(() => buildPart(part, props), (e) => e instanceof CanvasError && reason.test(e.message), `${part} ${JSON.stringify(props)}`);
});
