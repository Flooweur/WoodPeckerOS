// Spend ledger and pacer. Every model call's cost, as reported by the SDK,
// is appended to a JSONL file.
//
// Two limits come out of it:
//  * the monthly cap gates everything, including replies to the operator;
//  * the pace gates what Woody does on its own: the cap is spread evenly
//    over the month, unused days roll over, and a reserve is always kept so
//    that Woody can still answer the operator.
import fs from "node:fs";
import path from "node:path";

export type BudgetStatus = {
  month: string;
  spent_usd: number;
  cap_usd: number;
  remaining_usd: number;
  exhausted: boolean;
  /** One day's share of the monthly cap. */
  daily_usd: number;
  /** What Woody may spend on its own right now (0 when it must rest). */
  autonomous_usd: number;
};

export type SpendKind = "chat" | "background" | "autonomous";

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
 * What autonomous work may spend now: everything released so far this month,
 * minus what was spent, minus a reserve of half a day's share kept for the
 * operator. Never more than what is left of the monthly cap.
 */
export function autonomousAllowance(capUsd: number, spentUsd: number, date: Date): number {
  const { released, daily } = pace(capUsd, date);
  const free = released - spentUsd - daily * 0.5;
  return Math.max(0, Math.min(free, capUsd - spentUsd));
}

export class Budget {
  private readonly file: string;
  private month: string;
  private spent = 0;
  /** Injectable clock, for tests. */
  now: () => Date = () => new Date();

  constructor(stateDir: string, private readonly capUsd: number) {
    this.file = path.join(stateDir, "usage.jsonl");
    this.month = monthKey(this.now());
    this.reload();
  }

  private reload(): void {
    this.month = monthKey(this.now());
    this.spent = 0;
    let text = "";
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch {
      return;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as { ts?: string; cost_usd?: number };
        if (entry.ts?.startsWith(this.month) && typeof entry.cost_usd === "number") {
          this.spent += entry.cost_usd;
        }
      } catch {
        // A damaged line is skipped, not fatal.
      }
    }
  }

  record(entry: { kind: SpendKind; model: string; cost_usd: number; session?: string }): void {
    if (monthKey(this.now()) !== this.month) this.reload();
    this.spent += entry.cost_usd;
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
    return {
      month: this.month,
      spent_usd: Number(this.spent.toFixed(4)),
      cap_usd: this.capUsd,
      remaining_usd: Number(remaining.toFixed(4)),
      exhausted: remaining <= 0,
      daily_usd: Number(pace(this.capUsd, date).daily.toFixed(4)),
      autonomous_usd: Number(autonomousAllowance(this.capUsd, this.spent, date).toFixed(4)),
    };
  }
}
