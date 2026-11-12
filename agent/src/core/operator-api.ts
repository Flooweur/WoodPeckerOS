// The operator's access to the mind.
//
// Requests arriving here come from the human side (root, or the HUD gateway),
// never from the model. What is changed here is recorded as the operator's.
import { smallGoalLimit } from "../mind/goal-tools.js";
import { clockText, dayKey, dayStartOf, parseClock, validRhythm } from "../mind/life.js";
import { STUDY_SIZES } from "../mind/study-tools.js";
import type { Core } from "./core.js";
import { METHODS } from "./methods.js";
import { MEMORY_KINDS, PolicyError, STUDY, type MemoryKind } from "./store.js";
import { clip } from "./text.js";

export function createOperatorApi(core: Core) {
  const { cfg, store, budget, state, woody, moment } = core;
  const ownThread = core.threads.own;
  const historyItem = (m: Parameters<Core["historyItem"]>[0]) => core.historyItem(m);
  const pump = () => core.pump();
  const rhythm = () => core.rhythm();
  const lifeNow = () => core.lifeNow();
  const ownNext = () => core.ownNext();
  const briefTime = () => core.briefTime();
  const operatorGoalMessage = (goalId: number, text: string) => core.operatorGoalMessage(goalId, text);

  const ACTIVITY_KINDS = [
    "user_message", "assistant_message", "tool_use", "wake", "goal_checkpoint", "goal_created", "goal_reviewed",
    "goal_accepted", "goal_dropped", "memory_created", "alarm_set", "api_error", "interrupted_by_restart",
    "session_tainted", "system_changed", "approval_parked",
    "own_time", "interest_added", "interest_dropped", "study_started", "study_read", "study_done", "study_dropped", "identity_changed", "identity_restored", "face_changed", "face_reset", "method_changed", "method_removed", "method_restored", "method_updated",
  ];

  /** Recent events as one line each, with the mark the HUD draws for them. */
  function activity(limit: number): Array<{ ts: number; mark: string; text: string }> {
    return store.recentEvents(ACTIVITY_KINDS, limit).map((e) => {
      const d = e.data;
      const one = (v: unknown, max = 90) => clip(String(v ?? "").replace(/\s+/g, " "), max);
      switch (e.kind) {
        case "user_message":
          return { ts: e.ts, mark: "said", text: `you: ${one(d.text)}` };
        case "assistant_message":
          return { ts: e.ts, mark: "said", text: `woody: ${one(d.text)}` };
        case "tool_use":
          return { ts: e.ts, mark: "tool", text: one(d.name) };
        case "wake":
          return { ts: e.ts, mark: "woke", text: d.goal ? `goal #${d.goal} (${d.kind})` : one(d.headline ?? d.source) };
        case "goal_checkpoint":
          return { ts: e.ts, mark: "saved", text: `checkpoint goal #${d.id} · ${d.status}` };
        case "goal_created":
          return { ts: e.ts, mark: "saved", text: `${d.owner === "woody" ? "woody proposed" : "new"} goal #${d.id} · ${one(d.title, 60)}` };
        case "goal_reviewed":
          return { ts: e.ts, mark: "saved", text: `reviewed goal #${d.id} · ${d.status}` };
        case "goal_accepted":
          return { ts: e.ts, mark: "said", text: `you accepted goal #${d.id}` };
        case "goal_dropped":
          return { ts: e.ts, mark: "said", text: `goal #${d.id} dropped` };
        case "memory_created":
          return { ts: e.ts, mark: "saved", text: `remembered #${d.id} (${d.kind}, ${d.origin})` };
        case "alarm_set":
          return { ts: e.ts, mark: "saved", text: `alarm #${d.id} set · ${one(d.reason, 60)}` };
        case "session_tainted":
          return { ts: e.ts, mark: "tool", text: `read the web · ${one(d.source, 60)}` };
        case "study_started":
          return { ts: e.ts, mark: "woke", text: `${d.owner === "woody" ? "woody began a study of its own" : "a study began"} · ${one(d.subject, 70)}` };
        case "study_read":
          return { ts: e.ts, mark: "saved", text: `study #${d.id}: the reading is finished · ${d.notes} findings from ${d.pages} pages` };
        case "study_done":
          return { ts: e.ts, mark: "said", text: `study done · ${one(d.subject, 60)} · its explainer is thing ${d.thing}` };
        case "study_dropped":
          return { ts: e.ts, mark: "problem", text: `${e.actor === "operator" ? "you dropped the study" : "study given up"} · ${one(d.subject, 50)} · ${one(d.outcome, 60)}` };
        case "identity_changed":
          return { ts: e.ts, mark: "saved", text: `woody changed its identity (version ${d.version}) · ${one(d.reason, 60)}` };
        case "identity_restored":
          return { ts: e.ts, mark: "said", text: `you put identity version ${d.restored} back` };
        case "method_changed":
          return { ts: e.ts, mark: "saved", text: `woody ${d.new ? "added a section to" : "rewrote a section of"} its methods · ${one(d.title, 40)} · ${one(d.reason, 60)}` };
        case "method_removed":
          return { ts: e.ts, mark: "saved", text: `woody removed a section of its methods · ${one(d.title, 40)}` };
        case "method_restored":
          return { ts: e.ts, mark: "said", text: `you put a section of its methods back · ${one(d.title, 40)}` };
        case "method_updated":
          return { ts: e.ts, mark: "saved", text: `a section of its methods came with an update of the program · ${one(d.section, 40)}` };
        case "face_changed":
          return { ts: e.ts, mark: "saved", text: `${e.actor === "operator" ? "you restored" : d.new && d.invented ? "woody invented" : "woody redrew"} the lattice's "${one(d.name, 24)}"${d.reason && e.actor !== "operator" ? ` · ${one(d.reason, 60)}` : ""}` };
        case "face_reset":
          return { ts: e.ts, mark: "saved", text: `${e.actor === "operator" ? "you put" : "woody put"} the lattice's "${one(d.name, 24)}" back to ${d.invented ? "nothing (removed)" : "the built-in design"}` };
        case "approval_parked":
          return { ts: e.ts, mark: "saved", text: `waiting for your approval · ${one(d.action)}` };
        case "system_changed":
          return { ts: e.ts, mark: "problem", text: one(d.text) };
        case "own_time":
          return { ts: e.ts, mark: "woke", text: `time of its own · ${d.problem ? "it stopped early" : d.nothing ? "it chose to do nothing" : Array.isArray(d.left) && d.left.length ? `put ${d.left.map((t) => `"${t}"`).join(", ")} on the canvas` : "used it"}` };
        case "interest_added":
          return { ts: e.ts, mark: "saved", text: `${d.source === "operator" ? "you suggested" : "new"} interest #${d.id} · ${one(d.topic, 60)}` };
        case "interest_dropped":
          return { ts: e.ts, mark: "saved", text: `${e.actor === "operator" ? "you removed" : "woody dropped"} interest #${d.id} · ${one(d.topic, 60)}` };
        case "api_error":
          return { ts: e.ts, mark: "problem", text: `model API refused · ${one(d.text, 60)}` };
        default:
          return { ts: e.ts, mark: "problem", text: "restarted in the middle of work" };
      }
    });
  }

  /** The identity as the operator's record shows it: the current text, the first one, every version and where it stands. */
  function identityRecord(): Record<string, unknown> {
    return {
      current: store.identity(),
      history: store.identityHistory(),
      anchor: store.identityAnchor(),
      state: store.identityState(),
    };
  }

  /** Woody's methods as the operator's record shows them: each section as it stands, and its versions. */
  function methodsRecord(): Record<string, unknown> {
    const sections = store.methods();
    return {
      sections,
      // Sections that were removed, each with its last text: the operator can bring one back.
      removed: store.methodsRemoved(),
      history: Object.fromEntries(sections.map((m) => [m.section, store.methodHistory(m.section, 12)])),
      limits: { max_chars: METHODS.maxChars, max_sections: METHODS.maxSections },
    };
  }

  /** The lattice's designs as the operator's record and the frame need them. */
  function faceRecord(): Record<string, unknown> {
    const designs = store.face();
    return {
      version: store.faceVersion(),
      designs,
      history: Object.fromEntries(store.faceNames().map((name) => [name, store.faceHistory(name, 8)])),
    };
  }

  /** A goal as the HUD shows it, with its thread. */
  function goalDetail(id: number): Record<string, unknown> {
    const goal = store.goal(id);
    if (!goal) throw new PolicyError(`no goal #${id}`);
    const messages = store.recentMessages(goal.thread_id, 200).map(historyItem).filter((i) => i !== null);
    return { goal, messages };
  }

  // ---- the operator's access to the mind -----------------------------------
  //
  // Requests on the socket come from the human side (root, or the HUD gateway),
  // never from the model. Edits made here are recorded as the operator's.

  function mindRequest(msg: Record<string, unknown>): unknown {
    const id = Number(msg.id);
    const needId = () => {
      if (!Number.isInteger(id) || id <= 0) throw new PolicyError("an id is required");
      return id;
    };
    switch (msg.op) {
      case "stats":
        return store.stats();
      case "memories": {
        const kind = MEMORY_KINDS.includes(msg.kind as MemoryKind) ? (msg.kind as MemoryKind) : undefined;
        const all = Boolean(msg.all);
        return typeof msg.query === "string" && msg.query.trim()
          ? store.searchMemories(msg.query, { limit: 30, kind, includeSuperseded: all })
          : store.listMemories({ kind, includeSuperseded: all, limit: 200 });
      }
      case "memory":
        return store.history(needId());
      case "pin":
        return store.setPinned(needId(), true);
      case "unpin":
        return store.setPinned(needId(), false);
      case "forget":
        return { deleted: store.forget(needId(), "operator") };
      case "correct":
        if (typeof msg.statement !== "string") throw new PolicyError("a statement is required");
        return store.supersede(needId(), { statement: msg.statement, origin: "user", actor: "operator" });
      case "add": {
        if (typeof msg.statement !== "string") throw new PolicyError("a statement is required");
        const kind = MEMORY_KINDS.includes(msg.kind as MemoryKind) ? (msg.kind as MemoryKind) : "fact";
        return store.remember({
          kind,
          statement: msg.statement,
          subject: typeof msg.subject === "string" ? msg.subject : undefined,
          origin: "user",
          pinned: Boolean(msg.pinned),
          actor: "operator",
        }).memory;
      }
      case "journal": {
        const n = Math.min(100, Math.max(1, Number(msg.n) || 10));
        return typeof msg.query === "string" && msg.query.trim() ? store.searchJournal(msg.query, n) : store.latestJournal(n);
      }
      case "activity":
        return activity(Math.min(60, Math.max(1, Number(msg.n) || 20)));
      case "goals":
        return { goals: store.goals({ includeClosed: Boolean(msg.all) }), small_goal_usd: smallGoalLimit(woody) };
      case "goal":
        return goalDetail(needId());
      case "inbox":
        return store.inbox();
      case "goal_add": {
        if (typeof msg.title !== "string") throw new PolicyError("a title is required");
        const g = store.addGoal({ title: msg.title, description: typeof msg.description === "string" ? msg.description : "", owner: "operator" });
        void pump();
        return g;
      }
      case "goal_edit":
        return store.editGoal(needId(), {
          title: typeof msg.title === "string" ? msg.title : undefined,
          description: typeof msg.description === "string" ? msg.description : undefined,
        });
      case "goal_accept": {
        if (store.goal(needId())?.status === "proposed") moment("sparkle");
        const g = store.acceptGoal(needId(), typeof msg.budget_usd === "number" && msg.budget_usd > 0 ? msg.budget_usd : undefined);
        void pump();
        return g;
      }
      case "goal_drop":
        return store.dropGoal(needId(), "operator", typeof msg.reason === "string" ? msg.reason : "");
      case "goal_move":
        store.moveGoal(needId(), msg.where === "down" ? "down" : msg.where === "top" ? "top" : "up");
        return store.goals();
      case "goal_message":
        if (typeof msg.text !== "string" || !msg.text.trim()) throw new PolicyError("a message is required");
        operatorGoalMessage(needId(), msg.text.trim().slice(0, 20_000));
        return { sent: true };
      case "standing":
        return store.setStanding(needId(), {
          enabled: typeof msg.enabled === "boolean" ? msg.enabled : undefined,
          cadence_minutes: typeof msg.cadence_minutes === "number" ? msg.cadence_minutes : undefined,
          weekly_usd: typeof msg.weekly_usd === "number" ? msg.weekly_usd : undefined,
        });
      case "small_goal_limit": {
        const v = Number(msg.usd);
        if (!(v >= 0 && v <= 100)) throw new PolicyError("the limit must be between 0 and 100 dollars");
        store.setMeta("small_goal_usd", String(v));
        store.event("small_goal_limit", { usd: v }, { actor: "operator" });
        return { small_goal_usd: v };
      }
      case "alarms":
        return store.pendingAlarms();
      case "alarm_cancel":
        store.cancelAlarm(needId(), "operator");
        return store.pendingAlarms();
      case "identity":
        return identityRecord();
      case "identity_restore":
        store.restoreIdentity(needId());
        // The identity is part of the system prompt: the working context starts afresh with it.
        state.sessionId = undefined;
        return identityRecord();
      case "identity_seen":
        store.seeIdentity();
        return identityRecord();
      case "identity_continue":
        store.continueIdentity();
        return identityRecord();
      case "identity_freeze":
        if (typeof msg.frozen !== "boolean") throw new PolicyError("frozen must be true or false");
        store.freezeIdentity(msg.frozen);
        return identityRecord();
      case "methods":
        return methodsRecord();
      case "method_restore":
        // The operator puts an earlier version of one section back.
        if (typeof msg.section !== "string") throw new PolicyError("a section's name is required");
        store.restoreMethod(msg.section, needId());
        return methodsRecord();
      case "method_remove":
        // The operator removes a section Woody had added. One that came with the program is put back to an earlier version instead.
        if (typeof msg.section !== "string") throw new PolicyError("a section's name is required");
        store.removeMethod(msg.section, "removed by the operator", "operator");
        return methodsRecord();
      case "face":
        return faceRecord();
      case "face_restore": {
        // Back to an earlier version of one design, or (with no id) to the built-in one.
        if (typeof msg.name !== "string") throw new PolicyError("a design's name is required");
        if (typeof msg.id === "number") store.restoreFace(msg.name, msg.id);
        else store.resetFace(msg.name, "put back by the operator", "operator");
        return faceRecord();
      }
      case "identity_set":
        // The operator rewrites the identity directly.
        if (typeof msg.text !== "string") throw new PolicyError("the identity text is required");
        store.setIdentity(msg.text);
        state.sessionId = undefined;
        return identityRecord();
      case "brief": {
        if (typeof msg.time === "string") {
          if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(msg.time)) throw new PolicyError("the time must look like 08:00");
          store.setMeta("brief_time", msg.time);
        }
        if (typeof msg.enabled === "boolean") store.setMeta("brief_off", msg.enabled ? null : "1");
        if (msg.now === true) {
          const since = Number(store.getMeta("last_brief_ts") ?? 0) || Date.now() - 86_400_000;
          store.setMeta("last_brief_ts", String(Date.now()));
          store.enqueue({ source: "brief", kind: "daily", priority: 2, payload: { kind: "daily", since } });
          void pump();
        }
        return { time: briefTime(), enabled: store.getMeta("brief_off") !== "1" };
      }
      case "life": {
        // Woody's own life, for the operator to see: its day, its share, its interests, what it did with its time.
        const r = rhythm();
        return {
          ...lifeNow(),
          next: ownNext(),
          budget: budget.status().own,
          session_usd: cfg.ownSessionCapUsd,
          today: store.eventsSince(dayStartOf(dayKey(new Date(), r), r), ["own_time"]).map((e) => ({ ts: e.ts, ...e.data })),
          interests: store.interests({ includeDropped: true }),
          journal: store.journalOfThread(ownThread, 20),
        };
      }
      case "interest_suggest":
        if (typeof msg.topic !== "string") throw new PolicyError("a topic is required");
        return store.addInterest({ topic: msg.topic, origin: "the operator suggested it", source: "operator" });
      case "studies":
        // The record of studies: what is being learned, what was found, and the pages that were read.
        return { studies: store.studies({ includeClosed: true }), sizes: STUDY_SIZES, limits: { max_budget_usd: STUDY.maxBudgetUsd, max_readings: STUDY.maxReadingsEver } };
      case "study_add": {
        if (typeof msg.subject !== "string") throw new PolicyError("a subject is required");
        const size = msg.size === "small" || msg.size === "large" ? msg.size : "medium";
        store.addStudy({ subject: msg.subject, why: typeof msg.why === "string" && msg.why.trim() ? msg.why : "The operator asked for it from the studies record.", owner: "operator", ...STUDY_SIZES[size] });
        return { studies: store.studies({ includeClosed: true }) };
      }
      case "study_drop":
        store.dropStudy(needId(), "operator", typeof msg.reason === "string" ? msg.reason : "");
        return { studies: store.studies({ includeClosed: true }) };
      case "study_size":
        store.setStudySize(needId(), Number(msg.budget_usd), Number(msg.max_readings));
        return { studies: store.studies({ includeClosed: true }) };
      case "interest_drop":
        return store.dropInterest(needId(), "operator", typeof msg.reason === "string" ? msg.reason : "removed by the operator");
      case "own_time": {
        if (typeof msg.enabled !== "boolean") throw new PolicyError("enabled must be true or false");
        store.setMeta("own_time_off", msg.enabled ? null : "1");
        store.event("own_time_switch", { enabled: msg.enabled }, { actor: "operator" });
        return lifeNow();
      }
      case "rhythm": {
        const next = { dayStart: parseClock(msg.day_start) ?? rhythm().dayStart, nightStart: parseClock(msg.night_start) ?? rhythm().nightStart };
        if (!validRhythm(next)) throw new PolicyError("the night must last between two and sixteen hours");
        store.setMeta("day_start", clockText(next.dayStart));
        store.setMeta("night_start", clockText(next.nightStart));
        store.event("rhythm_changed", { day_start: clockText(next.dayStart), night_start: clockText(next.nightStart) }, { actor: "operator" });
        core.forgetInner();
        return lifeNow();
      }
      case "reflect_now": {
        const since = Number(store.getMeta("last_reflect_ts") ?? 0) || Date.now() - 86_400_000;
        store.setMeta("last_reflect_ts", String(Date.now()));
        store.enqueue({ source: "reflect", kind: "manual", priority: 3, payload: { since } });
        void pump();
        return { queued: true };
      }
      default:
        throw new PolicyError("unknown mind operation");
    }
  }

  return { mindRequest, activity };
}
