// woody-agent: the unprivileged reasoning process, put together.
//
// Woody is a loop over one queue of events: the operator's messages, alarms it
// set for itself, things the pulse noticed on the system, finished jobs,
// decided approvals, goals, studies and moments of its own. Each event is
// handled in one bounded session of the model (run-session.ts).
//
// The model has no built-in tools: the only things it can do are Woody's own
// tools, each of which goes through a gate (gate.ts, woody-store.ts) that asks
// one policy table (policy.ts) what the session in progress may do.
//
// Everything that is said and done is written to the mind's store (store.ts),
// and each session's context is assembled from it (mind/context.ts). The
// model's own conversation is only a short-lived working context; continuity
// comes from the store.
//
// This file builds the shared object (core.ts) the other files work on. It is
// given its configuration and the executor from outside, so that the tests
// can run the whole loop against a scripted model (loop.test.ts).
import fs from "node:fs";
import path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { createCanvasTools } from "../canvas.js";
import { setExtraContext } from "../mind/context.js";
import { createGoalTools } from "../mind/goal-tools.js";
import { innerLines } from "../mind/inner.js";
import { createLifeTools } from "../mind/life-tools.js";
import { createMethodTools } from "../mind/method-tools.js";
import { createSelfTools } from "../mind/self-tools.js";
import { createStudyTools } from "../mind/study-tools.js";
import { createMemoryTools } from "../mind/tools.js";
import { createSystemTools } from "../tools.js";
import { Budget } from "./budget.js";
import { CanvasLink } from "./canvas-link.js";
import { API_ERROR, HISTORY_MESSAGES, MAX_EXPRESSED_PER_SESSION, type Config } from "./config.js";
import type { Client, Core, ExecPort, MindStateName, Persisted, ToolEntry } from "./core.js";
import { createDaily } from "./daily.js";
import { fuse, nearest, type Embedder } from "./embed.js";
import { Files } from "./files.js";
import { gatedExec, gatedLink, gatedNotify, type Session } from "./gate.js";
import { createLife } from "./life-now.js";
import { DEFAULT_METHODS } from "./methods.js";
import { ask, type Aside } from "./model.js";
import { CHAT_MODELS, DEFAULT_MODEL, TRIAGE_MODEL } from "./models.js";
import { createOperatorApi } from "./operator-api.js";
import { createProtocol } from "./protocol.js";
import { systemChange } from "./pulse.js";
import { createQueue } from "./queue-loop.js";
import { TOOL_SERVER_NAME } from "./rules.js";
import { createSessions } from "./run-session.js";
import { query } from "./sdk.js";
import { Store, type Memory, type Message } from "./store.js";
import { createWebTools, type WebHooks } from "./web-tools.js";
import { woodyStore, type RecallOptions, type StoreSession } from "./woody-store.js";

export type AgentDeps = {
  cfg: Config;
  exec: ExecPort;
  /** Whether a key for the model API is configured. Defaults to looking at the environment. */
  hasCredential?: () => boolean;
  /** The local embedding model, for recall by meaning. Without it, memory is searched by words only. */
  embedder?: Embedder;
};

export type Agent = Core & {
  /** Closes the mind's store. */
  close(): void;
};

