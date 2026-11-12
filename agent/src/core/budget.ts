// Spend ledger and pacer. Every model call's cost, as reported by the SDK,
// is appended to a JSONL file.
//
// The monthly cap gates everything, including replies to the operator. Under
// it there are two ledgers, each paced by the day (the amount is spread evenly
// over the month and unused days roll over):
//  * the operator's side: their conversations, and the work Woody does for
//    them unasked (goals, wake-ups, studies they asked for). The pace gates
//    that unasked work, and a reserve is always kept so that Woody can still
//    answer;
//  * Woody's own share, for its interests and its own projects. It is counted
//    apart: what the operator's conversations cost does not use it up, and
//    what Woody spends on itself does not slow the operator's work.
import fs from "node:fs";
import path from "node:path";

export type BudgetStatus = {
  month: string;
  spent_usd: number;
  cap_usd: number;
  remaining_usd: number;
  exhausted: boolean;
  /** One day's share of the operator's side of the cap. */
  daily_usd: number;
  /** What Woody may spend on its own right now (0 when it must rest). */
  autonomous_usd: number;
  /** Woody's own share: the month's amount, what it has used, and what it may use right now. */
  own: { share_usd: number; spent_usd: number; available_usd: number };
};

export type SpendKind = "chat" | "background" | "autonomous" | "own";

/** What a session used in tokens, as the SDK reports it. */
export type Tokens = { in: number; out: number; cache_read: number; cache_write: number };

function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/** How much of the month's cap has been "released" by this day, and one day's share. */
export function pace(capUsd: number, date: Date): { released: number; daily: number } {
  const days = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  const daily = capUsd / days;
  return { released: daily * date.getUTCDate(), daily };
}

/**
 * What unasked work for the operator may spend now: everything released so far
 * this month on their side, minus what was spent there, minus a reserve of
 * half a day's share kept for answering them. Never more than what is left.
 */
export function autonomousAllowance(capUsd: number, spentUsd: number, date: Date): number {
  const { released, daily } = pace(capUsd, date);
  const free = released - spentUsd - daily * 0.5;
  return Math.max(0, Math.min(free, capUsd - spentUsd));
}

/**
 * What Woody may spend on itself now: its share of the month released so far,
 * minus what it has used of it. Unused days roll over within the month.
 */
export function ownAllowance(ownCapUsd: number, ownSpentUsd: number, date: Date): number {
  const { released } = pace(ownCapUsd, date);
  return Math.max(0, Math.min(released - ownSpentUsd, ownCapUsd - ownSpentUsd));
}

export class Budget {
  private readonly file: string;
  private month: string;
  private spent = 0;
  private ownSpent = 0;
  /** Injectable clock, for tests. */
  now: () => Date = () => new Date();

  /** `ownShare` is the fraction of the cap that is Woody's own (0 to 0.9). */
  constructor(stateDir: string, private readonly capUsd: number, private readonly ownShare = 0) {
    this.ownShare = Math.min(0.9, Math.max(0, Number.isFinite(ownShare) ? ownShare : 0));
    this.file = path.join(stateDir, "usage.jsonl");
    this.month = monthKey(this.now());
    this.reload();
  }

  private reload(): void {
    this.month = monthKey(this.now());
    this.spent = 0;
    this.ownSpent = 0;
    let text = "";
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch {
      return;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as { ts?: string; cost_usd?: number; kind?: string };
        if (entry.ts?.startsWith(this.month) && typeof entry.cost_usd === "number") {
          this.spent += entry.cost_usd;
          if (entry.kind === "own") this.ownSpent += entry.cost_usd;
        }
      } catch {
        // A damaged line is skipped, not fatal.
      }
    }
  }

  record(entry: { kind: SpendKind; model: string; cost_usd: number; session?: string; source?: string; turns?: number; tokens?: Tokens }): void {
    if (monthKey(this.now()) !== this.month) this.reload();
    this.spent += entry.cost_usd;
    if (entry.kind === "own") this.ownSpent += entry.cost_usd;
    const line = JSON.stringify({ ts: this.now().toISOString(), ...entry }) + "\n";
    try {
      fs.appendFileSync(this.file, line, { mode: 0o600 });
    } catch (err) {
      console.error("budget: could not write usage ledger:", err);
    }
  }

  status(): BudgetStatus {
    const date = this.now();
    if (monthKey(date) !== this.month) this.reload();
    const remaining = Math.max(0, this.capUsd - this.spent);
    const ownCap = this.capUsd * this.ownShare;
    // The operator's side: the cap without Woody's share, and what was spent outside it.
    const autonomous = Math.min(remaining, autonomousAllowance(this.capUsd - ownCap, this.spent - this.ownSpent, date));
    return {
      month: this.month,
      spent_usd: Number(this.spent.toFixed(4)),
      cap_usd: this.capUsd,
      remaining_usd: Number(remaining.toFixed(4)),
      exhausted: remaining <= 0,
      daily_usd: Number(pace(this.capUsd - ownCap, date).daily.toFixed(4)),
      autonomous_usd: Number(autonomous.toFixed(4)),
      own: {
        share_usd: Number(ownCap.toFixed(2)),
        spent_usd: Number(this.ownSpent.toFixed(4)),
        // Counted apart from the operator's side; the monthly cap still bounds it.
        available_usd: Number(Math.min(remaining, ownAllowance(ownCap, this.ownSpent, date)).toFixed(4)),
      },
    };
  }
}
