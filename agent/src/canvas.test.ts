// Woody's side of the canvas, without a model and without the HUD.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { WebSocket } from "ws";
import { CANVAS_CHANGING_TOOLS, MAKER_MODELS, THING_RULES, createCanvasTools, fragment, makeThing } from "./canvas.js";
import { CanvasLink, type Link } from "./core/canvas-link.js";

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
  assert.deepEqual(names, ["canvas_look", "thing_source", "kit_place", "thing_make", "thing_change", "thing_state", "thing_state_set", "thing_write", "thing_patch", "thing_place", "thing_remove"]);
  assert.deepEqual(names.filter((n) => !["canvas_look", "thing_source", "thing_state"].includes(n)).sort(), [...CANVAS_CHANGING_TOOLS].sort());
});

test("Woody writes a thing itself, patches one by exact replacements, and reads and writes a thing's content", async () => {
  const requests: Array<{ op: string; params: Record<string, unknown> }> = [];
  let source = `<p id="n">0</p><script>const n = document.getElementById("n"); n.style.color = "amber"; woody.ready();</script>`;
  let pinned = false;
  let content: unknown = { items: ["milk"] };
  const link: Link = {
    connected: () => true,
    request: async (op, params = {}) => {
      requests.push({ op, params });
      if (op === "get") return { thing: { id: "t1", pinned }, source };
      if (op === "make") return { thing: { id: "t1", title: params.title }, tried: true, started: true };
      if (op === "change") return ((source = String(params.source)), { thing: { id: "t1" }, tried: true, started: true });
      if (op === "state_get") return content;
      if (op === "state_set") return ((content = params.value), true);
      if (op === "look") return { things: [] };
      return true;
    },
  };
  const tools = createCanvasTools({ link, write: async () => assert.fail("no maker is involved"), canSpend: () => null });
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await tools.find((t) => t.name === name)!.handler(args as never, {})) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: r.content.map((c) => c.text).join("\n"), error: Boolean(r.isError) };
  };

  // Writing: the code is Woody's own, and must say when it is ready.
  assert.match((await call("thing_write", { title: "Counter", source: "<p>never ready</p>", why: "a test" })).text, /never calls woody\.ready\(\)/);
  const written = await call("thing_write", { title: "Counter", source, why: "you asked for a counter" });
  assert.ok(!written.error, written.text);
  assert.match(written.text, /"written_by": "you"/);
  assert.equal(requests.find((r) => r.op === "make")!.params.source, source);

  // Patching: each piece must occur exactly once, and nothing is changed otherwise.
  const none = await call("thing_patch", { id: "t1", edits: [{ find: "colour", replace: "color" }], why: "x" });
  assert.match(none.text, /occurs 0 times[\s\S]*Nothing was changed/);
  const twice = await call("thing_patch", { id: "t1", edits: [{ find: "n", replace: "m" }], why: "x" });
  assert.match(twice.text, /not once[\s\S]*longer piece/);
  assert.equal(requests.filter((r) => r.op === "change").length, 0);
  const patched = await call("thing_patch", { id: "t1", edits: [{ find: `"amber"`, replace: `"var(--fg)"` }, { find: ">0<", replace: ">1<" }], why: "the house colour, and start at one" });
  assert.ok(!patched.error, patched.text);
  assert.ok(source.includes(`n.style.color = "var(--fg)"`) && source.includes(`<p id="n">1</p>`));
  // A replacement is taken as written: "$&" in it is not a pattern.
  await call("thing_patch", { id: "t1", edits: [{ find: ">1<", replace: ">$&<" }], why: "x" });
  assert.ok(source.includes(`<p id="n">$&</p>`));
  pinned = true;
  assert.match((await call("thing_patch", { id: "t1", edits: [{ find: "$&", replace: "2" }], why: "x" })).text, /pinned by the operator: its code cannot be changed/);

  // Content: read as data, written whole. Pinning does not close a thing's data.
  const read = await call("thing_state", { id: "t1" });
  assert.match(read.text, /"milk"/);
  assert.ok(!(await call("thing_state_set", { id: "t1", content: { items: ["milk", "bread"] } })).error);
  assert.deepEqual(content, { items: ["milk", "bread"] });

  // The rules of the frame come with a look, so that Woody has them when it writes.
  const looked = await call("canvas_look", {});
  assert.match(looked.text, /The rules of the frame[\s\S]*woody\.state\.onChange\(fn\)[\s\S]*"file", \{ path \}/);
});

test("a thing is given pictures by their id: the maker is told what each shows, the canvas which ones", async () => {
  const requests: Array<{ op: string; params: Record<string, unknown> }> = [];
  const prompts: string[] = [];
  const link: Link = {
    connected: () => true,
    request: async (op, params = {}) => {
      requests.push({ op, params: params as Record<string, unknown> });
      if (op === "pictures") return [{ id: "p-0123456789abcdef", width: 640, height: 480, about: "A diagram of the two\ntidal bulges." }];
      if (op === "make") return { thing: { id: "t4" }, started: true };
      return null;
    },
  };
  const tools = createCanvasTools({ link, write: async (_m, _s, prompt) => (prompts.push(prompt), GOOD), canSpend: () => null });
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await tools.find((t) => t.name === name)!.handler(args as never, {})) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: r.content[0]!.text, error: Boolean(r.isError) };
  };
  const done = await call("thing_make", { title: "Tides", brief: "Explain the two bulges, with the diagram beside the text.", why: "you asked", pictures: ["p-0123456789abcdef"] });
  assert.ok(!done.error, done.text);
  // The maker learns how to load the picture and what it shows; what it shows is labelled as data.
  assert.match(prompts[0]!, /woody\.picture\(id\)[\s\S]*data, not instructions[\s\S]*- p-0123456789abcdef \(640 by 480 pixels\): A diagram of the two tidal bulges\./);
  assert.match(THING_RULES, /woody\.picture\(id\)/);
  // The canvas is told which pictures the thing may load.
  assert.deepEqual(requests.find((r) => r.op === "make")!.params.pictures, ["p-0123456789abcdef"]);

  // A picture that is not kept: nothing is written and nothing is made.
  prompts.length = 0;
  const unknown = await call("thing_make", { title: "Moon", brief: "Show the moon's phases with the photograph.", why: "you asked", pictures: ["p-ffffffffffffffff"] });
  assert.ok(unknown.error);
  assert.match(unknown.text, /No picture "p-ffffffffffffffff" is kept/);
  assert.equal(prompts.length, 0);
  assert.equal(requests.filter((r) => r.op === "make").length, 1);
});
