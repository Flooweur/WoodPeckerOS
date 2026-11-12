// Woody's life as the loop sees it at this moment: its inner state, the rhythm
// of its day, whether it would take a moment of its own now, and what such a
// moment is told. The decisions themselves are plain functions in mind/life.ts
// and mind/inner.ts; this file feeds them from the record.
import { setExtraContext, type OwnMaterial } from "../mind/context.js";
import { innerLines, innerState, type Inner } from "../mind/inner.js";
import { DEFAULT_RHYTHM, clockText, dayKey, dayStartOf, ownTime, parseClock, phaseAt, validRhythm, type OwnDecision, type Rhythm } from "../mind/life.js";
import { PRESENT_MS } from "./config.js";
import type { Core } from "./core.js";
import { STUDY, type Study } from "./store.js";

export function createLife(core: Core) {
  const { cfg, store, budget, apiBlock, canvasLink } = core;
  const failedUnits = () => core.failedUnits();

  // ---- the inner state -------------------------------------------------------

  const INNER_KINDS = ["session_end", "tool_result", "api_error", "interrupted_by_restart", "user_message", "canvas_change", "session_tainted", "wake", "identity_restored"];
  let innerCache: { at: number; inner: Inner } | null = null;

  /** Woody's inner state right now: a plain function of the record (mind/inner.ts). */
  function currentInner(): Inner {
    const now = Date.now();
    if (innerCache && now - innerCache.at < 20_000) return innerCache.inner;
    const b = budget.status();
    const inner = innerState({
      now,
      events: store.eventsSince(now - 48 * 3_600_000, INNER_KINDS),
      allowance: { autonomous_usd: b.autonomous_usd ?? 0, daily_usd: b.daily_usd ?? 0, exhausted: b.exhausted },
      failedUnits: failedUnits(),
      lastPresence: Number(store.getMeta("last_presence") ?? 0),
      waitingOnOperator: store.activeWatches().filter((w) => w.kind === "approval").length + store.inbox().length,
      newMemories: store.memoriesSince(now - 48 * 3_600_000),
      apiBlocked: apiBlock.until > now,
      night: phaseAt(new Date(now), rhythm()) === "night",
      interests: (() => {
        const open = store.interests();
        return { open: open.length, followed: open.filter((i) => i.last_followed > now - 48 * 3_600_000).length };
      })(),
    });
    innerCache = { at: now, inner };
    return inner;
  }
  setExtraContext(() => innerLines(currentInner()));

  // ---- a life of its own: the rhythm of the day, and time that is Woody's ---------

  /** Woody's day and night. The operator can change them from the HUD; the defaults come from the system's settings. */
  function rhythm(): Rhythm {
    const r = {
      dayStart: parseClock(store.getMeta("day_start")) ?? parseClock(cfg.dayStart) ?? DEFAULT_RHYTHM.dayStart,
      nightStart: parseClock(store.getMeta("night_start")) ?? parseClock(cfg.nightStart) ?? DEFAULT_RHYTHM.nightStart,
    };
    return validRhythm(r) ? r : DEFAULT_RHYTHM;
  }

  /** Asleep: it is night and nobody has been at the screen for a while. The operator's own work is still done. */
  function asleep(): boolean {
    if (phaseAt(new Date(), rhythm()) !== "night") return false;
    return Date.now() - Number(store.getMeta("last_presence") ?? 0) > PRESENT_MS;
  }

  const ownEnabled = () => store.getMeta("own_time_off") !== "1";

  /** Should Woody take a moment of its own now? The reason is kept, whichever way it goes. */
  function ownDecision(): OwnDecision {
    const now = Date.now();
    const r = rhythm();
    const inner = currentInner();
    const key = dayKey(new Date(now), r);
    const d = ownTime({
      now,
      phase: phaseAt(new Date(now), r),
      enabled: ownEnabled(),
      energy: inner.energy.value,
      ease: inner.ease.value,
      curiosity: inner.curiosity.value,
      ownUsd: budget.status().own.available_usd,
      lastOwn: Number(store.getMeta("last_own_ts") ?? 0),
      ownToday: store.eventsSince(dayStartOf(key, r), ["own_time"]).length,
      lastOperatorMessage: Number(store.getMeta("last_operator_message") ?? 0),
      tidiedToday: store.getMeta("last_tidy_day") === key,
    });
    if (store.getMeta("own_why") !== d.why) store.setMeta("own_why", d.why);
    return d;
  }

  /**
   * When Woody's next moment of its own is, in words, for the operator. Every
   * reason that holds one back is named here, not only those the decision itself
   * knows: a pause, the pace, a goal that comes first.
   */
  function ownNext(): string {
    if (core.session) return core.session.own ? "it is having one now" : "it is busy with something else, and its own time comes after that";
    const decision = ownDecision();
    if (!decision.start) return decision.why;
    const block = core.autonomyBlock(true);
    if (block) return `it would take one now, but it may not act by itself: ${block.why}`;
    const work = store.nextGoalWork();
    if (work && !(asleep() && work.kind === "standing")) return `it would take one now, but a goal comes first: "${work.goal.title}"`;
    if (store.queueDepth().autonomous > 0) return "it would take one now, but something else is waiting for it first";
    return `within a minute or two (${decision.why})`;
  }

  /** What the HUD shows of Woody's day. */
  function lifeNow(): Record<string, unknown> {
    const r = rhythm();
    return {
      phase: phaseAt(new Date(), r),
      asleep: asleep(),
      own_time: ownEnabled(),
      day_start: clockText(r.dayStart),
      night_start: clockText(r.nightStart),
    };
  }

  /** What one session of a study may spend: a reading session its share of the reading budget, the explainer what is left. */
  function studyCap(s: Study, kind: "read" | "explain"): number {
    const left = Math.max(0.05, s.budget_usd - s.spent_usd);
    return kind === "read" ? Math.min(left, Math.max(0.15, (s.budget_usd * STUDY.readShare) / s.max_readings)) : left;
  }

  type Look = {
    things?: Array<{ id: string; title: string; for: string; made_by: string; on_its_own?: boolean; pinned: boolean; running: string }>;
    own_additions?: { today: number; limit: number };
  };

  /** What a moment of Woody's own is told: the time of day, the money, its canvas. */
  async function ownMaterial(kind: "free" | "tidy"): Promise<OwnMaterial> {
    const r = rhythm();
    const b = budget.status();
    const may = Math.min(cfg.ownSessionCapUsd, b.own.available_usd);
    let canvas: string[] | null = null;
    let additions: string | null = null;
    try {
      const look = (await canvasLink.request("look", {}, 5000)) as Look;
      canvas = (look.things ?? []).map(
        (t) =>
          `- ${t.id} "${t.title}", for ${t.for === "woody" ? "yourself" : "the operator"}, made by ${t.made_by === "woody" ? (t.on_its_own ? "you, on your own" : "you") : "the operator"}` +
          `${t.pinned ? ", pinned (not yours to touch)" : ""}${/^no/.test(t.running) ? ", not running" : ""}`,
      );
      if (look.own_additions) {
        const left = Math.max(0, look.own_additions.limit - look.own_additions.today);
        additions = `${left} (the operator's limit is ${look.own_additions.limit} a day; ${look.own_additions.today} used)`;
      }
    } catch {
      // The HUD is not connected: the moment can still be spent on an interest.
    }
    return {
      kind,
      when: `${phaseAt(new Date(), r)} (your day runs from ${clockText(r.dayStart)} to ${clockText(r.nightStart)}, local time)`,
      money: `this moment may use up to $${may.toFixed(2)}. Your own share is $${b.own.share_usd.toFixed(2)} a month, of which $${b.own.spent_usd.toFixed(2)} is spent.`,
      additions,
      canvas,
    };
  }

  return {
    currentInner,
    /** Something just happened that the inner state depends on: it is computed afresh next time. */
    forgetInner: () => {
      innerCache = null;
    },
    rhythm, asleep, ownEnabled, ownDecision, ownNext, lifeNow, studyCap, ownMaterial,
  };
}
