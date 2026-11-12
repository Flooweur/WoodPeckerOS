// Woody's side of the canvas, without a model and without the HUD.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { WebSocket } from "ws";
import { CANVAS_CHANGING_TOOLS, CanvasLink, MAKER_MODELS, THING_RULES, createCanvasTools, fragment, makeThing, type Link } from "./canvas.js";

const GOOD = "<p>hi</p><script>woody.ready()</script>";
const noLink: Link = { connected: () => true, request: async () => null };

test("the maker's reply is used with or without a code fence", () => {
  assert.equal(fragment(GOOD), GOOD);
  assert.equal(fragment("```html\n" + GOOD + "\n```"), GOOD);
  assert.equal(fragment("  \n" + GOOD + "\n"), GOOD);
});

test("a thing that starts is made once, by the model its effort names", async () => {
  const calls: Array<{ model: string; prompt: string }> = [];
  const made = await makeThing(
    { link: noLink, write: async (model, system, prompt) => (calls.push({ model, prompt }), assert.equal(system, THING_RULES), GOOD) },
    { brief: "Title: Clock\nA clock that runs backwards.", effort: "small", size: "400 by 300" },
    async (source) => ({ thing: { id: "t1" }, started: true, source }),
  );
  assert.deepEqual([made.ok, made.ok && made.model, made.attempts], [true, MAKER_MODELS.small, 1]);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.prompt, /Make this thing\.[\s\S]*runs backwards[\s\S]*400 by 300 pixels/);
});

test("a thing that does not start gets one more attempt, by a stronger model that is shown what went wrong", async () => {
  const calls: Array<{ model: string; prompt: string }> = [];
  let sends = 0;
  const made = await makeThing(
    { link: noLink, write: async (model, _s, prompt) => (calls.push({ model, prompt }), calls.length === 1 ? GOOD.replace("hi", "first") : GOOD) },
    { brief: "A chart.", effort: "normal" },
    async () => {
      if (++sends === 1) throw new Error("It did not start, so the canvas is as it was before. What went wrong: x is not defined (line 3)");
      return { started: true };
    },
  );
  assert.deepEqual([made.ok, made.ok && made.model, made.attempts], [true, MAKER_MODELS.hard, 2]);
  assert.deepEqual(calls.map((c) => c.model), [MAKER_MODELS.normal, MAKER_MODELS.hard]);
  assert.match(calls[1]!.prompt, /did not start[\s\S]*x is not defined[\s\S]*<attempt>[\s\S]*first/);
});

test("what never says it is ready is not even sent", async () => {
  let sends = 0;
  const made = await makeThing({ link: noLink, write: async () => "<p>no bridge call</p>" }, { brief: "x", effort: "small" }, async () => (sends++, {}));
  assert.equal(made.ok, false);
  assert.equal(sends, 0);
  assert.match(made.ok ? "" : made.error, /Two attempts[\s\S]*woody\.ready/);
});

test("a refusal that is not about starting is final: no second attempt", async () => {
  let writes = 0;
  for (const refusal of ["thing t1 is pinned by the operator: it cannot be changed, moved or removed", "paused-by-operator: the canvas is not changed while the operator has paused you"]) {
    writes = 0;
    const made = await makeThing({ link: noLink, write: async () => (writes++, GOOD) }, { brief: "x", effort: "normal" }, async () => {
      throw new Error(refusal);
    });
    assert.deepEqual([made.ok, made.attempts, writes], [false, 1, 1]);
    assert.equal(made.ok ? "" : made.error, refusal);
  }
});

test("a change is written from the thing's current source", async () => {
  let prompt = "";
  await makeThing({ link: noLink, write: async (_m, _s, p) => ((prompt = p), GOOD) }, { brief: "Make the digits bigger.", effort: "small" }, async () => ({}), "<p>old source</p>");
  assert.match(prompt, /current source:\n<source>\n<p>old source<\/p>\n<\/source>[\s\S]*complete new source[\s\S]*digits bigger/);
});

test("the link: a request is answered, refused, or fails when the HUD goes away", async () => {
  const link = new CanvasLink();
  await assert.rejects(link.request("look"), /not connected/);

  const sent: Array<Record<string, unknown>> = [];
  const ws = Object.assign(new EventEmitter(), { readyState: 1, send: (text: string) => sent.push(JSON.parse(text)) });
  link.attach(ws as unknown as WebSocket);
  assert.equal(link.connected(), true);

  const answered = link.request("get", { id: "t2" });
  assert.deepEqual([sent[0]!.type, sent[0]!.op, sent[0]!.id], ["canvas_request", "get", "t2"]);
  link.reply({ rid: sent[0]!.rid, ok: true, result: { source: "x" } });
  assert.deepEqual(await answered, { source: "x" });

  const refused = link.request("remove", { id: "t2" });
  link.reply({ rid: sent[1]!.rid, ok: false, error: "pinned by the operator" });
  await assert.rejects(refused, /pinned by the operator/);

  const lost = link.request("look");
  ws.emit("close");
  await assert.rejects(lost, /went away/);
  assert.equal(link.connected(), false);
});

test("the tools exist, and the ones that change the canvas are the ones a web-reading session loses", () => {
  const tools = createCanvasTools({ link: noLink, write: async () => GOOD, canSpend: () => null });
  const names = tools.map((t) => t.name);
  assert.deepEqual(names, ["canvas_look", "thing_source", "kit_place", "thing_make", "thing_change", "thing_place", "thing_remove"]);
  assert.deepEqual(names.filter((n) => !["canvas_look", "thing_source"].includes(n)).sort(), [...CANVAS_CHANGING_TOOLS].sort());
});
