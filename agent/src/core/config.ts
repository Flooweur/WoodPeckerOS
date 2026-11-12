// The agent's settings: what comes from the system's configuration (through
// the environment, see nix/modules/agent.nix), and the fixed limits of the loop.
import path from "node:path";
import { DEFAULT_MODEL } from "./models.js";

export type Config = {
  /** Where the agent keeps its state: the mind's store, the spend ledger, the workspace. */
  stateDir: string;
  workspace: string;
  execSocket: string;
  /** The workbench's folder, where Woody's programs run and files are exchanged with the operator. Absent on a machine without a workbench. */
  benchDir?: string;
  /** The monthly spending cap: it covers everything, the operator's conversations included. */
  monthlyCapUsd: number;
  /** The most one session may cost. */
  perTurnCapUsd: number;
  /** The part of the monthly cap that is Woody's own, for its interests and its own projects. */
  ownShare: number;
  /** The most one moment of Woody's own may cost. */
  ownSessionCapUsd: number;
  /** How often the pulse runs. It is plain code; no model is called unless there is something to handle. */
  pulseMs: number;
  /** The system (failed services, disks, log errors) is checked every this many pulses. */
  systemEvery: number;
  /** The operator counts as "back" after this long without a sign of them at the HUD. */
  awayMs: number;
  /** Moments of Woody's own run on this model, whatever the operator chose for the conversation. */
  ownModel: string;
  /** Where the local embedding service listens, for recall by meaning ("unix:/run/woody-embed/embed.sock", or an http:// address). Without it, memory is searched by words only. */
  embedUrl?: string;
  embedModel?: string;
  /** What some embedding models want in front of a question and of a stored text. */
  embedQueryPrefix?: string;
  embedPassagePrefix?: string;
  /** The default hours of Woody's day ("07:00"); the operator can change them from the HUD. */
  dayStart?: string;
  nightStart?: string;
};

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const stateDir = env.WOODY_STATE_DIR ?? path.resolve("state");
  return {
    stateDir,
    workspace: path.join(stateDir, "workspace"),
    execSocket: env.WOODY_EXEC_SOCKET ?? "/run/woody/exec.sock",
    benchDir: env.WOODY_BENCH_DIR || undefined,
    monthlyCapUsd: Number(env.WOODY_MONTHLY_CAP_USD ?? "100"),
    perTurnCapUsd: Number(env.WOODY_TURN_CAP_USD ?? "2"),
    ownShare: Number(env.WOODY_OWN_SHARE ?? "0.25"),
    ownSessionCapUsd: Number(env.WOODY_OWN_SESSION_USD ?? "0.4"),
    pulseMs: Number(env.WOODY_PULSE_MS ?? "60000"),
    systemEvery: Number(env.WOODY_SYSTEM_EVERY ?? "2"),
    awayMs: Number(env.WOODY_AWAY_MS ?? String(3 * 3_600_000)),
    ownModel: env.WOODY_OWN_MODEL ?? DEFAULT_MODEL,
    embedUrl: env.WOODY_EMBED_URL || undefined,
    embedModel: env.WOODY_EMBED_MODEL || undefined,
    embedQueryPrefix: env.WOODY_EMBED_QUERY_PREFIX,
    embedPassagePrefix: env.WOODY_EMBED_PASSAGE_PREFIX,
    dayStart: env.WOODY_DAY_START,
    nightStart: env.WOODY_NIGHT_START,
  };
}

/** The model's working context is rebuilt from the store after this long a pause... */
export const SESSION_IDLE_MS = 45 * 60_000;
/** ...or after this many turns, so it never grows without bound. */
export const SESSION_MAX_TURNS = 30;
export const HISTORY_MESSAGES = 300;
/** Below this much allowance, Woody rests instead of starting work on its own. */
export const MIN_AUTONOMOUS_USD = 0.02;
/** A flood of events cannot start more than this many autonomous sessions per hour. */
export const MAX_AUTONOMOUS_PER_HOUR = 12;
export const MAX_TRIAGE_PER_DAY = 40;
export const DEFAULT_BRIEF_TIME = "08:00";
/** At night Woody stays awake while someone was at the screen this recently. */
export const PRESENT_MS = 30 * 60_000;
export const MAX_EXPRESSED_PER_SESSION = 6;
/** The SDK reports a refused request as text that starts like this. */
export const API_ERROR = /^API Error\b/;
