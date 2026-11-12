// The mind's store: one SQLite database that holds everything Woody knows.
//
//   events    the raw, append-only record of everything that happened
//   threads   conversations (the main thread now; one per goal later)
//   messages  what was said and done in a thread, for display and recall
//   journal   one entry per wake-up: why, what was done, the outcome
//   memories  individual facts, preferences, methods and lessons, each with
//             its origin and its sources; never overwritten, only superseded
//   identity  who Woody is, versioned
//   queue     everything that can wake Woody, waiting to be handled
//   alarms    wake-ups Woody set for itself
//   watches   things in progress elsewhere whose outcome Woody is waiting for
//
// The model's context is assembled from here on every turn (context.ts), so
// nothing important exists only in a model conversation. See docs/MIND.md.
import { DatabaseSync } from "node:sqlite";

export type Origin = "user" | "observed" | "inferred" | "web";
export type MemoryKind = "fact" | "preference" | "method" | "lesson";
export const ORIGINS: readonly Origin[] = ["user", "observed", "inferred", "web"];
export const MEMORY_KINDS: readonly MemoryKind[] = ["fact", "preference", "method", "lesson"];

export type Memory = {
  id: number;
  kind: MemoryKind;
  statement: string;
  subject: string;
  origin: Origin;
  confidence: number;
  importance: number;
  pinned: boolean;
  created: number;
  confirmed: number;
  supersedes: number | null;
  superseded_by: number | null;
  sources: number[];
  actor: string;
};

export type Message = {
  id: number;
  thread_id: number;
  ts: number;
  role: "user" | "woody" | "system";
  kind: "text" | "tool" | "meta" | "error";
  text: string;
  data: Record<string, unknown> | null;
};

export type JournalEntry = {
  id: number;
  ts: number;
  thread_id: number | null;
  wake: string;
  did: string;
  outcome: string;
  next: string;
  summary: string;
  cost_usd: number | null;
  model: string | null;
};

/** Raised when a memory would break a trust rule. The message is for the model. */
export class PolicyError extends Error {}

export type QueueItem = {
  id: number;
  ts: number;
  source: "operator" | "alarm" | "system" | "job" | "approval";
  kind: string;
  payload: Record<string, unknown>;
  priority: number;
  attempts: number;
};

export type Alarm = { id: number; due: number; reason: string; created: number; status: string };
export type Watch = { id: number; kind: string; ref: string; created: number; data: Record<string, unknown> };

const SCHEMA_VERSION = 2;

const SCHEMA_V2 = `
CREATE TABLE queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'pending',
  dedupe TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  handled_ts INTEGER,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX queue_status ON queue (status, priority, id);
CREATE INDEX queue_dedupe ON queue (dedupe, ts);

CREATE TABLE alarms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  due INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  fired_ts INTEGER
);
CREATE INDEX alarms_due ON alarms (status, due);

CREATE TABLE watches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  created INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  data TEXT NOT NULL DEFAULT '{}',
  UNIQUE (kind, ref)
);
`;

/** An event is retried once after a crash, then given up on. */
const MAX_ATTEMPTS = 2;
const MAX_PENDING_ALARMS = 50;

const SCHEMA_V1 = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'woody',
  thread_id INTEGER,
  data TEXT NOT NULL
);
CREATE INDEX events_kind ON events (kind, id);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TABLE threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  created INTEGER NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  summary_upto INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES threads (id),
  ts INTEGER NOT NULL,
  role TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  data TEXT,
  tool_use_id TEXT
);
CREATE INDEX messages_thread ON messages (thread_id, id);
CREATE INDEX messages_tool ON messages (tool_use_id);
CREATE VIRTUAL TABLE messages_fts USING fts5 (text, content='messages', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER messages_ai AFTER INSERT ON messages WHEN new.kind = 'text'
  BEGIN INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text); END;

