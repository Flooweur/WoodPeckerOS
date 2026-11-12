// What things on the canvas may read: the feeds, with stand-ins for the agent
// and the machine.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { FeedError, readFeed, type FeedDeps } from "./feeds.js";
import { Bench, FilesError } from "./files.js";

function deps(): { d: FeedDeps; asked: Array<{ op: string; params: Record<string, unknown> }>; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "woody-feeds-"));
  fs.mkdirSync(path.join(root, "out"));
  const asked: Array<{ op: string; params: Record<string, unknown> }> = [];
  const d: FeedDeps = {
    systemctl: "/nonexistent/systemctl",
    journalctl: "/nonexistent/journalctl",
    bench: new Bench(root),
    askAgent: async (op, params) => {
      asked.push({ op, params });
      if (op === "goals") return { goals: [{ id: 3, title: "Tidy the store", status: "active", next_step: "x".repeat(900), spent_usd: 0.2, budget_usd: 1, updated: 5, dossier: "private working notes", thread_id: 9 }] };
      if (op === "journal") return [{ ts: 1, wake: "I woke.", did: "I looked.", outcome: "Fine.", summary: "", cost_usd: 0.01 }];
      if (op === "memories") return [{ id: 7, kind: "fact", subject: "the operator", statement: "Likes dogs.", origin: "user", confirmed: 2, pinned: 0, sources: [1, 2] }];
      if (op === "conversation") return [{ ts: 4, who: "you", text: "Hello" }];
      return null;
    },
  };
  return { d, asked, root };
}

test("the mind's feeds: asked of the agent, and only what a thing needs is passed on", async () => {
  const { d, asked } = deps();
  const goals = (await readFeed(d, "goals")) as Array<Record<string, unknown>>;
  assert.deepEqual(Object.keys(goals[0]!).sort(), ["budget_usd", "id", "next_step", "spent_usd", "standing", "status", "title", "updated"]);
  assert.equal((goals[0]!.next_step as string).length, 300);
  assert.deepEqual(await readFeed(d, "journal", { n: 500 }), [{ ts: 1, text: "I woke. I looked. Fine.", cost_usd: 0.01 }]);
  assert.deepEqual(asked.find((a) => a.op === "journal")!.params, { n: 50 }, "what a thing asks for is bounded");
  assert.deepEqual(await readFeed(d, "memory", { query: "dogs" }), [{ id: 7, kind: "fact", subject: "the operator", statement: "Likes dogs.", origin: "user", confirmed: 2, pinned: false }]);
  assert.deepEqual(asked.find((a) => a.op === "memories")!.params, { query: "dogs" });
  assert.deepEqual(await readFeed(d, "conversation", {}), [{ ts: 4, who: "you", text: "Hello" }]);
});

test("the workbench's feeds: a list, a text file, a picture; nothing outside the folder", async () => {
  const { d, root } = deps();
  fs.writeFileSync(path.join(root, "out", "numbers.json"), `{"total": 42}`);
  fs.writeFileSync(path.join(root, "out", "dot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  fs.writeFileSync(path.join(root, "out", "chart.svg"), "<svg/>");
  fs.writeFileSync(path.join(root, "out", "blob.bin"), Buffer.from([0, 1, 2]));
  const list = (await readFeed(d, "files")) as { files: Array<{ path: string }> };
  assert.deepEqual(list.files.map((f) => f.path).sort(), ["out/blob.bin", "out/chart.svg", "out/dot.png", "out/numbers.json"]);
  const text = (await readFeed(d, "file", { path: "out/numbers.json" })) as Record<string, unknown>;
  assert.deepEqual([text.mime, text.text, text.base64], ["application/json", `{"total": 42}`, undefined]);
  const picture = (await readFeed(d, "file", { path: "out/dot.png" })) as Record<string, unknown>;
  assert.deepEqual([picture.mime, picture.text, picture.base64], ["image/png", undefined, "iVBORwABAgM="]);
  assert.equal(((await readFeed(d, "file", { path: "out/chart.svg" })) as Record<string, unknown>).mime, "image/svg+xml");
  await assert.rejects(() => readFeed(d, "file", { path: "out/blob.bin" }), /not text or a picture/);
  await assert.rejects(() => readFeed(d, "file", { path: "../../etc/passwd" }), FilesError);
  await assert.rejects(() => readFeed(d, "file", {}), FilesError);
  fs.writeFileSync(path.join(root, "out", "huge.txt"), Buffer.alloc(1024 * 1024 + 1, 65));
  await assert.rejects(() => readFeed(d, "file", { path: "out/huge.txt" }), /too large/);
});

test("a feed that does not exist is named as such, and a machine that does not answer is an error, not a crash", async () => {
  const { d } = deps();
  await assert.rejects(() => readFeed(d, "passwords"), (e) => e instanceof FeedError && /there is no feed "passwords"/.test(e.message));
  await assert.rejects(() => readFeed(d, "services"), FeedError);
  await assert.rejects(() => readFeed(d, "logs", { unit: "x; rm -rf /" }), FeedError);
});
