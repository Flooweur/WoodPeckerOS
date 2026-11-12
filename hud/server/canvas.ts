// The canvas store: the things on Woody's canvas, their versions, where they
// sit, what is pinned, and the record of every change with its undo.
//
// The gateway owns this store, not the agent. Woody asks for changes through
// the gateway; the operator makes them from the frame. That is what lets the
// rules here hold whatever Woody does:
//  * a pinned thing cannot be changed, moved or removed by Woody;
//  * only the operator pins, unpins and undoes;
//  * every change is recorded with who made it and why, and can be undone;
//  * no version of a thing is ever deleted.
//
// On disk, under <dir>:
//   canvas.json            the things (without their source) and counters
//   things/<id>/v<N>.html  the source of each version
//   things/<id>/state.json the thing's own saved state
//   changes.jsonl          one line per change, append-only
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type Actor = "woody" | "you";
export type Box = { x: number; y: number; w: number; h: number; z: number };
export type Version = { v: number; ts: number; by: Actor; why: string; bytes: number };
export type Thing = {
  id: string;
  title: string;
  /** "pretend" things show invented content and carry a mark the thing cannot remove. */
  kind: "real" | "pretend";
  /** Who it is for: something made for the operator, or something of Woody's own. */
  for: "you" | "woody";
  by: Actor;
  why: string;
  created: number;
  /** The version being shown. Not always the newest: undo steps back. */
  version: number;
  versions: Version[];
  box: Box;
  pinned: boolean;
  removed: boolean;
};
export type Change = {
  seq: number;
  ts: number;
  by: Actor;
  op: "make" | "change" | "place" | "remove" | "restore" | "pin" | "undo";
  id: string;
  title: string;
  why: string;
  /** Set when the change was not applied: why not. */
  refused?: string;
  /** What undoing this change puts back. */
  before?: Partial<Pick<Thing, "version" | "title" | "box" | "pinned" | "removed">>;
  /** For an undo: the change it undid. */
  of?: number;
};

export class CanvasError extends Error {}

export const LIMITS = { source: 300_000, state: 256_000, things: 80, title: 80, why: 400, versions: 500 };
const DEFAULT_SIZE = { w: 320, h: 220 };
const GAP = 16;

const clamp = (n: unknown, lo: number, hi: number, fallback: number): number => {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : fallback;
  return Math.min(hi, Math.max(lo, v));
};
const text = (v: unknown, max: number): string => (typeof v === "string" ? v : "").replace(/[\u0000-\u0008\u000b-\u001f]/g, " ").trim().slice(0, max);

