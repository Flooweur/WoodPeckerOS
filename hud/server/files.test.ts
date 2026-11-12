// The operator's side of the workbench's folder: listing, giving, taking and
// removing files, with nothing trusted about what a program left there.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import type http from "node:http";
import { Bench, FilesError, safeName } from "./files.js";

function bench() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "woody-files-"));
  fs.mkdirSync(path.join(root, "in"));
  fs.mkdirSync(path.join(root, "out"));
  return { root, b: new Bench(root) };
}
const body = (text: string) => Readable.from([Buffer.from(text)]) as unknown as http.IncomingMessage;

test("a given file's name is only a name", () => {
  assert.equal(safeName("holiday.mp4"), "holiday.mp4");
  assert.equal(safeName("../../etc/passwd"), "passwd");
  assert.equal(safeName("C:\\Users\\me\\Photos\\été 2026.jpg"), "été 2026.jpg");
  assert.equal(safeName(".bashrc"), "bashrc");
  assert.equal(safeName("a\u0000b\nc<>.txt"), "abc.txt");
  assert.equal(safeName(""), "file");
  assert.equal(safeName("..."), "file");
  const long = safeName(`${"x".repeat(300)}.tar.gz`);
  assert.ok(long.length <= 150 && long.endsWith(".gz"));
});

test("giving, listing, taking and removing files", async () => {
  const { root, b } = bench();
  const given = await b.receive(body("day,celsius\nmon,11.5\n"), "temperatures.csv");
  assert.deepEqual(given, { path: "in/temperatures.csv", bytes: 21 });
  // The same name again is kept beside the first, not over it.
  assert.equal((await b.receive(body("other"), "temperatures.csv")).path, "in/temperatures (2).csv");
  // A name that tries to leave the folder lands in it.
  assert.equal((await b.receive(body("x"), "../../outside.txt")).path, "in/outside.txt");
  assert.ok(!fs.existsSync(path.join(root, "..", "outside.txt")));
  // Woody left a result.
  fs.mkdirSync(path.join(root, "out", "charts"));
  fs.writeFileSync(path.join(root, "out", "charts", "week.svg"), "<svg/>");
  fs.writeFileSync(path.join(root, ".hidden"), "x");

  const listed = b.list();
  assert.deepEqual(listed.files.map((f) => f.path).sort(), ["in/outside.txt", "in/temperatures (2).csv", "in/temperatures.csv", "out/charts/week.svg"]);
  assert.equal(listed.truncated, false);
  assert.equal(listed.files.find((f) => f.path === "in/temperatures.csv")!.size, 21);

  assert.equal(b.resolve("out/charts/week.svg"), path.join(fs.realpathSync(root), "out", "charts", "week.svg"));
  b.remove("in/outside.txt");
  assert.ok(!fs.existsSync(path.join(root, "in", "outside.txt")));
  // No upload leaves a half-written file behind.
  assert.deepEqual(fs.readdirSync(path.join(root, "in")).filter((n) => n.startsWith(".upload")), []);
});

test("nothing outside the folder can be taken or removed, whatever a program planted in it", () => {
  const { root, b } = bench();
  const secret = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "woody-secret-")), "key.env");
  fs.writeFileSync(secret, "ANTHROPIC_API_KEY=sk-secret");
  const refused = (rel: string, status: number) => assert.throws(() => b.resolve(rel), (e) => e instanceof FilesError && e.status === status, rel);
  refused("../key.env", 403);
  refused("/etc/passwd", 403);
  refused("", 400);
  refused("out", 400);
  refused("out/nothing.txt", 404);
  if (process.platform !== "win32") {
    // A link to a file elsewhere, and a link to a folder elsewhere.
    fs.symlinkSync(secret, path.join(root, "out", "report.txt"));
    fs.symlinkSync(path.dirname(secret), path.join(root, "out", "more"));
    refused("out/report.txt", 403);
    refused("out/more/key.env", 403);
    assert.throws(() => b.remove("out/report.txt"), FilesError);
    assert.equal(fs.readFileSync(secret, "utf8"), "ANTHROPIC_API_KEY=sk-secret");
    // Links are not even listed.
    assert.deepEqual(b.list().files, []);
  }
});

test("a machine without a workbench says so", () => {
  const none = new Bench(path.join(os.tmpdir(), "woody-no-such-bench"));
  assert.equal(none.available, false);
  assert.throws(() => none.list(), (e) => e instanceof FilesError && e.status === 503);
  assert.throws(() => new Bench(undefined).resolve("x"), FilesError);
});
