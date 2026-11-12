// One session: one bounded stretch of work by the model.
//
// Everything the rules need to know about the session in progress is here,
// in one object that exists for exactly as long as the session does: who
// asked for it, what it is for, and what it has read. The loop creates it
// when a session starts and drops it when the session ends, so nothing of
// one session can be left over in the next.
import { GivenLinks, scrubLinks } from "./links.js";
import type { QueueItem } from "./store.js";

export type SessionStudy = { id: number; kind: "read" | "explain" };

export type SessionStart = {
  /** What started it: the operator's message, an alarm, a goal, a moment of Woody's own... */
  source: QueueItem["source"];
  /** The operator is writing to Woody (and Woody is not acting by itself). */
  operator: boolean;
  /** A moment of Woody's own: what it spends comes out of Woody's share. */
  own: boolean;
  /** The daily reflection: the only moment Woody may change its identity. */
  reflecting: boolean;
  /** The study this session works on, and at which stage. */
  study: SessionStudy | null;
  /** What it adds to the canvas was asked for by the operator, although Woody is working by itself (a study's explainer). */
  invited: boolean;
  /**
   * "observe" means look, research and write in the workspace only: it
   * applies whenever Woody acts on its own without a plan the operator accepted.
   */
  mode: "full" | "observe";
};

export class SessionState {
  readonly source: QueueItem["source"];
  readonly operator: boolean;
  readonly own: boolean;
  readonly reflecting: boolean;
  readonly study: SessionStudy | null;
  readonly invited: boolean;
  readonly mode: "full" | "observe";

  /** Stops the session: the operator's Stop, or a shutdown. */
  readonly abort = new AbortController();
  /**
   * Set once the session has received web content (notes from the reader).
   * What it may do from then on is decided by policy.ts.
   */
  taint: string | null = null;
  /** The addresses the session was given in the pages and search results it received (links.ts). */
  readonly links = new GivenLinks();
  /** What the session spent outside its own model calls (the maker, the web reader). */
  extra = 0;
  /** The pages fetched since the session last wrote a finding. */
  pages: string[] = [];
  /** The thing the session put on the canvas, if any. */
  made: string | null = null;
  /** Expressions Woody chose to show during the session. */
  expressed = 0;
  /** Goals whose review or checkpoint was written during the session. */
  readonly touchedGoals = new Set<number>();
  /** Event ids of the session; each memory stored during it cites them. */
  turnSources: number[] = [];
  /** Messages from the operator that arrived while the session was running. */
  arrivals: Array<{ queueId: number; event: number; text: string }> = [];

  constructor(start: SessionStart) {
    this.source = start.source;
    this.operator = start.operator;
    this.own = start.own;
    this.reflecting = start.reflecting;
    this.study = start.study;
    this.invited = start.invited;
    this.mode = start.mode;
  }

  get tainted(): boolean {
    return this.taint !== null;
  }

  /** What a session that read the web writes down for later, without the addresses it was not given. */
  scrub(text: string): string {
    return this.taint ? scrubLinks(text, this.links) : text;
  }
}
