// The loop: Woody handles one queue of events, one at a time. The operator's
// messages come first; then what Woody does by itself, if it may: work on a
// goal, a study the operator asked for, or a moment of its own.
import { clockText } from "../mind/life.js";
import { MAX_AUTONOMOUS_PER_HOUR, MIN_AUTONOMOUS_USD } from "./config.js";
import type { Core, MindStateName } from "./core.js";
import { PolicyError } from "./store.js";
import { hhmm } from "./text.js";

export function createQueue(core: Core) {
  const { store, budget, apiBlock, broadcast, moment, setMind, hasCredential } = core;
  const thread = core.threads.main;
  const asleep = () => core.asleep();
  const rhythm = () => core.rhythm();
  const ownDecision = () => core.ownDecision();
  const runSession = (item: Parameters<Core["runSession"]>[0]) => core.runSession(item);
  const stateMessage = () => core.stateMessage();
  const operatorPresent = () => core.operatorPresent();

  // ---- the loop ------------------------------------------------------------


  /**
   * Why Woody may not act on its own right now (with the reason in words), or
   * null if it may. `forOwn` asks about a moment of its own: that is paid from
   * Woody's own share, so the pace of the operator's side does not hold it back
   * (whether its own share allows it is part of the decision in mind/life.ts).
   */
  function autonomyBlock(forOwn = false): { state: MindStateName; why: string } | null {
    if (core.paused) return { state: "paused", why: "You paused Woody." };
    if (!hasCredential()) return { state: "no_credential", why: "No API key is configured." };
    if (Date.now() < apiBlock.until) return { state: "api_error", why: `${apiBlock.reason} Trying again at ${hhmm(apiBlock.until)}.` };
    const b = budget.status();
    if (b.exhausted) return { state: "out_of_allowance", why: `The monthly cap of $${b.cap_usd} is spent.` };
    if (!forOwn && b.autonomous_usd < MIN_AUTONOMOUS_USD) {
      return {
        state: "out_of_allowance",
        why: `Spent $${b.spent_usd.toFixed(2)} this month; the daily pace for work it does for you unasked ($${b.daily_usd.toFixed(2)} a day) has not released more yet. It refills at midnight UTC.`,
      };
    }
    if (store.autonomousHandledSince(Date.now() - 3_600_000) >= MAX_AUTONOMOUS_PER_HOUR) {
      return {
        state: "pacing",
        why: `${MAX_AUTONOMOUS_PER_HOUR} sessions started by itself in the last hour (the ceiling). Next one at ${hhmm(store.autonomousSlotFreeAt(3_600_000, MAX_AUTONOMOUS_PER_HOUR))}.`,
      };
    }
    return null;
  }

  function restingState(): void {
    const depth = store.queueDepth();
    const block = autonomyBlock();
    const waiting = store.activeWatches().filter((w) => w.kind === "approval").length;
    const next = store.pendingAlarms()[0];
    // Work is held back if something is queued, or a goal is waiting for Woody's attention.
    const held = depth.autonomous > 0 || store.nextGoalWork() !== null;
    if (block && (held || block.state === "paused" || block.state === "api_error")) setMind(block.state, block.why);
    else if (waiting) setMind("waiting", `${waiting} request(s) need your decision`);
    else if (asleep()) setMind("sleeping", `until ${clockText(rhythm().dayStart)}`);
    else setMind("resting", next ? `until ${new Date(next.due).toISOString().slice(11, 16)} UTC: ${next.reason}` : "");
  }

  let pumping = false;

  /** Handles queued events one at a time: the operator's first, then Woody's own. */
  async function pump(): Promise<void> {
    if (pumping || core.session) return;
    pumping = true;
    try {
      for (;;) {
        let item = store.claimNext({ operatorOnly: true });
        if (item) {
          // Replies to the operator are gated only by the credential and the monthly cap.
          const refusal = !hasCredential()
            ? { error: "no-credential", detail: "No Claude API key is configured for the agent service." }
            : budget.status().exhausted
              ? { error: "budget-exhausted", detail: `Monthly cap of $${budget.status().cap_usd} reached.` }
              : null;
          if (refusal) {
            store.finishQueued(item.id, "dropped", refusal.error);
            broadcast({ type: "error", ...refusal });
            continue;
          }
        } else if (!autonomyBlock()) {
          item = store.claimNext();
          if (!item) {
            // Nothing is waiting: work towards a goal. The operator's goals are
            // worked on at any hour; standing duties and Woody's own time wait for the day.
            const work = store.nextGoalWork();
            const sleeping = asleep();
            if (work && !(sleeping && work.kind === "standing")) {
              store.enqueue({
                source: "goal",
                kind: work.kind,
                priority: work.kind === "review" ? 6 : work.kind === "work" ? 7 : 8,
                payload: { goal: work.goal.id, kind: work.kind, title: work.goal.title },
              });
              item = store.claimNext();
            } else {
              // A study the operator asked for is their work too: it is read for at any hour.
              const studyWork = store.nextStudyWork("operator");
              if (studyWork) {
                store.enqueue({
                  source: "study",
                  kind: studyWork.kind,
                  priority: 8,
                  payload: { study: studyWork.study.id, kind: studyWork.kind, subject: studyWork.study.subject },
                  dedupe: `study-${studyWork.study.id}`,
                });
                item = store.claimNext();
              } else if (!sleeping) {
                // Nothing is asked of it at all: perhaps a moment of its own.
                const decision = ownDecision();
                if (decision.start) {
                  // A study of its own moves forward in its own moments, one session at a time.
                  const mine = decision.kind === "free" ? store.nextStudyWork("woody") : null;
                  store.enqueue({
                    source: "own",
                    kind: decision.kind,
                    priority: 9,
                    payload: { kind: decision.kind, why: decision.why, ...(mine ? { study: mine.study.id } : {}) },
                    dedupe: "own",
                  });
                  item = store.claimNext();
                }
              }
            }
          }
        } else if (!autonomyBlock(true) && !asleep()) {
          // The pace of the operator's side holds unasked work for them back.
          // Woody's own share is counted apart: it may still take a moment of its own.
          const decision = ownDecision();
          if (decision.start) {
            const mine = decision.kind === "free" ? store.nextStudyWork("woody") : null;
            store.enqueue({
              source: "own",
              kind: decision.kind,
              priority: 9,
              payload: { kind: decision.kind, why: decision.why, ...(mine ? { study: mine.study.id } : {}) },
              dedupe: "own",
            });
          }
          item = store.claimNext({ ownOnly: true });
        }
        // A moment of its own that waited in line (something else came first, or a
        // restart) is only taken if it is still the moment for one.
        if (item?.source === "own" && (asleep() || !ownDecision().start)) {
          store.finishQueued(item.id, "dropped", "no longer the moment for it");
          continue;
        }
        if (!item) break;
        await runSession(item);
      }
    } finally {
      pumping = false;
      restingState();
      broadcast(stateMessage());
    }
  }

  /** A message from the operator: recorded at once, answered as soon as possible. */
  function operatorMessage(text: string): void {
    operatorPresent();
    if (/\b(thanks|thank you|thx|merci)\b/i.test(text)) moment("heart");
    const event = store.event("user_message", { text }, { thread, actor: "operator" });
    store.addMessage(thread, "user", "text", text);
    // While a conversation is going on, Woody stays with it rather than taking time of its own.
    store.setMeta("last_operator_message", String(Date.now()));
    const queueId = store.enqueue({ source: "operator", kind: "message", payload: { text, event }, priority: 1 })!;
    broadcast({ type: "user_text", text });
    core.session?.arrivals.push({ queueId, event, text });
    void pump();
  }

  /** The operator writes in a goal's thread: Woody answers there. */
  function operatorGoalMessage(goalId: number, text: string): void {
    const goal = store.goal(goalId);
    if (!goal) throw new PolicyError(`no goal #${goalId}`);
    if (goal.status === "done" || goal.status === "dropped") throw new PolicyError("this goal is closed");
    const event = store.event("user_message", { text, goal: goalId }, { thread: goal.thread_id, actor: "operator" });
    store.addMessage(goal.thread_id, "user", "text", text);
    store.enqueue({ source: "operator", kind: "goal_message", payload: { text, event, goal: goalId }, priority: 1 });
    broadcast({ type: "user_text", text, thread: goal.thread_id });
    broadcast({ type: "goals_changed" });
    void pump();
  }

  return { autonomyBlock, restingState, pump, operatorMessage, operatorGoalMessage };
}
