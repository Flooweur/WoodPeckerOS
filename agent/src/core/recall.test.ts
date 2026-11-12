// Recall by meaning, with a stand-in for the embedding model: a few "concepts",
// each a set of words that mean the same, plus a trace of the text's own
// words. "trip" and "holiday" land close together, as with a real model, and
// two unrelated texts stay apart.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createAgent } from "./agent.js";
import type { Config } from "./config.js";
import { cosine, fuse, nearest, relatedFloor, type Embedder } from "./embed.js";
import { fakeExec } from "./testing.js";

const CONCEPTS = [
  ["trip", "holiday", "vacation", "travel", "voyage", "vacances"],
  ["dog", "puppy", "chien", "pet"],
  ["disk", "storage", "drive", "space"],
  ["coffee", "espresso", "café"],
  ["music", "song", "piano"],
  ["backup", "snapshot", "restore"],
];
const WORD_DIMS = 1024;

function conceptEmbedder(): Embedder & { calls: number; down: boolean } {
  const e = {
    model: "concepts-1",
    calls: 0,
    down: false,
    async embed(texts: string[]) {
      e.calls += 1;
      if (e.down) throw new Error("connection refused");
      return texts.map((t) => {
        const words = t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3);
        const v = new Float32Array(CONCEPTS.length + WORD_DIMS);
        // A clear signal for each concept the text touches...
        CONCEPTS.forEach((c, i) => (v[i] = c.some((w) => words.includes(w)) ? 2 : 0));
        // ...and a trace of its own words, so that every text is somewhat like every other and identical to none.
        for (const w of words) {
          let h = 7;
          for (const ch of w) h = (h * 31 + ch.codePointAt(0)!) % 100_003;
          v[CONCEPTS.length + (h % WORD_DIMS)]! += 0.5;
        }
        v[CONCEPTS.length] = v[CONCEPTS.length]! + 0.3;
        return v;
      });
    },
  };
  return e;
}

function agentWith(embedder?: Embedder) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "woody-recall-"));
  const cfg: Config = { stateDir, workspace: path.join(stateDir, "workspace"), execSocket: "", monthlyCapUsd: 100, perTurnCapUsd: 2, ownShare: 0.25, ownSessionCapUsd: 0.4, pulseMs: 60_000, systemEvery: 2, awayMs: 1, ownModel: "m" };
  return createAgent({ cfg, exec: fakeExec(), hasCredential: () => true, embedder });
}

const FACTS = [
  "The operator spends two weeks in Brittany every August: their holiday.",
  "The operator's puppy is called Moka.",
  "The machine's storage is a 60 GB virtual drive.",
  "The operator drinks espresso, never tea.",
  "The operator plays the piano on Sunday mornings.",
  "A snapshot is taken before every rebuild.",
  "The operator's sister lives in Lyon.",
  "The HUD's port on the host is 7843.",
  "The operator prefers short answers.",
  "The kiosk runs at 28 frames a second.",
  "The operator's desk faces a window.",
  "Woody's day starts at seven.",
];

test("the arithmetic: similarity, what stands out, and merging two rankings", () => {
  const v = (...n: number[]) => Float32Array.from(n);
  assert.ok(Math.abs(cosine(v(1, 0), v(1, 0)) - 1) < 1e-6);
  assert.ok(Math.abs(cosine(v(1, 0), v(0, 1))) < 1e-6);
  assert.equal(cosine(v(1, 0), v(1, 0, 0)), 0, "vectors of different models are not compared");
  assert.deepEqual(nearest(v(1, 0), [], 5), []);
  // Found by both ranks first; then the top of a list.
  assert.deepEqual(fuse([[1, 2, 3], [3, 4]], 2), [3, 1]);
  assert.deepEqual(fuse([[7, 8], []], 5), [7, 8]);
});

test("what counts as related, on similarities as the real model gives them (bge-m3, measured in the VM)", () => {
  const kept = (sims: number[]) => sims.filter((s) => s >= relatedFloor(sims));
  // "Où est-ce que je pars en vacances ?" against twelve memories: one is about the holiday.
  const holiday = [0.521, 0.423, 0.407, 0.4, 0.395, 0.39, 0.38, 0.375, 0.37, 0.36, 0.34, 0.33];
  assert.deepEqual(kept(holiday), [0.521]);
  // "How much disk space is there?": the storage, and nothing else by a clear margin.
  const disk = [0.671, 0.508, 0.473, 0.45, 0.44, 0.43, 0.42, 0.41, 0.39, 0.38, 0.37, 0.35];
  assert.equal(kept(disk)[0], 0.671);
  assert.ok(kept(disk).length <= 2);
  // "the weather on Mars": something is closest, nothing is related.
  const mars = [0.428, 0.419, 0.398, 0.39, 0.385, 0.38, 0.375, 0.37, 0.365, 0.36, 0.345, 0.34];
  assert.deepEqual(kept(mars), []);
  // Two related memories out of four: both are kept, although they are half of the store.
  assert.deepEqual(kept([0.67, 0.65, 0.42, 0.4]), [0.67, 0.65]);
  // Too few to have a background: a fixed floor.
  assert.deepEqual(kept([0.6, 0.5]), [0.6]);
});

test("a memory is found by meaning when the words differ, and by words alone without the model", async () => {
  const embedder = conceptEmbedder();
  const agent = agentWith(embedder);
  for (const statement of FACTS) agent.store.remember({ kind: "fact", statement, origin: "user" });

  // By words, "trip" finds nothing: no memory uses that word.
  assert.deepEqual(agent.store.searchMemories("What did we say about my trip?"), []);
  // Before the memories have vectors, recall is the search by words.
  assert.deepEqual(await agent.recall("What did we say about my trip?"), []);

  // The pulse gives memories their vectors, a few at a time.
  assert.equal(await agent.embedPending(5), 5);
  assert.equal(await agent.embedPending(50), FACTS.length - 5);
  assert.equal(await agent.embedPending(50), 0);

  const found = await agent.recall("What did we say about my trip?");
  assert.deepEqual(found.map((m) => m.statement), [FACTS[0]]);
  const dog = await agent.recall("le chien");
  assert.deepEqual(dog.map((m) => m.statement), [FACTS[1]]);
  // Words still count: a memory found by both comes first.
  const both = await agent.recall("espresso or tea");
  assert.equal(both[0]!.statement, FACTS[3]);
  // Nothing related: nothing is returned, although something is always "closest".
  assert.deepEqual(await agent.recall("weather forecast Mars tomorrow"), []);

  // A corrected memory is found under its new text only, once it has its vector.
  const old = (await agent.recall("holiday"))[0]!;
  agent.store.supersede(old.id, { statement: "The operator now takes their vacation in the Alps, in July.", origin: "user", actor: "operator" });
  await agent.embedPending();
  const now = await agent.recall("trip");
  assert.deepEqual(now.map((m) => m.statement), ["The operator now takes their vacation in the Alps, in July."]);

  // The model is gone: recall falls back to words and never fails.
  embedder.down = true;
  assert.deepEqual(await agent.recall("trip"), []);
  assert.equal((await agent.recall("espresso"))[0]!.statement, FACTS[3]);
  agent.close();

  // No model at all: the same answers as the search by words.
  const plain = agentWith();
  plain.store.remember({ kind: "fact", statement: FACTS[3]!, origin: "user" });
  assert.equal(await plain.embedPending(), 0);
  assert.equal((await plain.recall("espresso"))[0]!.statement, FACTS[3]);
  plain.close();
});
