// Feeds: the live data a thing on the canvas may read.
//
// A thing has no network and no access to the machine. What it can read comes
// through the bridge, from here: the machine's services and logs, Woody's
// goals, journal, memory and conversation, and the files in Woody's
// workbench. Everything is read-only, and nothing a thing reads can leave the
// machine, because a thing has no way out.
//
// What a feed delivers is data from many hands (log lines, files a program
// wrote, what was said). A thing only shows it; it is never treated as an
// instruction by anyone.
import { execFile } from "node:child_process";
import type { Bench } from "./files.js";

export class FeedError extends Error {}

export const FEED_NAMES = ["services", "logs", "goals", "journal", "memory", "conversation", "files", "file"] as const;
export type FeedName = (typeof FEED_NAMES)[number];

export type FeedDeps = {
  systemctl: string;
  journalctl: string;
  /** Asks the agent, as the operator's side may: the goals board, the journal, memories, the conversation. */
  askAgent(op: string, params: Record<string, unknown>): Promise<any>;
  bench: Bench;
};

const run = (program: string, args: string[], timeout = 8000): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(program, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => (err && !stdout ? reject(new FeedError("the machine did not answer")) : resolve(stdout)));
  });

const int = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
};
const text = (v: unknown, max: number): string => String(v ?? "").slice(0, max);

export type LogQuery = { lines?: unknown; unit?: unknown; priority?: unknown; since?: unknown };

/** The system journal. Every argument is checked; nothing a caller sends reaches a shell. */
export async function readJournal(journalctl: string, q: LogQuery, maxLines = 500): Promise<Array<{ ts: number; unit: string; priority: number; message: string }>> {
  const args = ["-o", "json", "--no-pager", "-n", String(int(q.lines, 10, maxLines, 200))];
  if (typeof q.unit === "string" && /^[A-Za-z0-9@_.-]{1,120}\.(service|socket|timer|target)$/.test(q.unit)) args.push(`--unit=${q.unit}`);
  const priority = Number(q.priority);
  if (Number.isInteger(priority) && priority >= 0 && priority <= 7) args.push(`--priority=${priority}`);
  if (typeof q.since === "string" && /^-\d{1,4}[smhd]$/.test(q.since)) args.push(`--since=${q.since}`);
  const out = await run(journalctl, args);
  const entries = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    try {
      const j = JSON.parse(line);
      entries.push({
        ts: Math.round(Number(j.__REALTIME_TIMESTAMP ?? 0) / 1000),
        unit: String(j._SYSTEMD_UNIT ?? j.SYSLOG_IDENTIFIER ?? "kernel"),
        priority: Number(j.PRIORITY ?? 6),
        message: typeof j.MESSAGE === "string" ? j.MESSAGE.slice(0, 2000) : "[binary]",
      });
    } catch {
      /* skip a damaged line */
    }
  }
  return entries;
}

let servicesCache: { at: number; value: unknown } | null = null;

/** The machine's services and their state. Asked of systemd at most every five seconds. */
async function services(systemctl: string): Promise<unknown> {
  if (servicesCache && Date.now() - servicesCache.at < 5000) return servicesCache.value;
  const out = await run(systemctl, ["list-units", "--type=service", "--all", "--no-pager", "--output=json"]);
  const units = (JSON.parse(out) as Array<Record<string, unknown>>).slice(0, 400).map((u) => ({
    unit: text(u.unit, 140),
    active: text(u.active, 20),
    sub: text(u.sub, 20),
    description: text(u.description, 200),
  }));
  const value = { units, failed: units.filter((u) => u.active === "failed").map((u) => u.unit) };
  servicesCache = { at: Date.now(), value };
  return value;
}

/** One reading of a feed. `args` come from a thing: they are checked here, each feed taking only what it knows. */
export async function readFeed(deps: FeedDeps, feed: string, args: Record<string, unknown> = {}): Promise<unknown> {
  switch (feed as FeedName) {
    case "services":
      return services(deps.systemctl);
    case "logs":
      return readJournal(deps.journalctl, args, 200);
    case "goals": {
      const r = await deps.askAgent("goals", {});
      return (r?.goals ?? []).slice(0, 60).map((g: any) => ({
        id: g.id, title: g.title, status: g.status, standing: Boolean(g.standing), next_step: text(g.next_step, 300), spent_usd: g.spent_usd, budget_usd: g.budget_usd, updated: g.updated,
      }));
    }
    case "journal": {
      const r = await deps.askAgent("journal", { n: int(args.n, 1, 50, 10) });
      return (Array.isArray(r) ? r : []).map((j: any) => ({ ts: j.ts, text: text(j.summary || `${j.wake} ${j.did} ${j.outcome}`, 600), cost_usd: j.cost_usd ?? null }));
    }
    case "memory": {
      const query = typeof args.query === "string" ? args.query.slice(0, 200) : undefined;
      const r = await deps.askAgent("memories", query ? { query } : {});
      return (Array.isArray(r) ? r : []).slice(0, 60).map((m: any) => ({ id: m.id, kind: m.kind, subject: text(m.subject, 120), statement: text(m.statement, 1000), origin: m.origin, confirmed: m.confirmed, pinned: Boolean(m.pinned) }));
    }
    case "conversation": {
      const r = await deps.askAgent("conversation", { n: int(args.n, 1, 50, 12) });
      return (Array.isArray(r) ? r : []).map((m: any) => ({ ts: m.ts, who: m.who, text: text(m.text, 2000) }));
    }
    case "files":
      return deps.bench.list();
    case "file":
      return deps.bench.read(text(args.path, 400));
    default:
      throw new FeedError(`there is no feed "${text(feed, 40)}". The feeds are: meters, state, ${FEED_NAMES.join(", ")}.`);
  }
}
