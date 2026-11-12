// The canvas store: the things on Woody's canvas, their versions, where they
// sit, what is pinned, and the record of every change with its undo.
//
// The gateway owns this store, not the agent. Woody asks for changes through
// the gateway; the operator makes them from the frame. That is what lets the
// rules here hold whatever Woody does:
//  * a pinned thing cannot be changed, moved or removed by Woody;
//  * only the operator pins, unpins and undoes;
//  * every change is recorded with who made it and why, and can be undone;
//  * no version of a thing is ever deleted;
//  * what Woody adds without having been asked is marked as such, carries a
//    note when it is for the operator, and counts against a daily limit that
//    only the operator sets.
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
  /** Woody put it there without having been asked. */
  uninvited?: boolean;
  /** Woody's note to the operator on a thing it left for them: what it is and why. */
  note?: string;
  /** The operator has read the note. */
  note_seen?: boolean;
  /**
   * When the thing explains a study: the study, and the pages that were read
   * for it. The agent hands them over from its record when the thing is
   * made; the frame lists them. The thing's own code cannot change them.
   */
  study?: StudyRef;
  /** Pictures from the web that this thing may show, each with where it came from. The frame lists them. */
  pictures?: Array<{ id: string; source: string }>;
  /**
   * The thing's content (its saved state): when it last changed and through
   * whom. "you" means through the thing on a screen: the operator's hands,
   * or the thing's own code. `hand` says that someone was touching the
   * thing when it changed (a click, a key), as far as the browser can tell:
   * only such a change is told to Woody. `told` is the change Woody last
   * heard of.
   */
  content?: { at: number; by: Actor; hand?: boolean; told?: number };
};
/**
 * A picture from the web, as it is kept: fetched by the executor, decoded
 * and written out again as WebP. `source` is the address it was fetched
 * from; `about` is what the quarantined reader said it shows.
 */
export type Picture = { id: string; source: string; width: number; height: number; bytes: number; ts: number; about: string };
export type Source = { url: string; title: string };
export type StudyRef = { id: number; subject: string; sources: Source[] };
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
  /** Woody did this without having been asked. */
  uninvited?: boolean;
};
export type Settings = {
  /** How many things Woody may add in a day without having been asked. Only the operator changes it. */
  uninvited_per_day: number;
};

export class CanvasError extends Error {}

export const LIMITS = { source: 300_000, state: 256_000, things: 80, title: 80, why: 400, versions: 500, note: 300, uninvited_per_day: 20, sources: 200, pictures: 200, picture_bytes: 1_600_000, pictures_per_thing: 12 };
const DEFAULT_SETTINGS: Settings = { uninvited_per_day: 3 };
const DEFAULT_SIZE = { w: 320, h: 220 };
const GAP = 16;