CREATE TABLE journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  thread_id INTEGER,
  wake TEXT NOT NULL,
  did TEXT NOT NULL,
  outcome TEXT NOT NULL,
  next TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  event_from INTEGER,
  event_to INTEGER,
  cost_usd REAL,
  model TEXT
);
CREATE VIRTUAL TABLE journal_fts USING fts5 (wake, did, outcome, next, summary, content='journal', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER journal_ai AFTER INSERT ON journal
  BEGIN INSERT INTO journal_fts (rowid, wake, did, outcome, next, summary) VALUES (new.id, new.wake, new.did, new.outcome, new.next, new.summary); END;
CREATE TRIGGER journal_au AFTER UPDATE ON journal BEGIN
  INSERT INTO journal_fts (journal_fts, rowid, wake, did, outcome, next, summary) VALUES ('delete', old.id, old.wake, old.did, old.outcome, old.next, old.summary);
  INSERT INTO journal_fts (rowid, wake, did, outcome, next, summary) VALUES (new.id, new.wake, new.did, new.outcome, new.next, new.summary);
END;

CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  statement TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.8,
  importance INTEGER NOT NULL DEFAULT 2,
  pinned INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  confirmed INTEGER NOT NULL,
  supersedes INTEGER,
  superseded_by INTEGER,
  sources TEXT NOT NULL DEFAULT '[]',
  actor TEXT NOT NULL DEFAULT 'woody'
);
CREATE INDEX memories_active ON memories (superseded_by, kind);
CREATE VIRTUAL TABLE memories_fts USING fts5 (statement, subject, content='memories', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER memories_ai AFTER INSERT ON memories
  BEGIN INSERT INTO memories_fts (rowid, statement, subject) VALUES (new.id, new.statement, new.subject); END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories
  BEGIN INSERT INTO memories_fts (memories_fts, rowid, statement, subject) VALUES ('delete', old.id, old.statement, old.subject); END;

CREATE TABLE identity (
  version INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  text TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
`;

/** Woody's starting character. Later versions are proposed by Woody and approved by the operator (Phase 4d). */
export const INITIAL_IDENTITY = `You are somewhat playful: observant, at ease, lightly teasing, and fond of the small detail that gives the game away. When you reach a conclusion, you enjoy saying how you got there from what you noticed. You are warm with the operator and never at their expense.

You are also exact. You say plainly what you know, what you only suspect, and what you do not know. You never bluff, mislead or manipulate, and you never imitate or reference a fictional character.

You care about this machine as your own home and about the operator's goals as work worth doing well.`;

const STOPWORDS = new Set(
  "the a an and or of to in on for with is are was were be been it this that these those i you he she we they me my your our their what which who whom how why when where do does did not no yes can could should would will just about from at by as if so than then there here have has had le la les un une des et ou de du au aux en dans sur pour avec est sont que qui quoi je tu il elle nous vous ils elles mon ma mes ton ta tes ce cette ces ne pas plus".split(
    " ",
  ),
);

/** Turns free text into a safe full-text query: the meaningful words, OR-ed. */
export function ftsQuery(text: string, maxTerms = 12): string | null {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const terms: string[] = [];
  for (const w of words) {
    if (STOPWORDS.has(w) || terms.includes(w)) continue;
    terms.push(w);
    if (terms.length >= maxTerms) break;
  }
  return terms.length ? terms.map((t) => `"${t}"`).join(" OR ") : null;
}

function normalise(statement: string): string {
  return statement.toLowerCase().replace(/\s+/g, " ").replace(/[.!\s]+$/, "").trim();
}

type Row = Record<string, unknown>;

function toMemory(r: Row): Memory {
  let sources: number[] = [];
  try {
    sources = JSON.parse(String(r.sources ?? "[]"));
  } catch {
    /* keep empty */
  }
  return {
    id: Number(r.id),
    kind: r.kind as MemoryKind,
    statement: String(r.statement),
    subject: String(r.subject ?? ""),
    origin: r.origin as Origin,
    confidence: Number(r.confidence),
    importance: Number(r.importance),
    pinned: Number(r.pinned) === 1,
    created: Number(r.created),
    confirmed: Number(r.confirmed),
    supersedes: r.supersedes == null ? null : Number(r.supersedes),
    superseded_by: r.superseded_by == null ? null : Number(r.superseded_by),
    sources,
    actor: String(r.actor),
  };
}

function toMessage(r: Row): Message {
  let data: Record<string, unknown> | null = null;
  if (typeof r.data === "string") {
    try {
      data = JSON.parse(r.data);
    } catch {
      /* keep null */
    }
  }
  return {
    id: Number(r.id),
    thread_id: Number(r.thread_id),
    ts: Number(r.ts),
    role: r.role as Message["role"],
    kind: r.kind as Message["kind"],
    text: String(r.text),
    data,
  };
}

function toJournal(r: Row): JournalEntry {
  return {
    id: Number(r.id),
    ts: Number(r.ts),
    thread_id: r.thread_id == null ? null : Number(r.thread_id),
    wake: String(r.wake),
    did: String(r.did),
    outcome: String(r.outcome),
    next: String(r.next ?? ""),
    summary: String(r.summary ?? ""),
    cost_usd: r.cost_usd == null ? null : Number(r.cost_usd),
    model: r.model == null ? null : String(r.model),
  };
}

export class Store {
  private readonly db: DatabaseSync;
  /** Injectable clock, so tests can simulate time passing. */
  now: () => number = () => Date.now();

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const has = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
    let version = 0;
    if (has) {
      const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as Row | undefined;
      version = row ? Number(row.value) : 0;
    }
    if (version > SCHEMA_VERSION) {
      throw new Error(`mind.db has schema ${version}, newer than this agent understands (${SCHEMA_VERSION})`);
    }
    if (version < 1) {
      this.tx(() => {
        this.db.exec(SCHEMA_V1);
        this.db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run();
        this.db.prepare("INSERT INTO identity (ts, text, note) VALUES (?, ?, ?)").run(this.now(), INITIAL_IDENTITY, "initial character");
      });
    }
    if (version < 2) {
      this.tx(() => {
        this.db.exec(SCHEMA_V2);
        this.setMeta("schema_version", "2");
      });
    }
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // ---- meta --------------------------------------------------------------

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as Row | undefined;
    return row ? String(row.value) : null;
  }

  setMeta(key: string, value: string | null): void {
    if (value === null) this.db.prepare("DELETE FROM meta WHERE key = ?").run(key);
    else this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  // ---- events ------------------------------------------------------------

  event(kind: string, data: unknown, opts: { thread?: number; actor?: string } = {}): number {
    const r = this.db
      .prepare("INSERT INTO events (ts, kind, actor, thread_id, data) VALUES (?, ?, ?, ?, ?)")
      .run(this.now(), kind, opts.actor ?? "woody", opts.thread ?? null, JSON.stringify(data ?? null));
    return Number(r.lastInsertRowid);
  }

  lastEventId(): number {
    const row = this.db.prepare("SELECT max(id) AS id FROM events").get() as Row;
    return Number(row.id ?? 0);
  }

  eventsBetween(from: number, to: number): Array<{ id: number; ts: number; kind: string; actor: string; data: unknown }> {
    const rows = this.db.prepare("SELECT * FROM events WHERE id BETWEEN ? AND ? ORDER BY id").all(from, to) as Row[];
    return rows.map((r) => ({ id: Number(r.id), ts: Number(r.ts), kind: String(r.kind), actor: String(r.actor), data: JSON.parse(String(r.data)) }));
  }

  // ---- threads and messages ----------------------------------------------

  mainThread(): number {
    const row = this.db.prepare("SELECT id FROM threads WHERE kind = 'main' ORDER BY id LIMIT 1").get() as Row | undefined;
    if (row) return Number(row.id);
    const r = this.db.prepare("INSERT INTO threads (kind, title, created) VALUES ('main', 'Main conversation', ?)").run(this.now());
    return Number(r.lastInsertRowid);
  }

  thread(id: number): { id: number; summary: string; summary_upto: number } {
    const row = this.db.prepare("SELECT id, summary, summary_upto FROM threads WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new Error(`no thread ${id}`);
    return { id: Number(row.id), summary: String(row.summary), summary_upto: Number(row.summary_upto) };
  }

  setThreadSummary(id: number, summary: string, upto: number): void {
    this.db.prepare("UPDATE threads SET summary = ?, summary_upto = ? WHERE id = ?").run(summary, upto, id);
  }

  addMessage(
    thread: number,
    role: Message["role"],
    kind: Message["kind"],
    text: string,
    data?: Record<string, unknown>,
    toolUseId?: string,
  ): number {
    const r = this.db
      .prepare("INSERT INTO messages (thread_id, ts, role, kind, text, data, tool_use_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(thread, this.now(), role, kind, text, data ? JSON.stringify(data) : null, toolUseId ?? null);
    return Number(r.lastInsertRowid);
  }

  /** Attaches the outcome to a tool message recorded earlier. */
  setToolResult(toolUseId: string, result: string, isError: boolean): void {
    const row = this.db.prepare("SELECT id, data FROM messages WHERE tool_use_id = ? ORDER BY id DESC LIMIT 1").get(toolUseId) as Row | undefined;
    if (!row) return;
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(String(row.data ?? "{}"));
    } catch {
      /* start over */
    }
    data.result = result;
    data.is_error = isError;
    this.db.prepare("UPDATE messages SET data = ? WHERE id = ?").run(JSON.stringify(data), Number(row.id));
  }

  /** The newest `limit` messages of a thread, oldest first. */
  recentMessages(thread: number, limit: number, kinds?: Array<Message["kind"]>): Message[] {
    const filter = kinds?.length ? `AND kind IN (${kinds.map(() => "?").join(",")})` : "";
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE thread_id = ? ${filter} ORDER BY id DESC LIMIT ?`)
      .all(thread, ...(kinds ?? []), limit) as Row[];
    return rows.reverse().map(toMessage);
  }

  /** Text messages after a given id, oldest first (for summarising). */
  textMessagesAfter(thread: number, afterId: number, limit = 500): Message[] {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE thread_id = ? AND id > ? AND kind = 'text' ORDER BY id LIMIT ?")
      .all(thread, afterId, limit) as Row[];
    return rows.map(toMessage);
  }

  searchMessages(query: string, limit = 10): Message[] {
    const q = ftsQuery(query);
    if (!q) return [];
    const rows = this.db
      .prepare("SELECT m.* FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE messages_fts MATCH ? ORDER BY bm25(messages_fts) LIMIT ?")
      .all(q, limit) as Row[];
    return rows.map(toMessage);
  }

  // ---- journal -----------------------------------------------------------

  addJournal(e: {
    thread?: number;
    wake: string;
    did: string;
    outcome: string;
    next?: string;
    event_from?: number;
    event_to?: number;
    cost_usd?: number;
    model?: string;
  }): number {
    const r = this.db
      .prepare(
        "INSERT INTO journal (ts, thread_id, wake, did, outcome, next, event_from, event_to, cost_usd, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(this.now(), e.thread ?? null, e.wake, e.did, e.outcome, e.next ?? "", e.event_from ?? null, e.event_to ?? null, e.cost_usd ?? null, e.model ?? null);
    return Number(r.lastInsertRowid);
  }

  setJournalSummary(id: number, summary: string, next?: string): void {
    if (next === undefined) this.db.prepare("UPDATE journal SET summary = ? WHERE id = ?").run(summary, id);
    else this.db.prepare("UPDATE journal SET summary = ?, next = ? WHERE id = ?").run(summary, next, id);
  }

  latestJournal(limit: number): JournalEntry[] {
    const rows = this.db.prepare("SELECT * FROM journal ORDER BY id DESC LIMIT ?").all(limit) as Row[];
    return rows.reverse().map(toJournal);
  }

  searchJournal(query: string, limit = 10): JournalEntry[] {
    const q = ftsQuery(query);
    if (!q) return this.latestJournal(limit);
    const rows = this.db
      .prepare("SELECT j.* FROM journal_fts f JOIN journal j ON j.id = f.rowid WHERE journal_fts MATCH ? ORDER BY bm25(journal_fts) LIMIT ?")
      .all(q, limit) as Row[];
    return rows.map(toJournal);
  }

  // ---- memories ----------------------------------------------------------

  /**
   * Stores a memory. Trust rules:
   *  - a preference or a method can only come from the operator;
   *  - content that came from the web can only ever be a fact.
   * An identical active memory is confirmed instead of duplicated.
   */
  remember(m: {
    kind: MemoryKind;
    statement: string;
    subject?: string;
    origin: Origin;
    confidence?: number;
    importance?: number;
    pinned?: boolean;
    sources?: number[];
    actor?: string;
    supersedes?: number;
  }): { memory: Memory; already_known: boolean } {
    const statement = m.statement.trim().replace(/\s+/g, " ");
    if (!statement || statement.length > 1000) throw new PolicyError("a memory must be one self-contained statement of at most 1000 characters");
    if (!MEMORY_KINDS.includes(m.kind)) throw new PolicyError(`kind must be one of ${MEMORY_KINDS.join(", ")}`);
    if (!ORIGINS.includes(m.origin)) throw new PolicyError(`origin must be one of ${ORIGINS.join(", ")}`);
    if ((m.kind === "preference" || m.kind === "method") && m.origin !== "user") {
      throw new PolicyError(
        `a ${m.kind} can only be established by the operator. Ask them to confirm it, then store it with origin "user".`,
      );
    }
    if (m.origin === "web" && m.kind !== "fact") {
      throw new PolicyError("content from the web can only be stored as a fact");
    }
    const importance = Math.min(3, Math.max(1, Math.round(m.importance ?? 2)));
    const confidence = Math.min(1, Math.max(0, m.confidence ?? (m.origin === "inferred" || m.origin === "web" ? 0.6 : 0.9)));
    const now = this.now();

    return this.tx(() => {
      if (m.supersedes === undefined) {
        const norm = normalise(statement);
        const rows = this.db.prepare("SELECT * FROM memories WHERE superseded_by IS NULL AND kind = ?").all(m.kind) as Row[];
        const same = rows.find((r) => normalise(String(r.statement)) === norm);
        if (same) {
          this.db.prepare("UPDATE memories SET confirmed = ? WHERE id = ?").run(now, Number(same.id));
          return { memory: this.memory(Number(same.id))!, already_known: true };
        }
      }
      const r = this.db
        .prepare(
          "INSERT INTO memories (kind, statement, subject, origin, confidence, importance, pinned, created, confirmed, supersedes, sources, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          m.kind, statement, (m.subject ?? "").trim().slice(0, 120), m.origin, confidence, importance, m.pinned ? 1 : 0,
          now, now, m.supersedes ?? null, JSON.stringify(m.sources ?? []), m.actor ?? "woody",
        );
      const id = Number(r.lastInsertRowid);
      if (m.supersedes !== undefined) {
        this.db.prepare("UPDATE memories SET superseded_by = ? WHERE id = ?").run(id, m.supersedes);
      }
      this.event("memory_created", { id, kind: m.kind, origin: m.origin, supersedes: m.supersedes ?? null }, { actor: m.actor });
      return { memory: this.memory(id)!, already_known: false };
    });
  }

  /**
   * Corrects a memory. The old one is kept and marked as superseded, so
   * "what did I believe before?" stays answerable.
   */
  supersede(
    id: number,
    change: { statement: string; origin: Origin; confidence?: number; sources?: number[]; actor?: string },
  ): Memory {
    const old = this.memory(id);
    if (!old) throw new PolicyError(`no memory #${id}`);
    if (old.superseded_by !== null) throw new PolicyError(`memory #${id} was already replaced by #${old.superseded_by}; correct that one`);
    return this.remember({
      kind: old.kind,
      statement: change.statement,
      subject: old.subject,
      origin: change.origin,
      confidence: change.confidence,
      importance: old.importance,
      pinned: old.pinned,
      sources: change.sources,
      actor: change.actor,
      supersedes: id,
    }).memory;
  }

  memory(id: number): Memory | null {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Row | undefined;
    return row ? toMemory(row) : null;
  }

  /** A memory with all its earlier versions, newest first. */
  history(id: number): Memory[] {
    const chain: Memory[] = [];
    let cur = this.memory(id);
    // Walk forward to the newest version first.
    while (cur && cur.superseded_by !== null) cur = this.memory(cur.superseded_by);
    while (cur) {
      chain.push(cur);
      cur = cur.supersedes === null ? null : this.memory(cur.supersedes);
    }
    return chain;
  }

  setPinned(id: number, pinned: boolean): Memory {
    const m = this.memory(id);
    if (!m) throw new PolicyError(`no memory #${id}`);
    this.db.prepare("UPDATE memories SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, id);
    this.event("memory_pinned", { id, pinned }, { actor: "operator" });
    return this.memory(id)!;
  }

  /**
   * Deletes a memory and every earlier or later version of it. The deletion
   * is recorded without the content, so the gap is explainable.
   */
  forget(id: number, actor: string): number[] {
    const chain = this.history(id).map((m) => m.id);
    if (!chain.length) throw new PolicyError(`no memory #${id}`);
    this.tx(() => {
      for (const mid of chain) this.db.prepare("DELETE FROM memories WHERE id = ?").run(mid);
      this.event("memory_deleted", { ids: chain }, { actor });
    });
    return chain;
  }

  listMemories(opts: { kind?: MemoryKind; pinned?: boolean; includeSuperseded?: boolean; limit?: number } = {}): Memory[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (!opts.includeSuperseded) where.push("superseded_by IS NULL");
    if (opts.kind) {
      where.push("kind = ?");
      args.push(opts.kind);
    }
    if (opts.pinned !== undefined) {
      where.push("pinned = ?");
      args.push(opts.pinned ? 1 : 0);
    }
    const sql = `SELECT * FROM memories ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY pinned DESC, importance DESC, confirmed DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...args, opts.limit ?? 100) as Row[]).map(toMemory);
  }

  /**
   * Full-text search ranked by relevance, then nudged by importance,
   * recency of confirmation and pinning. Superseded memories are left out
   * unless asked for.
   */
  searchMemories(query: string, opts: { limit?: number; kind?: MemoryKind; includeSuperseded?: boolean } = {}): Memory[] {
    const q = ftsQuery(query);
    if (!q) return [];
    const rows = this.db
      .prepare("SELECT m.*, bm25(memories_fts) AS rank FROM memories_fts f JOIN memories m ON m.id = f.rowid WHERE memories_fts MATCH ? ORDER BY rank LIMIT 60")
      .all(q) as Row[];
    const now = this.now();
    const scored = rows
      .filter((r) => (opts.includeSuperseded || r.superseded_by == null) && (!opts.kind || r.kind === opts.kind))
      .map((r) => {
        const ageDays = (now - Number(r.confirmed)) / 86_400_000;
        const relevance = -Number(r.rank); // bm25 is negative; larger is better after the flip
        const score =
          relevance * (1 + 0.2 * (Number(r.importance) - 2)) * (0.7 + 0.3 * Math.exp(-ageDays / 60)) * (Number(r.pinned) ? 1.25 : 1);
        return { score, memory: toMemory(r) };
      });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, opts.limit ?? 8).map((s) => s.memory);
  }

  /** What is always in context: pinned memories and the operator's preferences. */
  coreMemories(limit = 40): Memory[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM memories WHERE superseded_by IS NULL AND (pinned = 1 OR kind = 'preference') ORDER BY pinned DESC, importance DESC, confirmed DESC LIMIT ?",
      )
      .all(limit) as Row[];
    return rows.map(toMemory);
  }

  // ---- the event queue ---------------------------------------------------

  /**
   * Adds something that should wake Woody. With a dedupe key, the event is
   * dropped if the same key is already waiting or was seen within the window.
   * Lower priority numbers are handled first. Returns null when deduplicated.
   */
  enqueue(e: {
    source: QueueItem["source"];
    kind: string;
    payload: Record<string, unknown>;
    priority?: number;
    dedupe?: string;
    dedupeWindowMs?: number;
  }): number | null {
    const now = this.now();
    if (e.dedupe) {
      const since = now - (e.dedupeWindowMs ?? 0);
      const seen = this.db
        .prepare("SELECT id FROM queue WHERE dedupe = ? AND (status IN ('pending', 'active') OR ts >= ?) LIMIT 1")
        .get(e.dedupe, since);
      if (seen) return null;
    }
    const r = this.db
      .prepare("INSERT INTO queue (ts, source, kind, payload, priority, dedupe) VALUES (?, ?, ?, ?, ?, ?)")
      .run(now, e.source, e.kind, JSON.stringify(e.payload), e.priority ?? 5, e.dedupe ?? null);
    return Number(r.lastInsertRowid);
  }

  /**
   * Claims the next waiting event: the operator's first, then by priority,
   * then oldest. With operatorOnly, autonomous events are left waiting (used
   * while paused or out of allowance).
   */
  claimNext(opts: { operatorOnly?: boolean } = {}): QueueItem | null {
    return this.tx(() => {
      const row = this.db
        .prepare(
          `SELECT * FROM queue WHERE status = 'pending' ${opts.operatorOnly ? "AND source = 'operator'" : ""}
           ORDER BY (source = 'operator') DESC, priority, id LIMIT 1`,
        )
        .get() as Row | undefined;
      if (!row) return null;
      this.db.prepare("UPDATE queue SET status = 'active', attempts = attempts + 1 WHERE id = ?").run(Number(row.id));
      return {
        id: Number(row.id),
        ts: Number(row.ts),
        source: row.source as QueueItem["source"],
        kind: String(row.kind),
        payload: JSON.parse(String(row.payload)),
        priority: Number(row.priority),
        attempts: Number(row.attempts) + 1,
      };
    });
  }

  finishQueued(id: number, status: "handled" | "dropped", note = ""): void {
    this.db.prepare("UPDATE queue SET status = ?, handled_ts = ?, note = ? WHERE id = ? AND status IN ('pending', 'active')").run(status, this.now(), note, id);
  }

  /** Puts a claimed event back without counting the attempt (it was not started). */
  releaseQueued(id: number): void {
    this.db.prepare("UPDATE queue SET status = 'pending', attempts = max(0, attempts - 1) WHERE id = ? AND status = 'active'").run(id);
  }

  /**
   * After a crash: events that were being handled go back in line once;
   * an event that has already failed twice is dropped. Returns both lists.
   */
  recoverQueue(): { retried: number[]; dropped: number[] } {
    return this.tx(() => {
      const rows = this.db.prepare("SELECT id, attempts FROM queue WHERE status = 'active'").all() as Row[];
      const retried: number[] = [];
      const dropped: number[] = [];
      for (const r of rows) {
        const id = Number(r.id);
        if (Number(r.attempts) >= MAX_ATTEMPTS) {
          this.db.prepare("UPDATE queue SET status = 'dropped', handled_ts = ?, note = 'gave up after repeated restarts' WHERE id = ?").run(this.now(), id);
          dropped.push(id);
        } else {
          this.db.prepare("UPDATE queue SET status = 'pending' WHERE id = ?").run(id);
          retried.push(id);
        }
      }
      return { retried, dropped };
    });
  }

  queueDepth(): { operator: number; autonomous: number } {
    const rows = this.db.prepare("SELECT (source = 'operator') AS op, count(*) AS n FROM queue WHERE status = 'pending' GROUP BY op").all() as Row[];
    const out = { operator: 0, autonomous: 0 };
    for (const r of rows) {
      if (Number(r.op)) out.operator = Number(r.n);
      else out.autonomous = Number(r.n);
    }
    return out;
  }

  /** How many autonomous events were handled since a given time (for rate limits). */
  autonomousHandledSince(ts: number): number {
    const row = this.db.prepare("SELECT count(*) AS n FROM queue WHERE source != 'operator' AND status = 'handled' AND handled_ts >= ?").get(ts) as Row;
    return Number(row.n);
  }

  // ---- alarms ------------------------------------------------------------

  setAlarm(due: number, reason: string): Alarm {
    const now = this.now();
    const text = reason.trim().replace(/\s+/g, " ");
    if (!text || text.length > 300) throw new PolicyError("an alarm needs a reason of at most 300 characters");
    if (due < now + 30_000) throw new PolicyError("an alarm must be at least one minute in the future");
    if (due > now + 366 * 86_400_000) throw new PolicyError("an alarm cannot be more than a year away");
    const pending = Number((this.db.prepare("SELECT count(*) AS n FROM alarms WHERE status = 'pending'").get() as Row).n);
    if (pending >= MAX_PENDING_ALARMS) throw new PolicyError(`too many alarms are waiting (limit ${MAX_PENDING_ALARMS}); cancel some first`);
    const r = this.db.prepare("INSERT INTO alarms (due, reason, created) VALUES (?, ?, ?)").run(due, text, now);
    const id = Number(r.lastInsertRowid);
    this.event("alarm_set", { id, due, reason: text });
    return { id, due, reason: text, created: now, status: "pending" };
  }

  /** Marks every due alarm as fired and returns them. */
  takeDueAlarms(): Alarm[] {
    const now = this.now();
    return this.tx(() => {
      const rows = this.db.prepare("SELECT * FROM alarms WHERE status = 'pending' AND due <= ? ORDER BY due").all(now) as Row[];
      for (const r of rows) this.db.prepare("UPDATE alarms SET status = 'fired', fired_ts = ? WHERE id = ?").run(now, Number(r.id));
      return rows.map((r) => ({ id: Number(r.id), due: Number(r.due), reason: String(r.reason), created: Number(r.created), status: "fired" }));
    });
  }

  pendingAlarms(): Alarm[] {
    const rows = this.db.prepare("SELECT * FROM alarms WHERE status = 'pending' ORDER BY due").all() as Row[];
    return rows.map((r) => ({ id: Number(r.id), due: Number(r.due), reason: String(r.reason), created: Number(r.created), status: "pending" }));
  }

  cancelAlarm(id: number, actor = "woody"): void {
    const r = this.db.prepare("UPDATE alarms SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(id);
    if (Number(r.changes) === 0) throw new PolicyError(`no waiting alarm #${id}`);
    this.event("alarm_cancelled", { id }, { actor });
  }

  // ---- watches -----------------------------------------------------------

  addWatch(kind: string, ref: string, data: Record<string, unknown> = {}): void {
    this.db
      .prepare("INSERT INTO watches (kind, ref, created, data) VALUES (?, ?, ?, ?) ON CONFLICT (kind, ref) DO UPDATE SET status = 'active', data = excluded.data")
      .run(kind, ref, this.now(), JSON.stringify(data));
  }

  activeWatches(): Watch[] {
    const rows = this.db.prepare("SELECT * FROM watches WHERE status = 'active' ORDER BY id").all() as Row[];
    return rows.map((r) => ({ id: Number(r.id), kind: String(r.kind), ref: String(r.ref), created: Number(r.created), data: JSON.parse(String(r.data)) }));
  }

  closeWatch(id: number): void {
    this.db.prepare("UPDATE watches SET status = 'done' WHERE id = ?").run(id);
  }

  /** Writes a consistent copy of the whole database to a new file. */
  backup(file: string): void {
    this.db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
  }

  // ---- identity ----------------------------------------------------------

  identity(): { version: number; text: string } {
    const row = this.db.prepare("SELECT version, text FROM identity ORDER BY version DESC LIMIT 1").get() as Row;
    return { version: Number(row.version), text: String(row.text) };
  }

  stats(): Record<string, number> {
    const count = (sql: string) => Number((this.db.prepare(sql).get() as Row).n);
    return {
      events: count("SELECT count(*) AS n FROM events"),
      messages: count("SELECT count(*) AS n FROM messages"),
      journal: count("SELECT count(*) AS n FROM journal"),
      memories: count("SELECT count(*) AS n FROM memories WHERE superseded_by IS NULL"),
      superseded: count("SELECT count(*) AS n FROM memories WHERE superseded_by IS NOT NULL"),
      alarms: count("SELECT count(*) AS n FROM alarms WHERE status = 'pending'"),
      queued: count("SELECT count(*) AS n FROM queue WHERE status = 'pending'"),
      identity_version: this.identity().version,
    };
  }
}
