// The agent's shared state and services, in one typed object.
//
// The loop is spread over several files by subject (the session runner, the
// queue, the pulse, the operator's access, the socket protocol). They all work
// on this one object, built in agent.ts. Whatever belongs to the session in
// progress is in `session`, and nowhere else.
import type { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { OwnMaterial } from "../mind/context.js";
import type { Inner } from "../mind/inner.js";
import type { OwnDecision, Rhythm } from "../mind/life.js";
import type { Budget } from "./budget.js";
import type { CanvasLink } from "./canvas-link.js";
import type { Config } from "./config.js";
import type { ExecutorClient } from "./executor.js";
import type { Files } from "./files.js";
import type { Aside } from "./model.js";
import type { SessionState } from "./session.js";
import type { Memory, Message, QueueItem, Store, Study } from "./store.js";
import type { RecallOptions, WoodyStore } from "./woody-store.js";

export type MindStateName = "attending" | "working" | "resting" | "sleeping" | "waiting" | "paused" | "out_of_allowance" | "pacing" | "no_credential" | "api_error";

/** What is kept across restarts besides the mind's store: the chosen model and the model's working context. */
export type Persisted = {
  model: string;
  sessionId?: string;
  sessionTurns?: number;
  lastTurnAt?: number;
  /** What the SDK has reported so far as the cost of the working context `sessionId`. It reports a running total, not the cost of one session. */
  sessionCostUsd?: number;
};

/** The executor as the loop uses it. */
export type ExecPort = Pick<ExecutorClient, "action" | "wait" | "status" | "event">;

/** A connected screen, or root's terminal client. */
export type Client = { readyState: number; send(data: string): void };

/** One of Woody's tools, as the tool server holds it. */
export type ToolEntry = { name: string; handler: (args: never, extra: unknown) => Promise<unknown> };

export type Core = {
  cfg: Config;
  store: Store;
  budget: Budget;
  exec: ExecPort;
  canvasLink: CanvasLink;
  files: Files;
  state: Persisted;
  saveState(): void;
  /** The conversation, and the three places where what Woody does apart from it is recorded. */
  threads: { main: number; reflection: number; own: number; study: number };

  /** The session in progress, or null when Woody is idle. */
  session: SessionState | null;
  /** Set by the human in the executor. While true, Woody does nothing on its own. */
  paused: boolean;
  shuttingDown: boolean;
  /** When the last session ended, to tell a wake-up after a long rest from an ordinary one. */
  lastSessionEnd: number;
  /**
   * When the model API refuses requests (a spending limit on the key, an
   * outage, a revoked key), Woody stops starting work on its own and tries
   * again later, waiting longer each time.
   */
  apiBlock: { until: number; failures: number; reason: string };
  mind: { state: MindStateName; focus: string; since: number };
  clients: Set<Client>;

  // ---- the screens ----
  send(client: Client, message: Record<string, unknown>): void;
  broadcast(message: Record<string, unknown>): void;
  /** A small expression for the lattice, tied to something real that just happened. */
  moment(name: string): void;
  /** A line in the conversation that is neither side speaking: a wake-up, a note. */
  note(text: string): void;
  stateMessage(): Record<string, unknown>;
  historyMessage(): Record<string, unknown>;
  historyItem(m: Message): Record<string, unknown> | null;
  setMind(next: MindStateName, focus?: string): void;

  // ---- the model and its cost ----
  hasCredential(): boolean;
  noteApiFailure(text: string): void;
  /** What the maker and the web reader cost: part of the session that asked for them. */
  recordBackgroundCost(model: string, cost: number): void;
  /** Small calls that belong to no session: journal summaries, the triage of log errors. */
  recordAsideCost(model: string, cost: number): void;
  aside: Aside;
  failedUnits(): string[];

  // ---- recall by meaning (embed.ts) ----
  /** Memories for a text, found by words and, when the machine has an embedding model, by meaning. Never fails: it falls back to words. */
  recall(query: string, opts?: RecallOptions): Promise<Memory[]>;
  /** Gives a vector to memories that have none yet. Returns how many. */
  embedPending(max?: number): Promise<number>;

  // ---- Woody's tools ----
  /** The mind's store as Woody's tools may use it (woody-store.ts). */
  woody: WoodyStore;
  toolServer: ReturnType<typeof createSdkMcpServer>;
  tools: ToolEntry[];

  // ---- its life (life-now.ts) ----
  currentInner(): Inner;
  forgetInner(): void;
  rhythm(): Rhythm;
  asleep(): boolean;
  ownEnabled(): boolean;
  ownDecision(): OwnDecision;
  ownNext(): string;
  lifeNow(): Record<string, unknown>;
  studyCap(study: Study, kind: "read" | "explain"): number;
  ownMaterial(kind: "free" | "tidy"): Promise<OwnMaterial>;

  // ---- the loop (queue-loop.ts, run-session.ts) ----
  /** Why Woody may not act on its own right now, or null. `forOwn`: for a moment of its own, which is paid from its own share. */
  autonomyBlock(forOwn?: boolean): { state: MindStateName; why: string } | null;
  restingState(): void;
  pump(): Promise<void>;
  operatorMessage(text: string): void;
  operatorGoalMessage(goalId: number, text: string): void;
  runSession(item: QueueItem): Promise<void>;

  // ---- the clock (daily.ts) ----
  pulse(): Promise<void>;
  operatorPresent(): void;
  briefTime(): string;

  // ---- the operator (operator-api.ts, protocol.ts) ----
  mindRequest(msg: Record<string, unknown>): unknown;
  handle(client: Client, raw: string): void;
};