export class Canvas {
  private things: Thing[] = [];
  private changes: Change[] = [];
  private undone = new Set<number>();
  private nextId = 1;
  private nextSeq = 1;
  /** The size of the screen that last reported it; used to place new things. */
  viewport = { w: 1600, h: 900 };

  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {
    fs.mkdirSync(path.join(dir, "things"), { recursive: true });
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(dir, "canvas.json"), "utf8"));
      this.things = Array.isArray(saved.things) ? saved.things : [];
      this.nextId = Number(saved.next_id) || 1;
      this.nextSeq = Number(saved.next_seq) || 1;
    } catch {
      // first start
    }
    try {
      for (const line of fs.readFileSync(path.join(dir, "changes.jsonl"), "utf8").split("\n")) {
        if (!line.trim()) continue;
        const c = JSON.parse(line) as Change;
        this.changes.push(c);
        if (c.op === "undo" && typeof c.of === "number") this.undone.add(c.of);
      }
      this.changes = this.changes.slice(-2000);
    } catch {
      // no changes yet
    }
  }

  // ---- reading -------------------------------------------------------------

  private find(id: unknown): Thing {
    const thing = this.things.find((t) => t.id === id);
    if (!thing) throw new CanvasError(`there is no thing ${String(id)}`);
    return thing;
  }

  get(id: string): Thing {
    return structuredClone(this.find(id));
  }

  /** Things on the canvas, then the ones put away (newest first, at most thirty). */
  list(): Thing[] {
    const away = this.things.filter((t) => t.removed).slice(-30).reverse();
    return structuredClone([...this.things.filter((t) => !t.removed), ...away]);
  }

  source(id: string, version?: number): string {
    const thing = this.find(id);
    const v = version ?? thing.version;
    if (!thing.versions.some((x) => x.v === v)) throw new CanvasError(`thing ${id} has no version ${v}`);
    return fs.readFileSync(path.join(this.dir, "things", id, `v${v}.html`), "utf8");
  }

  state(id: string): unknown {
    this.find(id);
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, "things", id, "state.json"), "utf8"));
    } catch {
      return null;
    }
  }

  /** A thing's own saved state. Not a change: it is not recorded and not undone. */
  setState(id: string, value: unknown): void {
    this.find(id);
    const body = JSON.stringify(value ?? null);
    if (body.length > LIMITS.state) throw new CanvasError("a thing's saved state is limited to 256 KB");
    this.write(path.join("things", id, "state.json"), body);
  }

  /** The latest changes, newest first. */
  history(n = 100): Array<Change & { undone: boolean }> {
    return this.changes.slice(-n).reverse().map((c) => ({ ...c, undone: this.undone.has(c.seq) }));
  }

  /** The change that undo would take back, if any. */
  undoable(): Change | null {
    for (let i = this.changes.length - 1; i >= 0; i--) {
      const c = this.changes[i]!;
      if (c.op !== "undo" && !c.refused && c.before && !this.undone.has(c.seq)) return c;
    }
    return null;
  }

  // ---- changing ------------------------------------------------------------

  make(by: Actor, input: { title?: unknown; source?: unknown; kind?: unknown; for?: unknown; why?: unknown; box?: Partial<Box> }): Thing {
    const source = this.checkSource(input.source);
    const title = text(input.title, LIMITS.title);
    if (!title) throw new CanvasError("a thing needs a title");
    if (this.things.filter((t) => !t.removed).length >= LIMITS.things) throw new CanvasError(`the canvas holds at most ${LIMITS.things} things; remove one first`);
    const id = `t${this.nextId++}`;
    const ts = this.now();
    const why = text(input.why, LIMITS.why);
    const thing: Thing = {
      id,
      title,
      kind: input.kind === "pretend" ? "pretend" : "real",
      for: input.for === "woody" ? "woody" : "you",
      by,
      why,
      created: ts,
      version: 1,
      versions: [{ v: 1, ts, by, why, bytes: Buffer.byteLength(source) }],
      box: this.boxFor(input.box),
      pinned: false,
      removed: false,
    };
    fs.mkdirSync(path.join(this.dir, "things", id), { recursive: true });
    this.write(path.join("things", id, "v1.html"), source);
    this.things.push(thing);
    this.record({ by, op: "make", id, title, why, before: { removed: true } });
    return structuredClone(thing);
  }

  /** A new version of a thing's source, and optionally a new title. */
  change(by: Actor, input: { id?: unknown; source?: unknown; title?: unknown; why?: unknown }): Thing {
    const thing = this.find(input.id);
    const why = text(input.why, LIMITS.why);
    this.guard(by, thing, "change", why);
    const before = { version: thing.version, title: thing.title };
    if (input.source !== undefined) {
      const source = this.checkSource(input.source);
      if (thing.versions.length >= LIMITS.versions) throw new CanvasError(`thing ${thing.id} has reached ${LIMITS.versions} versions`);
      const v = Math.max(...thing.versions.map((x) => x.v)) + 1;
      this.write(path.join("things", thing.id, `v${v}.html`), source);
      thing.versions.push({ v, ts: this.now(), by, why, bytes: Buffer.byteLength(source) });
      thing.version = v;
    }
    const title = text(input.title, LIMITS.title);
    if (title) thing.title = title;
    this.record({ by, op: "change", id: thing.id, title: thing.title, why, before });
    return structuredClone(thing);
  }

  /** Show an earlier version again. It becomes a new version, so nothing is lost. */
  restore(by: Actor, input: { id?: unknown; version?: unknown; why?: unknown }): Thing {
    const thing = this.find(input.id);
    const source = this.source(thing.id, Number(input.version));
    const why = text(input.why, LIMITS.why) || `back to version ${Number(input.version)}`;
    this.guard(by, thing, "restore", why);
    const before = { version: thing.version, title: thing.title };
    const v = Math.max(...thing.versions.map((x) => x.v)) + 1;
    this.write(path.join("things", thing.id, `v${v}.html`), source);
    thing.versions.push({ v, ts: this.now(), by, why, bytes: Buffer.byteLength(source) });
    thing.version = v;
    this.record({ by, op: "restore", id: thing.id, title: thing.title, why, before });
    return structuredClone(thing);
  }

  /** Move, resize or raise a thing. */
  place(by: Actor, input: { id?: unknown; box?: Partial<Box>; raise?: unknown; why?: unknown }): Thing {
    const thing = this.find(input.id);
    const why = text(input.why, LIMITS.why);
    this.guard(by, thing, "place", why);
    const before = { box: { ...thing.box } };
    const b = input.box ?? {};
    thing.box = {
      x: clamp(b.x, 0, 20_000, thing.box.x),
      y: clamp(b.y, 0, 20_000, thing.box.y),
      w: clamp(b.w, 80, 4000, thing.box.w),
      h: clamp(b.h, 60, 4000, thing.box.h),
      z: input.raise ? this.topZ() + 1 : thing.box.z,
    };
    this.record({ by, op: "place", id: thing.id, title: thing.title, why, before });
    return structuredClone(thing);
  }

  /** Take a thing off the canvas. It is kept, with all its versions. */
  remove(by: Actor, input: { id?: unknown; why?: unknown }): Thing {
    const thing = this.find(input.id);
    const why = text(input.why, LIMITS.why);
    this.guard(by, thing, "remove", why);
    if (thing.removed) throw new CanvasError(`thing ${thing.id} is already off the canvas`);
    thing.removed = true;
    this.record({ by, op: "remove", id: thing.id, title: thing.title, why, before: { removed: false } });
    return structuredClone(thing);
  }

  /** Put a removed thing back. */
  bringBack(by: Actor, input: { id?: unknown; why?: unknown }): Thing {
    const thing = this.find(input.id);
    if (!thing.removed) throw new CanvasError(`thing ${thing.id} is on the canvas`);
    if (this.things.filter((t) => !t.removed).length >= LIMITS.things) throw new CanvasError(`the canvas holds at most ${LIMITS.things} things; remove one first`);
    thing.removed = false;
    thing.box.z = this.topZ() + 1;
    this.record({ by, op: "make", id: thing.id, title: thing.title, why: text(input.why, LIMITS.why) || "brought back", before: { removed: true } });
    return structuredClone(thing);
  }

  /** Only the operator pins. A pinned thing is out of Woody's reach. */
  pin(by: Actor, input: { id?: unknown; pinned?: unknown }): Thing {
    const thing = this.find(input.id);
    if (by !== "you") {
      this.record({ by, op: "pin", id: thing.id, title: thing.title, why: "", refused: "only the operator pins and unpins" });
      throw new CanvasError("only the operator pins and unpins");
    }
    const before = { pinned: thing.pinned };
    thing.pinned = Boolean(input.pinned);
    this.record({ by, op: "pin", id: thing.id, title: thing.title, why: thing.pinned ? "pinned" : "unpinned", before });
    return structuredClone(thing);
  }

  /** Take back the latest change that has not been taken back. Operator only. */
  undo(by: Actor): Change {
    if (by !== "you") throw new CanvasError("only the operator undoes");
    const change = this.undoable();
    if (!change) throw new CanvasError("there is nothing to undo");
    const thing = this.putBack(change);
    this.record({ by, op: "undo", id: thing.id, title: thing.title, why: describe(change), of: change.seq });
    return change;
  }

  /** The change recorded last. */
  last(): Change | null {
    return this.changes[this.changes.length - 1] ?? null;
  }

  /**
   * Takes back one change because what it made does not work (a thing that
   * did not start on the screen). The canvas is then as it was before it.
   */
  takeBack(seq: number, reason: string): void {
    const change = this.changes.find((c) => c.seq === seq);
    if (!change || !change.before || change.refused || this.undone.has(seq)) return;
    const thing = this.putBack(change);
    this.record({ by: change.by, op: "undo", id: thing.id, title: thing.title, why: `${describe(change)} (${text(reason, 200)})`, of: seq });
  }

  private putBack(change: Change): Thing {
    const thing = this.find(change.id);
    const b = change.before!;
    if (b.version !== undefined) thing.version = b.version;
    if (b.title !== undefined) thing.title = b.title;
    if (b.box !== undefined) thing.box = { ...b.box };
    if (b.pinned !== undefined) thing.pinned = b.pinned;
    if (b.removed !== undefined) thing.removed = b.removed;
    this.undone.add(change.seq);
    return thing;
  }

  // ---- inside --------------------------------------------------------------

  /** Woody may not touch what the operator pinned. The attempt is recorded. */
  private guard(by: Actor, thing: Thing, op: Change["op"], why: string): void {
    if (by === "woody" && thing.pinned) {
      this.record({ by, op, id: thing.id, title: thing.title, why, refused: "pinned by the operator" });
      throw new CanvasError(`thing ${thing.id} is pinned by the operator: it cannot be changed, moved or removed`);
    }
  }

  private checkSource(source: unknown): string {
    if (typeof source !== "string" || !source.trim()) throw new CanvasError("a thing needs its source");
    if (Buffer.byteLength(source) > LIMITS.source) throw new CanvasError("a thing's source is limited to 300 KB");
    return source;
  }

  private topZ(): number {
    return this.things.reduce((z, t) => Math.max(z, t.box.z), 0);
  }

  /** The asked-for box, or the first free place on the screen that last reported its size. */
  private boxFor(asked: Partial<Box> | undefined): Box {
    const w = clamp(asked?.w, 80, 4000, DEFAULT_SIZE.w);
    const h = clamp(asked?.h, 60, 4000, DEFAULT_SIZE.h);
    const z = this.topZ() + 1;
    if (typeof asked?.x === "number" && typeof asked?.y === "number") return { x: clamp(asked.x, 0, 20_000, 0), y: clamp(asked.y, 0, 20_000, 0), w, h, z };
    const taken = this.things.filter((t) => !t.removed).map((t) => t.box);
    // The top right corner belongs to the lattice and the voice line.
    taken.push({ x: this.viewport.w - 820, y: 0, w: 820, h: 150, z: 0 });
    const overlaps = (x: number, y: number) => taken.some((b) => x < b.x + b.w + GAP && x + w + GAP > b.x && y < b.y + b.h + GAP && y + h + GAP > b.y);
    for (let y = 24; y + h <= Math.max(this.viewport.h - 24, 24 + h); y += 24) {
      for (let x = 24; x + w <= this.viewport.w - 24; x += 24) {
        if (!overlaps(x, y)) return { x, y, w, h, z };
      }
    }
    // Nowhere free: cascade from the top left.
    const n = taken.length % 12;
    return { x: 24 + n * 28, y: 170 + n * 28, w, h, z };
  }

  private record(c: Omit<Change, "seq" | "ts">): void {
    const change: Change = { seq: this.nextSeq++, ts: this.now(), ...c };
    this.changes.push(change);
    if (this.changes.length > 2000) this.changes.shift();
    fs.appendFileSync(path.join(this.dir, "changes.jsonl"), JSON.stringify(change) + "\n");
    this.write("canvas.json", JSON.stringify({ next_id: this.nextId, next_seq: this.nextSeq, things: this.things }, null, 1));
  }

  /** Whole-file writes go through a temporary file, so a crash never leaves half a file. */
  private write(relative: string, body: string): void {
    const file = path.join(this.dir, relative);
    const tmp = `${file}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
}

/** One change in a few words, for the menu and the changes record. */
export function describe(c: Change): string {
  const name = `"${c.title}"`;
  switch (c.op) {
    case "make":
      return c.why === "brought back" ? `brought back ${name}` : `made ${name}`;
    case "change":
      return `changed ${name}`;
    case "restore":
      return `restored an earlier version of ${name}`;
    case "place":
      return `moved ${name}`;
    case "remove":
      return `removed ${name}`;
    case "pin":
      return `${c.why || "pinned"} ${name}`;
    case "undo":
      return `undid: ${c.why}`;
  }
}

// ---- how a thing is served ----------------------------------------------------

/** The policy sent with a thing: inline code only, no network of any kind, sandboxed even if opened directly. */
export const THING_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "sandbox allow-scripts",
].join("; ");

// The policy cannot forbid WebRTC, which can send packets anywhere (Phase 7a
// spike), so its interfaces are removed before the thing's own code runs.
const STRIP = `for (const k of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCIceTransport", "RTCSctpTransport", "RTCDtlsTransport"]) { try { delete window[k]; } catch (e) {} try { Object.defineProperty(window, k, { value: undefined, configurable: false, writable: false }); } catch (e) {} }`;

// The bridge, thing side: the thing's only way out of its frame. Messages go
// to the frame page, which knows the sender by its window, never by its claims.
const BRIDGE = `(() => {
  const frame = window.parent;
  const pending = new Map();
  const feeds = new Map();
  let seq = 0;
  function call(op, args) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, [resolve, reject]);
      frame.postMessage({ woody: 1, id, op, args }, "*");
    });
  }
  window.addEventListener("message", (e) => {
    if (e.source !== frame) return; // only the frame page may speak to a thing
    const m = e.data;
    if (!m || m.woody !== 1) return;
    if (m.re) {
      const p = pending.get(m.re);
      if (!p) return;
      pending.delete(m.re);
      if (m.ok) p[0](m.value); else p[1](new Error(m.error || "refused"));
    } else if (m.feed) {
      for (const cb of feeds.get(m.feed) || []) { try { cb(m.value); } catch (err) { call("error", { message: String(err) }); } }
    }
  });
  window.addEventListener("error", (e) => call("error", { message: e.message + " (line " + e.lineno + ")" }));
  window.addEventListener("unhandledrejection", (e) => call("error", { message: "unhandled: " + e.reason }));
  document.addEventListener("securitypolicyviolation", (e) => call("blocked", { directive: e.effectiveDirective, uri: e.blockedURI }));
  window.woody = {
    ready: () => call("ready", {}),
    read: (feed) => call("read", { feed }),
    subscribe: (feed, cb) => { if (!feeds.has(feed)) feeds.set(feed, []); feeds.get(feed).push(cb); return call("subscribe", { feed }); },
    state: { get: () => call("state.get", {}), set: (value) => call("state.set", { value }) },
    emit: (name, data) => call("emit", { name, data }),
  };
})();`;

/** A thing's source is a fragment. The canvas owns the document around it. */
export function wrapThing(source: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
:root { --bg: #050403; --fg: #ffb000; --text: #f2d9a0; --dim: #a98a45; --line: #33250a; --red: #ff5a4d; color-scheme: dark; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg); font: 14px/1.4 "JetBrains Mono", ui-monospace, monospace; overflow: hidden; }
* { box-sizing: border-box; }
</style>
<script>${STRIP}
${BRIDGE}</script>
</head><body>
${source}
</body></html>
`;
}
