// What the clock brings: the pulse.
//
// The pulse is plain code. Once a minute it looks at the clock, at what Woody
// is waiting for and at the system, and queues events: an alarm that is due,
// a decided approval, a finished job, something wrong on the machine, the
// daily brief, the reflection, the day's end. A model runs only if the queue
// then has something in it.
import fs from "node:fs";
import path from "node:path";
import { dayEnd, dayKey, dayStartOf, phaseAt, reflectKey, type Rhythm } from "../mind/life.js";
import { DEFAULT_BRIEF_TIME, MAX_TRIAGE_PER_DAY } from "./config.js";
import type { Core } from "./core.js";
import { TRIAGE_MODEL } from "./models.js";
import { checkSystem, systemChange, triage } from "./pulse.js";
import { clip } from "./text.js";

export function createDaily(core: Core) {
  const { cfg, store, budget, exec, broadcast, moment, hasCredential, recordAsideCost } = core;
  const thread = core.threads.main;
  const ownThread = core.threads.own;
  const pump = () => core.pump();
  const rhythm = () => core.rhythm();
  const ownEnabled = () => core.ownEnabled();

  /** Follows what Woody is waiting for; a finished job or a decided approval becomes an event. */
  async function checkWatches(): Promise<void> {
    for (const w of store.activeWatches()) {
      try {
        if (w.kind === "approval") {
          const reply = await exec.wait(w.ref, 0);
          if (reply.status === "pending") continue;
          const lost = reply.status === "error" && /unknown approval_id/.test(reply.error);
          store.closeWatch(w.id);
          store.enqueue({
            source: "approval",
            kind: "approval_decided",
            priority: 2,
            payload: {
              action: w.data.action,
              params: w.data.params,
              status: lost ? "lost" : reply.status,
              outcome: lost
                ? "The request was lost because the executor restarted before the operator decided. Ask again if it is still needed."
                : reply.status === "ok"
                  ? reply.result
                  : reply.status === "denied"
                    ? reply.reason
                    : reply.error,
            },
          });
          broadcast({ type: "approval_resolved", approval_id: w.ref, status: reply.status });
          // An approved configuration change has now started: follow it too.
          const candidate = (w.data.params as { candidate?: unknown } | undefined)?.candidate;
          if (w.data.action === "config.apply" && reply.status === "ok" && typeof candidate === "string") store.addWatch("config", candidate);
        } else if (w.kind === "config") {
          const reply = await exec.action("config.status", { candidate: w.ref });
          if (reply.status !== "ok") continue;
          const st = reply.result as { finished?: boolean; state?: string; message?: string; summary?: string };
          if (!st.finished) continue;
          store.closeWatch(w.id);
          store.enqueue({
            source: "job",
            kind: "config_finished",
            priority: 3,
            dedupe: `config:${w.ref}`,
            payload: {
              headline: `The configuration change "${st.summary ?? w.ref}" finished: ${st.state}.`,
              detail: `Candidate ${w.ref}. ${st.message ?? ""}`,
            },
          });
        }
      } catch {
        // The executor may be restarting; try again at the next pulse.
      }
    }
  }

  let triageToday = { day: "", count: 0 };

  async function checkSystemEvents(): Promise<void> {
    const findings = await checkSystem(exec, store, Math.ceil((cfg.systemEvery * cfg.pulseMs) / 60_000) + 1);
    for (const f of findings) {
      const payload = { headline: f.headline, detail: f.detail };
      if (!f.needsTriage) {
        store.enqueue({ source: "system", kind: f.kind, payload, priority: f.priority, dedupe: f.dedupe, dedupeWindowMs: f.dedupeWindowMs });
        continue;
      }
      // Deduplicate before spending anything on triage.
      const marker = store.enqueue({ source: "system", kind: `${f.kind}_seen`, payload, priority: 9, dedupe: f.dedupe, dedupeWindowMs: f.dedupeWindowMs });
      if (marker === null) continue;
      const day = new Date().toISOString().slice(0, 10);
      if (triageToday.day !== day) triageToday = { day, count: 0 };
      let verdict: "ignore" | "note" | "wake" = "note";
      if (hasCredential() && !budget.status().exhausted && triageToday.count < MAX_TRIAGE_PER_DAY) {
        triageToday.count += 1;
        try {
          verdict = await triage(f, TRIAGE_MODEL, cfg.workspace, recordAsideCost);
        } catch {
          verdict = "note";
        }
      }
      store.event("triage", { kind: f.kind, headline: f.headline, verdict });
      if (verdict === "wake") {
        store.finishQueued(marker, "dropped", "triage: wake");
        store.enqueue({ source: "system", kind: f.kind, payload, priority: f.priority });
      } else {
        store.finishQueued(marker, "dropped", `triage: ${verdict}`);
        if (verdict === "note") {
          store.addJournal({ thread, wake: "A routine check of the system log.", did: "Filtered the new errors without waking fully.", outcome: `Noted: ${f.headline} ${clip(f.detail, 300)}` });
        }
      }
    }
  }

  /** One consistent copy of the store per day, kept for 30 days. */
  function dailyBackup(): void {
    const day = new Date().toISOString().slice(0, 10);
    if (store.getMeta("last_backup") === day) return;
    const dir = path.join(cfg.stateDir, "backups");
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, `mind-${day}.db`);
      fs.rmSync(file, { force: true });
      store.backup(file);
      store.setMeta("last_backup", day);
      const old = fs.readdirSync(dir).filter((f) => /^mind-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
      for (const f of old.slice(0, Math.max(0, old.length - 30))) fs.rmSync(path.join(dir, f), { force: true });
    } catch (err) {
      console.error("backup failed:", err instanceof Error ? err.message : err);
    }
  }

  function briefTime(): string {
    const v = store.getMeta("brief_time") ?? DEFAULT_BRIEF_TIME;
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : DEFAULT_BRIEF_TIME;
  }

  /** Local calendar day, as YYYY-MM-DD. */
  function localDay(d = new Date()): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  /**
   * Once a day each: the brief at the time the operator chose, and the
   * reflection in the small hours, if there is anything to reflect on. Both
   * are ordinary queued events, so Pause and the pacer apply to them.
   */
  function scheduleDaily(): void {
    const now = new Date();
    const day = localDay(now);
    const hhmmNow = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

    if (store.getMeta("brief_off") !== "1" && store.getMeta("last_brief_day") !== day && hhmmNow >= briefTime()) {
      const since = Number(store.getMeta("last_brief_ts") ?? 0) || now.getTime() - 86_400_000;
      store.setMeta("last_brief_day", day);
      store.setMeta("last_brief_ts", String(now.getTime()));
      store.enqueue({ source: "brief", kind: "daily", priority: 4, payload: { kind: "daily", since }, dedupe: `brief:${day}` });
    }

    // The reflection belongs to the night: it runs once the middle of the night
    // has passed, or at the first moment awake after that if the machine was off.
    const r = rhythm();
    const reflectDay = reflectKey(now, r);
    if (store.getMeta("last_reflect_day") !== reflectDay) {
      const since = Number(store.getMeta("last_reflect_ts") ?? 0) || now.getTime() - 86_400_000;
      store.setMeta("last_reflect_day", reflectDay);
      // Nothing said and little done: nothing to reflect on today.
      if (store.operatorMessagesSince(since) > 0 || store.journalSince(since, 5).length >= 3) {
        store.setMeta("last_reflect_ts", String(now.getTime()));
        store.enqueue({ source: "reflect", kind: "daily", priority: 9, payload: { since }, dedupe: `reflect:${reflectDay}` });
      }
    }

    // The day's end: what Woody did with its own time is written down when the
    // night begins, or, if the machine was off by then, when a new day is found.
    const today = dayKey(now, r);
    const lived = store.getMeta("life_day");
    if (lived && lived !== today) closeDay(lived, r);
    if (lived !== today) store.setMeta("life_day", today);
    if (phaseAt(now, r) === "night") closeDay(today, r);
  }

  /** Writes the journal entry for one day of Woody's own time. A day of nothing is recorded as that. */
  function closeDay(key: string, r: Rhythm): void {
    if (store.getMeta("closed_day") === key) return;
    store.setMeta("closed_day", key);
    const from = dayStartOf(key, r);
    const moments = store
      .eventsSince(from, ["own_time"])
      .filter((e) => e.ts < from + 86_400_000)
      .map((e) => ({
        kind: String(e.data.kind ?? "free"),
        nothing: e.data.nothing === true,
        cost_usd: Number(e.data.cost_usd ?? 0),
        left: Array.isArray(e.data.left) ? e.data.left.map(String) : [],
        interests: Array.isArray(e.data.interests) ? e.data.interests.map(String) : [],
      }));
    const text = dayEnd(moments, ownEnabled(), store.getMeta("own_why") ?? "");
    store.addJournal({ thread: ownThread, wake: `The day ended (${key}).`, did: "Looked back at what I did with my own time.", outcome: text });
    store.event("day_end", { day: key, moments: moments.length, text });
  }

  /**
   * A sign that the operator is at the HUD (a key press, a click, a message).
   * If they were away for a while and Woody did things meanwhile, it tells
   * them what happened.
   */
  function operatorPresent(): void {
    const now = Date.now();
    const last = Number(store.getMeta("last_presence") ?? 0);
    store.setMeta("last_presence", String(now));
    if (!last || now - last < cfg.awayMs) return;
    moment("smile");
    // What it did by itself meanwhile, including with its own time (but not the moments it let pass).
    const own = store
      .journalSince(last, 60)
      .filter(
        (j) =>
          (j.wake.startsWith("I woke up by myself") && !/daily brief|catch-up|daily reflection/.test(j.wake)) ||
          (j.wake.startsWith("I had time of my own") && j.outcome !== "I chose to do nothing with it."),
      );
    if (!own.length) return;
    store.enqueue({ source: "brief", kind: "catchup", priority: 2, payload: { kind: "catchup", since: last }, dedupe: "catchup", dedupeWindowMs: cfg.awayMs });
    void pump();
  }

  let pulsing = false;
  let pulseCount = 0;

  /**
   * The pulse is plain code: it looks at the clock, at what Woody is waiting
   * for and at the system, and queues events. A model runs only if the queue
   * then has something in it.
   */
  async function pulse(): Promise<void> {
    if (pulsing) return;
    pulsing = true;
    try {
      pulseCount += 1;
      try {
        const status = await exec.status();
        core.paused = status.paused;
      } catch {
        // Executor unreachable: keep the last known value.
      }
      for (const a of store.takeDueAlarms()) {
        store.enqueue({ source: "alarm", kind: "alarm", priority: 3, payload: { id: a.id, reason: a.reason, created: a.created } });
      }
      await checkWatches();
      if (pulseCount % cfg.systemEvery === 1 || cfg.systemEvery === 1) {
        const changedNow = systemChange(store);
        if (changedNow) {
          store.addJournal({ thread, wake: "A routine check.", did: "Compared the running system with the one I last saw.", outcome: changedNow });
          store.event("system_changed", { text: changedNow });
        }
        await checkSystemEvents();
      }
      dailyBackup();
      scheduleDaily();
      // Memories stored since the last pulse get their vector, for recall by meaning.
      await core.embedPending().catch((err) => console.error("embedding failed:", err instanceof Error ? err.message : err));
    } catch (err) {
      console.error("pulse failed:", err instanceof Error ? err.message : err);
    } finally {
      pulsing = false;
    }
    void pump();
  }

  return { pulse, operatorPresent, briefTime };
}