const clamp = (n: unknown, lo: number, hi: number, fallback: number): number => {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : fallback;
  return Math.min(hi, Math.max(lo, v));
};
/** A study and its sources as handed over with a new thing, or null if they are not well formed. */
function studyOf(v: unknown): StudyRef | null {
  const s = v as { id?: unknown; subject?: unknown; sources?: unknown } | null;
  if (!s || typeof s !== "object" || !Number.isInteger(s.id) || typeof s.subject !== "string" || !Array.isArray(s.sources)) return null;
  const sources: Source[] = [];
  for (const x of s.sources as Array<{ url?: unknown; title?: unknown }>) {
    if (!x || typeof x.url !== "string" || !/^https:\/\/[^\s<>"'`]{1,2000}$/.test(x.url)) continue;
    sources.push({ url: x.url, title: text(x.title, LIMITS.title + 60) });
    if (sources.length >= LIMITS.sources) break;
  }
  return { id: s.id as number, subject: text(s.subject, 200), sources };
}

const PICTURE_ID = /^p-[0-9a-f]{16}$/;

const text = (v: unknown, max: number): string => (typeof v === "string" ? v : "").replace(/[\u0000-\u0008\u000b-\u001f]/g, " ").trim().slice(0, max);

export class Canvas {
  private things: Thing[] = [];
  private changes: Change[] = [];
  private undone = new Set<number>();
  private nextId = 1;
  private nextSeq = 1;
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private pictures: Picture[] = [];
  /** The size of the screen that last reported it; used to place new things. */
  viewport = { w: 1600, h: 900 };

  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {
    fs.mkdirSync(path.join(dir, "things"), { recursive: true });
    fs.mkdirSync(path.join(dir, "pictures"), { recursive: true });
    try {
      const kept = JSON.parse(fs.readFileSync(path.join(dir, "pictures.json"), "utf8"));
      this.pictures = Array.isArray(kept) ? kept.filter((p) => p && PICTURE_ID.test(p.id) && fs.existsSync(path.join(dir, "pictures", `${p.id}.webp`))) : [];
    } catch {
      // no picture yet
    }
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(dir, "canvas.json"), "utf8"));
      this.things = Array.isArray(saved.things) ? saved.things : [];
      this.nextId = Number(saved.next_id) || 1;
      this.nextSeq = Number(saved.next_seq) || 1;
      const perDay = Number(saved.settings?.uninvited_per_day);
      if (Number.isInteger(perDay) && perDay >= 0 && perDay <= LIMITS.uninvited_per_day) this.settings.uninvited_per_day = perDay;
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

  /**
   * A thing's saved state: its content. It is not a change to the canvas (it
   * is not recorded and not undone), and pinning does not close it: a pinned
   * thing keeps its place, its look and its code, and its data still moves.
   * Who wrote it last is kept, so that Woody can be told what changed.
   */
  setState(id: string, value: unknown, by: Actor = "you", hand = by === "you"): void {
    const thing = this.find(id);
    const body = JSON.stringify(value ?? null);
    if (body.length > LIMITS.state) throw new CanvasError("a thing's saved state is limited to 256 KB");
    this.write(path.join("things", id, "state.json"), body);
    // What Woody wrote itself is not news to it.
    const at = this.now();
    // A thing that saves by itself (a timer, a counter) keeps the last time a hand changed it.
    const prev = thing.content;
    if (by === "you" && !hand && prev?.by === "you" && prev.hand) return;
    thing.content = { at, by, hand: by === "you" && hand, told: by === "woody" ? at : prev?.told };
    this.save();
  }

  /** Woody looked at a thing's content: it has seen the latest change. */
  stateSeen(id: string): void {
    const thing = this.find(id);
    if (!thing.content || thing.content.told === thing.content.at) return;
    thing.content.told = thing.content.at;
    this.save();
  }

  /**
   * The things whose content changed on a screen since Woody was last told.
   * Each is reported once: asking marks them as told.
   */
  stateNews(): Array<{ id: string; title: string; at: number }> {
    const news = this.things.filter((t) => !t.removed && t.content && t.content.by === "you" && t.content.hand && t.content.at > (t.content.told ?? 0));
    if (!news.length) return [];
    const out = news.map((t) => ({ id: t.id, title: t.title, at: t.content!.at }));
    for (const t of news) t.content!.told = t.content!.at;
    this.save();
    return out;
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

  // ---- what Woody adds on its own ---------------------------------------------

  /** Things Woody added today without having been asked. One that did not start and was taken back does not count. */
  uninvitedToday(): number {
    const start = new Date(this.now());
    start.setHours(0, 0, 0, 0);
    const takenBack = new Set(this.changes.filter((c) => c.op === "undo" && c.by === "woody" && c.of !== undefined).map((c) => c.of));
    return this.changes.filter((c) => c.ts >= start.getTime() && c.by === "woody" && c.uninvited && c.op === "make" && !c.refused && !takenBack.has(c.seq)).length;
  }

  limits(): Settings & { uninvited_today: number } {
    return { ...this.settings, uninvited_today: this.uninvitedToday() };
  }

  /** Only the operator sets how much Woody may add on its own. */
  setLimit(by: Actor, perDay: unknown): Settings & { uninvited_today: number } {
    if (by !== "you") throw new CanvasError("only the operator sets that limit");
    const n = Number(perDay);
    if (!Number.isInteger(n) || n < 0 || n > LIMITS.uninvited_per_day) throw new CanvasError(`the limit is a whole number from 0 to ${LIMITS.uninvited_per_day}`);
    this.settings.uninvited_per_day = n;
    this.save();
    return this.limits();
  }

  /**
   * May Woody add a thing now without having been asked? Throws the reason if
   * not. Asked before anything is written, and checked again when it is added.
   */
  mayAdd(input: { for?: unknown; note?: unknown }): true {
    const today = this.uninvitedToday();
    if (today >= this.settings.uninvited_per_day) {
      throw new CanvasError(
        this.settings.uninvited_per_day === 0
          ? "The operator has set the limit of uninvited additions to none: nothing is added to the canvas without their asking."
          : `You have already added ${today} thing${today === 1 ? "" : "s"} on your own today, which is the limit the operator set. Keep the idea for another day, or improve something that is already there.`,
      );
    }
    if (input.for !== "woody" && !text(input.note, LIMITS.note)) {
      throw new CanvasError("A thing you leave for the operator without being asked needs a note saying what it is and why you thought of them.");
    }
    return true;
  }

  /** The operator has read the note on a thing. Not a change: it is not recorded and not undone. */
  seeNote(by: Actor, id: unknown): Thing {
    if (by !== "you") throw new CanvasError("only the operator does that");
    const thing = this.find(id);
    if (thing.note && !thing.note_seen) {
      thing.note_seen = true;
      this.save();
    }
    return structuredClone(thing);
  }

  // ---- changing ------------------------------------------------------------

  // ---- pictures from the web ---------------------------------------------------

  /**
   * Keeps a picture the executor fetched and re-encoded. Only Woody's side
   * hands one over. The bytes must be a WebP file whose name is its own
   * fingerprint, so what is kept is what was converted.
   */
  putPicture(by: Actor, input: { id?: unknown; base64?: unknown; source?: unknown; width?: unknown; height?: unknown; about?: unknown }): Picture {
    if (by !== "woody") throw new CanvasError("pictures come from the web through the executor, not from a screen");
    const id = String(input.id ?? "");
    if (!PICTURE_ID.test(id) || typeof input.base64 !== "string") throw new CanvasError("not a picture as the executor returns it");
    const bytes = Buffer.from(input.base64, "base64");
    if (!bytes.length || bytes.length > LIMITS.picture_bytes) throw new CanvasError(`a picture is at most ${LIMITS.picture_bytes} bytes`);
    if (bytes.subarray(0, 4).toString("latin1") !== "RIFF" || bytes.subarray(8, 12).toString("latin1") !== "WEBP") throw new CanvasError("only re-encoded WebP pictures are kept");
    if (`p-${crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16)}` !== id) throw new CanvasError("the picture does not match its name");
    const source = typeof input.source === "string" && /^https:\/\/[^\s<>"'`]{1,2000}$/.test(input.source) ? input.source : "";
    if (!source) throw new CanvasError("a picture is kept with the address it came from");
    const side = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 && (v as number) <= 8000 ? (v as number) : 0);
    const picture: Picture = { id, source, width: side(input.width), height: side(input.height), bytes: bytes.length, ts: this.now(), about: text(input.about, 800) };
    const others = this.pictures.filter((p) => p.id !== id);
    if (others.length >= LIMITS.pictures) {
      // Room is made by letting go of the oldest picture that no thing shows.
      const used = new Set(this.things.flatMap((t) => (t.pictures ?? []).map((p) => p.id)));
      const spare = others.find((p) => !used.has(p.id));
      if (!spare) throw new CanvasError(`${LIMITS.pictures} pictures are kept and every one is shown by a thing; remove a thing first`);
      others.splice(others.indexOf(spare), 1);
      fs.rmSync(path.join(this.dir, "pictures", `${spare.id}.webp`), { force: true });
    }
    fs.writeFileSync(path.join(this.dir, "pictures", `${id}.webp`), bytes, { mode: 0o600 });
    this.pictures = [...others, picture];
    this.write("pictures.json", JSON.stringify(this.pictures, null, 1));
    return { ...picture };
  }

  pictureList(): Picture[] {
    return this.pictures.map((p) => ({ ...p }));
  }

  /** The picture as a data address, for the one thing that asks; only if it was declared for that thing. */
  pictureFor(thingId: string, pictureId: string): string {
    const thing = this.get(thingId);
    if (!(thing.pictures ?? []).some((p) => p.id === pictureId)) throw new CanvasError(`picture "${pictureId.slice(0, 40)}" was not given to this thing`);
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(path.join(this.dir, "pictures", `${pictureId}.webp`));
    } catch {
      throw new CanvasError("that picture is no longer kept");
    }
    return `data:image/webp;base64,${bytes.toString("base64")}`;
  }

  /** The pictures a thing is to show, checked against what is kept. */
  private picturesOf(v: unknown): Array<{ id: string; source: string }> | null {
    if (v === undefined || v === null) return null;
    if (!Array.isArray(v) || v.length > LIMITS.pictures_per_thing) throw new CanvasError(`a thing shows at most ${LIMITS.pictures_per_thing} pictures`);
    return [...new Set(v.map(String))].map((id) => {
      const p = this.pictures.find((x) => x.id === id);
      if (!p) throw new CanvasError(`no picture "${id.slice(0, 40)}" is kept. Fetch it first (web_picture) and use the id it returns.`);
      return { id: p.id, source: p.source };
    });
  }

  make(by: Actor, input: { title?: unknown; source?: unknown; kind?: unknown; for?: unknown; why?: unknown; box?: Partial<Box>; uninvited?: unknown; note?: unknown; study?: unknown; pictures?: unknown }): Thing {
    const source = this.checkSource(input.source);
    const title = text(input.title, LIMITS.title);
    if (!title) throw new CanvasError("a thing needs a title");
    // Only Woody can be uninvited: what the operator makes is theirs.
    const uninvited = by === "woody" && input.uninvited === true;
    if (uninvited) this.checkUninvited(by, { id: "", title, why: text(input.why, LIMITS.why) }, input);
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
    const note = by === "woody" ? text(input.note, LIMITS.note) : "";
    if (uninvited) thing.uninvited = true;
    if (note) thing.note = note;
    // Only Woody studies; what the operator makes has no sources to list.
    const study = by === "woody" ? studyOf(input.study) : null;
    if (study) thing.study = study;
    const pictures = by === "woody" ? this.picturesOf(input.pictures) : null;
    if (pictures?.length) thing.pictures = pictures;
    fs.mkdirSync(path.join(this.dir, "things", id), { recursive: true });
    this.write(path.join("things", id, "v1.html"), source);
    this.things.push(thing);
    this.record({ by, op: "make", id, title, why, before: { removed: true }, ...(uninvited ? { uninvited: true } : {}) });
    return structuredClone(thing);
  }

  /** The daily limit and the note, for something Woody adds on its own. A refusal is recorded. */
  private checkUninvited(by: Actor, about: { id: string; title: string; why: string }, input: { for?: unknown; note?: unknown }): void {
    try {
      this.mayAdd(input);
    } catch (err) {
      const limit = this.uninvitedToday() >= this.settings.uninvited_per_day;
      this.record({ by, op: "make", ...about, refused: limit ? "today's limit of things added on its own is reached" : "it had no note for the operator", uninvited: true });
      throw err;
    }
  }

  /** Marks a recorded change as one Woody made without having been asked. */
  private own(by: Actor, input: { uninvited?: unknown }): { uninvited?: true } {
    return by === "woody" && input.uninvited === true ? { uninvited: true } : {};
  }

  /** A new version of a thing's source, and optionally a new title. */
  change(by: Actor, input: { id?: unknown; source?: unknown; title?: unknown; why?: unknown; uninvited?: unknown; pictures?: unknown }): Thing {
    // The pictures are checked before anything is written; given a list, it replaces the thing's own.
    const pictures = by === "woody" ? this.picturesOf(input.pictures) : null;
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
    this.record({ by, op: "change", id: thing.id, title: thing.title, why, before, ...this.own(by, input) });
    if (pictures) {
      if (pictures.length) thing.pictures = pictures;
      else delete thing.pictures;
      this.save();
    }
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
  place(by: Actor, input: { id?: unknown; box?: Partial<Box>; raise?: unknown; why?: unknown; uninvited?: unknown }): Thing {
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
    this.record({ by, op: "place", id: thing.id, title: thing.title, why, before, ...this.own(by, input) });
    return structuredClone(thing);
  }

  /** Take a thing off the canvas. It is kept, with all its versions. */
  remove(by: Actor, input: { id?: unknown; why?: unknown; uninvited?: unknown }): Thing {
    const thing = this.find(input.id);
    const why = text(input.why, LIMITS.why);
    this.guard(by, thing, "remove", why);
    if (thing.removed) throw new CanvasError(`thing ${thing.id} is already off the canvas`);
    thing.removed = true;
    this.record({ by, op: "remove", id: thing.id, title: thing.title, why, before: { removed: false }, ...this.own(by, input) });
    return structuredClone(thing);
  }

  /** Put a removed thing back. */
  bringBack(by: Actor, input: { id?: unknown; why?: unknown; uninvited?: unknown }): Thing {
    const thing = this.find(input.id);
    if (!thing.removed) throw new CanvasError(`thing ${thing.id} is on the canvas`);
    // Putting back what was taken away is an addition like any other.
    const uninvited = by === "woody" && input.uninvited === true;
    if (uninvited) this.checkUninvited(by, { id: thing.id, title: thing.title, why: text(input.why, LIMITS.why) }, { for: thing.for, note: thing.note });
    if (this.things.filter((t) => !t.removed).length >= LIMITS.things) throw new CanvasError(`the canvas holds at most ${LIMITS.things} things; remove one first`);
    thing.removed = false;
    thing.box.z = this.topZ() + 1;
    this.record({ by, op: "make", id: thing.id, title: thing.title, why: text(input.why, LIMITS.why) || "brought back", before: { removed: true }, ...(uninvited ? { uninvited: true } : {}) });
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
    this.save();
  }

  private save(): void {
    this.write("canvas.json", JSON.stringify({ next_id: this.nextId, next_seq: this.nextSeq, settings: this.settings, things: this.things }, null, 1));
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
  // A feed read with arguments (one file, the last twenty log lines) is its own feed: its name carries them.
  const feedKey = (feed, args) => (args === undefined || args === null ? feed : feed + ":" + JSON.stringify(args));
  const listen = (key, cb) => { if (!feeds.has(key)) feeds.set(key, []); feeds.get(key).push(cb); };
  window.woody = {
    ready: () => call("ready", {}),
    read: (feed, args) => call("read", { feed, args }),
    subscribe: (feed, cb, args) => { const key = feedKey(feed, args); listen(key, cb); return call("subscribe", { feed, args, key }); },
    state: { get: () => call("state.get", {}), set: (value) => call("state.set", { value, touched: !!(navigator.userActivation && navigator.userActivation.isActive) }), onChange: (cb) => { listen("state", cb); } },
    emit: (name, data) => call("emit", { name, data }),
    picture: (id) => call("picture", { id }),
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
