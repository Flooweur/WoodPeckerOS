// Spend ledger. Every model call's cost, as reported by the SDK, is appended
// to a JSONL file; the monthly total gates new turns.
import fs from "node:fs";
import path from "node:path";

export type BudgetStatus = {
  month: string;
  spent_usd: number;
  cap_usd: number;
  remaining_usd: number;
  exhausted: boolean;
};

function monthKey(date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

export class Budget {
  private readonly file: string;
  private month = monthKey();
  private spent = 0;

  constructor(stateDir: string, private readonly capUsd: number) {
    this.file = path.join(stateDir, "usage.jsonl");
    this.reload();
  }

  private reload(): void {
    this.month = monthKey();
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

  record(entry: { kind: "chat" | "background"; model: string; cost_usd: number; session?: string }): void {
    if (monthKey() !== this.month) this.reload();
    this.spent += entry.cost_usd;
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    try {
      fs.appendFileSync(this.file, line, { mode: 0o600 });
    } catch (err) {
      console.error("budget: could not write usage ledger:", err);
    }
  }

  status(): BudgetStatus {
    if (monthKey() !== this.month) this.reload();
    const remaining = Math.max(0, this.capUsd - this.spent);
    return {
      month: this.month,
      spent_usd: Number(this.spent.toFixed(4)),
      cap_usd: this.capUsd,
      remaining_usd: Number(remaining.toFixed(4)),
      exhausted: remaining <= 0,
    };
  }
}