export function createAgent(deps: AgentDeps): Agent {
  const { cfg, exec } = deps;

  // ---- state ---------------------------------------------------------------

  fs.mkdirSync(cfg.workspace, { recursive: true });
  const STATE_FILE = path.join(cfg.stateDir, "agent-state.json");

  function loadState(): Persisted {
    try {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as Partial<Persisted>;
      const model = CHAT_MODELS.some((m) => m.id === raw.model) ? raw.model! : DEFAULT_MODEL;
      // A working context whose cost so far is not known cannot be continued without counting it twice: it starts afresh.
      const known = typeof raw.sessionId === "string" && typeof raw.sessionCostUsd === "number";
      return {
        model,
        sessionId: known ? raw.sessionId : undefined,
        sessionCostUsd: known ? raw.sessionCostUsd : undefined,
        sessionTurns: known && typeof raw.sessionTurns === "number" ? raw.sessionTurns : 0,
        lastTurnAt: typeof raw.lastTurnAt === "number" ? raw.lastTurnAt : 0,
      };
    } catch {
      return { model: DEFAULT_MODEL };
    }
  }

  const state = loadState();
  function saveState(): void {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(state), { mode: 0o600 });
    } catch (err) {
      console.error("could not save state:", err);
    }
  }

  const budget = new Budget(cfg.stateDir, cfg.monthlyCapUsd, cfg.ownShare);
  const store = new Store(path.join(cfg.stateDir, "mind.db"));
  const thread = store.mainThread();
  const threads = {
    main: thread,
    /** Where the daily reflection's own activity is recorded, away from the conversation. */
    reflection: store.systemThread("reflection"),
    /** Where Woody's own time is recorded: what it did with it goes to its journal, not to the conversation. */
    own: store.systemThread("own"),
    /** Where the reading sessions of studies are recorded. */
    study: store.systemThread("study"),
  };
  /** The HUD gateway's connection for the canvas. The gateway keeps the canvas and its rules. */
  const canvasLink = new CanvasLink();
  const files = new Files(cfg.workspace, cfg.benchDir);
  const clients = new Set<Client>();
  const apiBlock = { until: 0, failures: 0, reason: "" };

  // The other files' functions are added below, once what they need exists.
  const core = {
    cfg, store, budget, exec, canvasLink, files, state, saveState, threads,
    session: null,
    paused: false,
    shuttingDown: false,
    lastSessionEnd: Date.now(),
    apiBlock,
    mind: { state: "resting", focus: "", since: Date.now() },
    clients,
  } as unknown as Agent;

  // ---- the screens -----------------------------------------------------------

  function send(client: Client, message: Record<string, unknown>): void {
    if (client.readyState === 1) client.send(JSON.stringify(message));
  }

  function broadcast(message: Record<string, unknown>): void {
    for (const client of clients) send(client, message);
  }

  const hasCredential = deps.hasCredential ?? (() => Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN));

  function noteApiFailure(text: string): void {
    apiBlock.failures += 1;
    const wait = Math.min(6 * 3_600_000, 5 * 60_000 * 2 ** (apiBlock.failures - 1));
    apiBlock.until = Date.now() + wait;
    apiBlock.reason = text.replace(/\s+/g, " ").slice(0, 300);
    store.event("api_error", { text: apiBlock.reason, failures: apiBlock.failures, retry_in_ms: wait });
  }

  function setMind(next: MindStateName, focus = ""): void {
    if (core.mind.state !== next || core.mind.focus !== focus) core.mind = { state: next, focus, since: Date.now() };
  }

  /** Services known to be failed at the last system check. */
  function failedUnits(): string[] {
    try {
      const list = JSON.parse(store.getMeta("known_failed") ?? "[]");
      return Array.isArray(list) ? list.slice(0, 20).map(String) : [];
    } catch {
      return [];
    }
  }

  /**
   * A small expression for the lattice. Each is tied to something real that
   * just happened; none is decoration. The HUD may ignore them.
   */
  function moment(name: string): void {
    broadcast({ type: "moment", name });
  }

  /** Woody chose to show an expression. Returns why not, when it is not shown. */
  function express(name: string): string | null {
    const entry = store.face().find((f) => f.name === name);
    if (!entry || entry.kind !== "expression") return `"${name}" is not one of your expressions (see face_list).`;
    if (name === "listening" || name === "asleep") return `"${name}" shows by itself for as long as its cause lasts; it cannot be played.`;
    const s = core.session;
    if (s && s.expressed >= MAX_EXPRESSED_PER_SESSION) return `You have shown ${MAX_EXPRESSED_PER_SESSION} expressions in this session, which is the most. A face that never stops moving says nothing.`;
    if (s) s.expressed += 1;
    store.event("expressed", { name });
    moment(name);
    return null;
  }

  function stateMessage(): Record<string, unknown> {
    const nextAlarm = store.pendingAlarms()[0];
    const s = core.session;
    return {
      type: "state",
      model: state.model,
      models: CHAT_MODELS,
      session: state.sessionId ?? null,
      busy: s !== null,
      budget: budget.status(),
      has_credential: hasCredential(),
      mind: store.stats(),
      inner: core.currentInner(),
      life: core.lifeNow(),
      // Changes whenever Woody redraws its lattice: the frame then asks for the designs again.
      face: store.faceVersion(),
      // Changes Woody made to its identity that the operator has not looked at yet.
      identity: (({ version, unseen, paused: far, remaining }) => ({ version, unseen, paused: far, remaining: Number(remaining.toFixed(3)) }))(store.identityState()),
      mind_state: {
        ...core.mind,
        mode: s ? s.mode : null,
        tainted: s !== null && s.tainted,
        failed_units: failedUnits(),
        paused: core.paused,
        queue: store.queueDepth(),
        next_alarm: nextAlarm ? { id: nextAlarm.id, due: nextAlarm.due, reason: nextAlarm.reason } : null,
        waiting_on_operator: store.activeWatches().filter((w) => w.kind === "approval").length,
      },
    };
  }

  // ---- the written record --------------------------------------------------

  /** A stored message in the shape the HUD displays. */
  function historyItem(m: Message): Record<string, unknown> | null {
    switch (m.kind) {
      case "text":
        return { kind: m.role === "user" ? "user" : "assistant", text: m.text, ts: m.ts };
      case "tool":
        return {
          kind: "tool",
          id: String(m.data?.id ?? m.id),
          name: String(m.data?.name ?? m.text),
          input: m.data?.input ?? {},
          result: typeof m.data?.result === "string" ? m.data.result : undefined,
          isError: Boolean(m.data?.is_error),
          ts: m.ts,
        };
      case "meta":
        return { kind: "meta", text: m.text, ts: m.ts };
      case "error":
        return { kind: "error", text: m.text, ts: m.ts };
    }
  }

  function historyMessage(): Record<string, unknown> {
    const items = store
      .recentMessages(thread, HISTORY_MESSAGES)
      .map(historyItem)
      .filter((i) => i !== null);
    return { type: "history", thread, items };
  }

  /** A line in the conversation that is neither side speaking: a wake-up, a note. */
  function note(text: string): void {
    store.addMessage(thread, "system", "meta", text);
    broadcast({ type: "note", text });
  }

  // ---- what the model costs ---------------------------------------------------

  // The maker and the web reader call this: what they cost is part of the
  // session that asked for them, and comes out of Woody's share in its own time.
  function recordBackgroundCost(model: string, cost: number): void {
    if (cost <= 0) return;
    const s = core.session;
    if (s) s.extra += cost;
    budget.record({ kind: s?.own ? "own" : "background", model, cost_usd: cost });
  }

  /** Small calls that belong to no session: journal summaries, the triage of log errors. */
  function recordAsideCost(model: string, cost: number): void {
    if (cost > 0) budget.record({ kind: "background", model, cost_usd: cost });
  }

  /** A small model call for Woody's tools: the model and the cost record are fixed here, and it stops when the month's cap is reached. */
  const aside: Aside = async (system, prompt) => (budget.status().exhausted ? "" : ask(TRIAGE_MODEL, system, prompt, cfg.workspace, recordAsideCost));

  /** One model call that writes a thing's source. Stop interrupts it like the session it belongs to. */
  async function writeThing(model: string, system: string, prompt: string): Promise<string> {
    // The maker is called by a canvas tool: the month's cap is checked here, not there.
    if (budget.status().exhausted) throw new Error("the monthly spending cap is reached");
    let out = "";
    let stopped = "";
    for await (const message of query({
      prompt,
      options: {
        model, systemPrompt: system, tools: [], settingSources: [], persistSession: false, maxTurns: 1,
        // In Woody's own time, the maker spends from Woody's share and no more than is there.
        maxBudgetUsd: core.session?.own ? Math.max(0.02, Math.min(0.75, budget.status().own.available_usd)) : 0.75,
        abortController: core.session?.abort, cwd: cfg.workspace,
      },
    })) {
      if (message.type === "result") {
        recordBackgroundCost(model, message.total_cost_usd ?? 0);
        if (message.subtype === "success") out = message.result;
        else stopped = message.subtype;
      }
    }
    if (!out.trim()) throw new Error(stopped ? `the model stopped (${stopped.replaceAll("_", " ")})` : "the model returned nothing");
    if (API_ERROR.test(out.trim())) throw new Error(out.trim().slice(0, 200));
    return out;
  }

  // ---- recall by meaning -------------------------------------------------------

  const embedder = deps.embedder;
  let embedFailures = 0;

  /**
   * Memories for a text: by words always, and by meaning when the machine has
   * an embedding model. The two lists are merged. If the model does not answer,
   * the search by words stands alone: recall never fails and never waits long.
   */
  async function recall(query: string, opts: RecallOptions = {}): Promise<Memory[]> {
    const limit = opts.limit ?? 8;
    const words = store.searchMemories(query, { ...opts, limit: Math.max(limit, 20) });
    // Replaced memories have no vector: a search that includes them is by words.
    if (!embedder || opts.includeSuperseded || !query.trim()) return words.slice(0, limit);
    try {
      const [q] = await embedder.embed([query.slice(0, 2000)], "query");
      const near = nearest(q!, store.memoryVectors(embedder.model, opts.kind), 20);
      embedFailures = 0;
      return store.memoriesByIds(fuse([words.map((m) => m.id), near], limit));
    } catch (err) {
      if (embedFailures++ === 0) console.error("recall by meaning is not available, searching by words:", err instanceof Error ? err.message : err);
      return words.slice(0, limit);
    }
  }

  /** Gives a vector to memories that have none yet, a few at a time (called by the pulse). */
  async function embedPending(max = 16): Promise<number> {
    if (!embedder) return 0;
    const todo = store.memoriesWithoutVector(embedder.model, max);
    if (!todo.length) return 0;
    const vectors = await embedder.embed(todo.map((m) => `${m.subject ? `${m.subject}: ` : ""}${m.statement}`.slice(0, 2000)), "passage");
    todo.forEach((m, i) => store.setMemoryVector(m.id, embedder.model, vectors[i]!));
    return todo.length;
  }

  Object.assign(core, { send, broadcast, moment, note, stateMessage, historyMessage, historyItem, setMind, hasCredential, noteApiFailure, recordBackgroundCost, recordAsideCost, aside, failedUnits, recall, embedPending });

  /** The files the operator put in the workbench for Woody, for the context of a session. */
  function benchLines(): string[] {
    if (!files.bench) return [];
    try {
      const waiting = files.list(path.join(files.bench, "in")).entries.filter((e) => e.type === "file" || e.type === "dir");
      if (!waiting.length) return [];
      const size = (n?: number) => (n === undefined ? "" : n >= 1_048_576 ? ` (${(n / 1_048_576).toFixed(1)} MB)` : ` (${Math.max(1, Math.round(n / 1024))} KB)`);
      return [
        "",
        `Files in your workbench's "in" folder (${path.join(files.bench, "in")}), put there by the operator for you:`,
        ...waiting.slice(0, 20).map((e) => `- ${e.name}${e.type === "dir" ? "/" : size(e.size)}`),
        ...(waiting.length > 20 ? [`- and ${waiting.length - 20} more`] : []),
      ];
    } catch {
      return [];
    }
  }

  // ---- what Woody's tools are handed ---------------------------------------------
  //
  // The tools never get the store, the executor or the canvas as they are. They
  // get these: the same things behind checks that depend on the session in
  // progress, which is read here each time.

  // Woody's methods as the program ships them: new sections are added, and a section the program changed replaces what is stored.
  store.syncMethods(DEFAULT_METHODS);

  /** The session in progress, as the gates see it. Outside a session, nothing is tainted and nothing is being made. */
  const session: Session & StoreSession = {
    tainted: () => core.session?.tainted ?? false,
    mode: () => core.session?.mode ?? "full",
    // Whatever Woody does without the operator having asked (its own time, a wake-up, a duty) is uninvited.
    uninvited: () => core.session?.mode === "observe" && !core.session.invited,
    // The explainer of a study carries the pages that were read for it.
    explains: () => {
      const cur = core.session?.study;
      const s = cur?.kind === "explain" ? store.study(cur.id) : null;
      return s ? { id: s.id, subject: s.subject, sources: s.pages.map((p) => ({ url: p.url, title: p.title })) } : null;
    },
    made: (id) => {
      if (core.session) core.session.made = core.session.made ?? id;
    },
    readWeb: (source, links) => {
      const s = core.session;
      if (!s) return;
      if (!s.taint) store.event("session_tainted", { source });
      s.taint = s.taint ?? source;
      s.links.add(links);
    },
    scrub: (text) => core.session?.scrub(text) ?? text,
    starter: () => {
      const s = core.session;
      return s?.operator ? "operator" : s?.own && !s.study ? "woody" : null;
    },
    reflecting: () => core.session?.reflecting ?? false,
    study: () => core.session?.study ?? null,
    takeSources: () => core.session?.pages.splice(0) ?? [],
    madeThing: () => core.session?.made ?? null,
    recalled: (text) => (core.session?.recalled?.text === text ? core.session.recalled.memories : null),
    recall,
  };
  const woody = woodyStore(store, session);
  const woodyExec = gatedExec(exec, session);
  const woodyLink = gatedLink(canvasLink, session);
  const woodyNotify = gatedNotify(broadcast);

  /** What the web tools need from the loop. */
  function webHooks(): WebHooks {
    return {
      taint: (source) => {
        const s = core.session;
        if (!s) return;
        if (!s.taint) store.event("session_tainted", { source });
        s.taint = s.taint ?? source;
      },
      reader: { model: TRIAGE_MODEL, cwd: cfg.workspace, onCost: (model, cost) => recordBackgroundCost(model, cost) },
      links: {
        restricted: () => core.session?.tainted ?? false,
        has: (url) => core.session?.links.has(url) ?? false,
        add: (urls) => core.session?.links.add(urls),
      },
      // A picture goes to the canvas, which keeps it with the address it came from. Woody's own process holds it only in passing.
      keepPicture: async (picture) => {
        await canvasLink.request("picture_put", picture, 15_000);
      },
      pageRead: (url, title) => {
        const study = core.session?.study ?? null;
        store.event("page_read", { url, study: study?.id ?? null });
        // A page read for a study is one of its sources, whatever the model later writes.
        if (study?.kind === "read") {
          store.addStudyPage(study.id, url, title);
          core.session!.pages.push(url);
        }
      },
    };
  }

  /** The tools about Woody's own mind and its canvas. Each is given the view of the store and the gated connections, never the real ones. */
  function ownTools() {
    return [
      ...createCanvasTools({
        link: woodyLink,
        write: writeThing,
        canSpend: (effort) => {
          const b = budget.status();
          if (b.exhausted) return "The monthly spending cap is reached: nothing can be made until the operator raises it.";
          if (!core.session?.own) return null;
          if (effort === "best") return "In your own time the strongest maker is not available: it would cost too much of your share. Use small, normal or hard.";
          const need = { small: 0.01, normal: 0.05, hard: 0.12 }[effort];
          return b.own.available_usd < need
            ? `Your own share has $${b.own.available_usd.toFixed(2)} available right now, which is not enough for a maker of this size. Use a kit part or a smaller effort, or keep the idea for another moment (interest_note).`
            : null;
        },
        uninvited: session.uninvited,
      }),
      ...createLifeTools(woody, session.tainted, session.scrub),
      ...createMethodTools(woody, () => broadcast({ type: "goals_changed" })),
      ...createSelfTools(woody, { reflecting: session.reflecting, express, faceChanged: () => broadcast(stateMessage()) }),
      ...createStudyTools(woody, {
        scrub: session.scrub,
        starter: session.starter,
        current: session.study,
        // The pages a finding rests on are taken from the session by the store's view, not handed in by the tool.
        takeSources: () => [],
        madeThing: session.madeThing,
        changed: () => broadcast({ type: "goals_changed" }),
      }),
      tool(
        "inner_state",
        "How you are right now and why: your energy, ease, curiosity, attention to the operator and unease, each with the real events behind it. The system computes it from the record. Use it when the operator asks how you are or why you are like this, and answer with these causes.",
        {},
        async () => ({ content: [{ type: "text" as const, text: JSON.stringify(core.currentInner(), null, 2) }] }),
        { annotations: { readOnlyHint: true } },
      ),
      ...createMemoryTools(woody, () => core.session?.turnSources ?? [], session.tainted, session.scrub),
      ...createGoalTools(
        woody,
        (goalId) => {
          core.session?.touchedGoals.add(goalId);
          broadcast({ type: "goals_changed" });
        },
        session.tainted,
        session.scrub,
      ),
    ];
  }

  const tools = [
    ...ownTools(),
    ...createSystemTools(woodyExec, woodyNotify, files, {
      parkApproval: (approvalId, action, params) => {
        store.addWatch("approval", approvalId, { action, params });
        store.event("approval_parked", { approval_id: approvalId, action });
      },
      watchConfig: (candidate) => store.addWatch("config", candidate),
      unwatchConfig: (candidate) => {
        for (const w of store.activeWatches()) if (w.kind === "config" && w.ref === candidate) store.closeWatch(w.id);
      },
      mode: () => core.session?.mode ?? "full",
      pause: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(ms, 5000)))),
    }),
    ...createWebTools(woodyExec, webHooks()),
  ];
  const toolServer = createSdkMcpServer({ name: TOOL_SERVER_NAME, version: "0.6.0", alwaysLoad: true, tools });
  Object.assign(core, { woody, toolServer, tools: tools as unknown as ToolEntry[] });

  // ---- the rest of the loop, by subject ----------------------------------------

  Object.assign(core, createLife(core));
  // What every session's context adds to the time and the memories: how Woody is, and what waits in its workbench.
  setExtraContext(() => [...innerLines(core.currentInner()), ...benchLines()]);
  Object.assign(core, createQueue(core));
  Object.assign(core, createSessions(core));
  Object.assign(core, createDaily(core));
  Object.assign(core, createOperatorApi(core));
  Object.assign(core, createProtocol(core));

  // ---- starting up ---------------------------------------------------------------

  /**
   * After a restart: anything that was being handled goes back in line once,
   * and the interruption is written down.
   */
  function recoverAfterRestart(): void {
    const { retried, dropped } = store.recoverQueue();
    const open = store.getMeta("open_turn");
    store.setMeta("open_turn", null);
    if (!open && !retried.length && !dropped.length) return;
    const outcome = dropped.length
      ? "I had already been restarted once while handling it, so I gave up on it rather than loop."
      : retried.length
        ? "It is back in my queue and I will pick it up again, checking what I had already done."
        : "The operator's last message may still need an answer.";
    const shown = dropped.length
      ? "It had already been restarted once while handling this, so it gave up rather than loop."
      : retried.length
        ? "It will pick the work up again."
        : "The last message may still need an answer.";
    store.addMessage(thread, "system", "error", `Woody was restarted in the middle of its work. ${shown}`);
    store.addJournal({
      thread,
      wake: "I was restarted.",
      did: "I was in the middle of handling something when I was stopped.",
      outcome,
      event_from: open ? Number(open) : undefined,
      event_to: store.lastEventId(),
    });
    store.event("interrupted_by_restart", { open_turn: open ? Number(open) : null, retried, dropped });
  }

  store.event("agent_start", { model: state.model, stats: store.stats() });
  recoverAfterRestart();
  const changed = systemChange(store);
  if (changed) {
    store.addJournal({ thread, wake: "I started up.", did: "Compared the running system with the one I last saw.", outcome: changed });
    store.event("system_changed", { text: changed });
  }

  core.close = () => store.close();
  return core;
}
