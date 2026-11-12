// The gates between Woody's own code and the world.
//
// Since Phase 10 the agent has two parts. The files under core/ are locked:
// they change only with the operator's approval. Everything else is Woody's
// own program, which it may change by itself. Woody's code is never handed
// the executor, the canvas or the mind's store as they are. It gets what
// this file and woody-store.ts make of them: the same things, behind checks
// that depend on the session in progress and that Woody's code cannot switch
// off, because the session's state is kept on the locked side.
import type { Link } from "./canvas-link.js";
import type { ExecReply, ExecutorClient } from "./executor.js";

/** What the gates ask about the session in progress. The loop (server.ts) answers. */
export type Session = {
  /** The session has received content from the web. */
  tainted(): boolean;
  /** "observe": Woody is acting on its own without a plan the operator accepted. */
  mode(): "full" | "observe";
  /** What the session adds to the canvas was not asked for by the operator. */
  uninvited(): boolean;
  /** When the session is building the explainer of a study: that study, with the pages read for it. */
  explains(): { id: number; subject: string; sources: Array<{ url: string; title: string }> } | null;
  /** A thing the session put on the canvas. */
  made(thingId: string): void;
};

export const TAINTED =
  "Refused: this session has read web content, so for the rest of it you may only observe and take notes. Write down what you learned and what you think should be done. Acting on it happens in a later session, from those notes.";

/** Executor actions that only look. They are all a session may ask for once it has read the web. */
export const LOOK_ACTIONS: ReadonlySet<string> = new Set([
  "system.info", "process.list", "service.list", "service.status", "journal.tail", "journal.query", "osquery.query",
  "screen.capture", "web.fetch", "web.picture", "web.blocklist", "config.status",
]);

/** The executor as Woody's code may use it. */
export type Exec = {
  action(action: string, params: Record<string, unknown>, timeoutMs?: number): Promise<ExecReply>;
  wait(approvalId: string, timeoutMs?: number): Promise<ExecReply>;
};

const denied = (reason: string): ExecReply => ({ status: "denied", reason });

/**
 * The executor behind the session's rules. The executor itself decides what
 * needs the operator's approval; these two rules are the agent's own:
 *  * a session that has read the web may only look;
 *  * acting on its own, Woody may apply a configuration change only if that
 *    change goes to the operator for approval.
 */
export function gatedExec(exec: Pick<ExecutorClient, "action" | "wait">, session: Session): Exec {
  return Object.freeze({
    async action(action: string, params: Record<string, unknown>, timeoutMs?: number): Promise<ExecReply> {
      if (session.tainted() && !LOOK_ACTIONS.has(action)) return denied("this session has read web content: it may only observe and take notes");
      if (session.mode() === "observe" && action === "config.apply") {
        const status = await exec.action("config.status", { candidate: params.candidate });
        const asks = status.status === "ok" && Boolean((status.result as { requires_approval?: boolean } | undefined)?.requires_approval);
        if (!asks) return denied("acting on your own, you may not apply this change: it would take effect without the operator. Propose a goal, or ask them");
      }
      return exec.action(action, params, timeoutMs);
    },
    wait: (approvalId: string, timeoutMs?: number) => exec.wait(approvalId, timeoutMs),
  });
}

/** Canvas requests that only look. */
const CANVAS_LOOKS: ReadonlySet<string> = new Set(["look", "get", "pictures", "limits", "may_add", "kit_catalogue"]);
/** Canvas requests that change something, and so carry the loop's own marks. */
const CANVAS_CHANGES: ReadonlySet<string> = new Set(["make", "kit", "change", "restore", "place", "remove", "bring_back"]);

/**
 * The canvas behind the session's rules:
 *  * a session that has read the web can change nothing on it;
 *  * whether a change was asked for by the operator, and which study a new
 *    thing explains, are written here from the session's own state, whatever
 *    the caller passed;
 *  * a picture is kept only by the web tools, never handed in by Woody's code.
 */
export function gatedLink(link: Link, session: Session): Link {
  return Object.freeze({
    connected: () => link.connected(),
    async request(op: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
      if (!CANVAS_LOOKS.has(op) && !CANVAS_CHANGES.has(op)) throw new Error(`"${op}" is not a request Woody's canvas tools can make.`);
      if (session.tainted() && !CANVAS_LOOKS.has(op)) throw new Error(TAINTED);
      if (!CANVAS_CHANGES.has(op)) return link.request(op, op === "may_add" ? { ...params } : params, timeoutMs);
      const { study: _claimed, uninvited: _said, ...rest } = params;
      const marked: Record<string, unknown> = { ...rest, uninvited: session.uninvited() };
      if (op === "make" || op === "kit") {
        const study = session.explains();
        if (study) marked.study = study;
      }
      const result = await link.request(op, marked, timeoutMs);
      const id = (result as { thing?: { id?: unknown } } | null)?.thing?.id;
      if ((op === "make" || op === "kit") && typeof id === "string") session.made(id);
      return result;
    },
  });
}

/** What Woody's code may send to the screens: a notice, or the news that a request waits for approval. Nothing that imitates the agent's own state. */
export function gatedNotify(broadcast: (message: Record<string, unknown>) => void): (message: Record<string, unknown>) => void {
  return (message) => {
    if (message.type === "notify" || message.type === "approval_pending") broadcast(message);
  };
}
