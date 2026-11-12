// What the agent and the gateway send to the HUD.
import type { MindStateName } from "./Lattice";

export type Model = { id: string; label: string; note: string };

export type Budget = {
  month: string;
  spent_usd: number;
  cap_usd: number;
  remaining_usd: number;
  exhausted: boolean;
  daily_usd?: number;
  autonomous_usd?: number;
};

export type MindState = {
  state: MindStateName;
  focus: string;
  since: number;
  mode: "full" | "observe" | null;
  tainted: boolean;
  failed_units: string[];
  paused: boolean;
  queue: { operator: number; autonomous: number };
  next_alarm: { id: number; due: number; reason: string } | null;
  waiting_on_operator: number;
};

export type AgentState = {
  model: string;
  models: Model[];
  busy: boolean;
  budget: Budget;
  has_credential: boolean;
  mind_state?: MindState;
  mind?: Record<string, number>;
};

export type ConfigChange = {
  summary?: string;
  changed?: Array<{ path: string; kind: string }>;
  locked_paths?: string[];
  privilege_changes?: string[];
  diff?: string;
  diff_truncated?: boolean;
};

export type Approval = {
  approval_id: string;
  action: string;
  params: unknown;
  action_hash: string;
  created_ms: number;
  expires_ms: number;
  detail?: ConfigChange | null;
};

/** One kind of event, one shape: used in the conversation, the activity stream and the inbox. */
export type Mark = "said" | "tool" | "woke" | "saved" | "problem";

export type Item =
  | { kind: "user"; key: number; ts: number; text: string }
  | { kind: "assistant"; key: number; ts: number; text: string; streaming: boolean }
  | { kind: "tool"; key: number; ts: number; id: string; name: string; input: unknown; result?: string; isError?: boolean }
  | { kind: "meta"; key: number; ts: number; text: string }
  | { kind: "error"; key: number; ts: number; text: string };

export type Review = {
  understanding: string;
  judgement: string;
  recommendation: "proceed" | "reconsider";
  plan: string[];
  estimate_usd: number;
  estimate_minutes: number;
  changes_system: boolean;
  questions: string[];
};

export type Standing = { enabled: boolean; cadence_minutes: number; weekly_usd: number; week_spent_usd: number; week_start: number };

export type Goal = {
  id: number;
  title: string;
  description: string;
  reasoning: string;
  owner: "operator" | "woody";
  status: string;
  review: Review | null;
  accepted: boolean;
  auto_started: boolean;
  budget_usd: number;
  spent_usd: number;
  dossier: string;
  next_step: string;
  waiting_reason: string;
  outcome: string;
  last_worked: number;
  standing: Standing | null;
};

export type InboxItem = { kind: "plan" | "blocked" | "proposal"; goal: Goal };
export type IdentityProposal = { id: number; ts: number; text: string; reason: string };
export type Identity = {
  current: { version: number; text: string };
  pending: IdentityProposal[];
  history?: Array<{ version: number; ts: number; text: string; note: string }>;
};
export type JournalEntry = { id: number; ts: number; wake: string; did: string; outcome: string; next: string; summary: string };
export type Memory = {
  id: number;
  kind: string;
  statement: string;
  subject: string;
  origin: "user" | "observed" | "inferred" | "web";
  pinned: boolean;
  confirmed: number;
  supersedes: number | null;
  superseded_by: number | null;
  actor: string;
};
export type ActivityRow = { ts: number; mark: Mark; text: string };
export type Meters = {
  cpu_pct?: number;
  mem_used_kb?: number;
  mem_total_kb?: number;
  disk_free_pct?: number;
  net_kbps?: number;
  uptime_s?: number;
  generation?: number;
};

export type LogEntry = { ts: number; unit: string; priority: number; message: string };
/** Answers from the gateway itself (not the agent): the journal and the web allow-list. */
export type GatewayResult =
  | { seq: number; type: "logs"; ok: boolean; entries: LogEntry[]; error?: string }
  | { seq: number; type: "web_list"; ok: boolean; domains: string[] | null; error?: string | null };

export type MindResult = { seq: number; op: string; ok: boolean; result?: any; error?: string };
export type Send = (message: Record<string, unknown>) => void;

export const TOOL_PREFIX = "mcp__woody__";
export const usd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;
export const money = (n: number) => `$${n.toFixed(2)}`;
export const clock = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
export const day = (ts: number) => new Date(ts).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short", hourCycle: "h23" });

/** "in 31 min", "in 2 h 10", "in 5 d". */
export function until(ts: number, now: number): string {
  const s = Math.max(0, Math.round((ts - now) / 1000));
  if (s < 90) return "now";
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  if (s < 86_400) return `in ${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
  return `in ${Math.round(s / 86_400)} d`;
}
