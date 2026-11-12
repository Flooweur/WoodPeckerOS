// The gates between Woody's tools and the world.
//
// The tools and prompt builders outside core/ are never handed the executor,
// the canvas or the mind's store as they are. They get what this file and
// woody-store.ts make of them: the same things, behind the rules that depend
// on the session in progress. What a session may do is decided in one place,
// policy.ts; the gates ask it.
import type { Link } from "./canvas-link.js";
import type { ExecReply, ExecutorClient } from "./executor.js";
import { textLinks } from "./links.js";
import { CANVAS_KIND, execKind, refusal } from "./policy.js";

export { TAINTED } from "./policy.js";

/** What the gates ask about the session in progress. The loop answers (agent.ts). */
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
  /** The session has just received content from the web, and the addresses found in it. */
  readWeb(source: string, links: string[]): void;
};

/** The executor as Woody's tools may use it. */
export type Exec = {
  action(action: string, params: Record<string, unknown>, timeoutMs?: number): Promise<ExecReply>;
  wait(approvalId: string, timeoutMs?: number): Promise<ExecReply>;
};

const denied = (reason: string): ExecReply => ({ status: "denied", reason });

/**
 * The executor behind the session's rules. The executor itself decides what
 * needs the operator's approval; these two rules are the agent's own:
 *  * what a session that has read the web may ask for (policy.ts);
 *  * acting on its own, Woody may apply a configuration change only if that
 *    change goes to the operator for approval;
 *  * a workbench run that was given the network counts as reading the web:
 *    what it printed may come from anywhere, so from then on the session is
 *    one that has read the web, and has no network in the workbench.
 */
export function gatedExec(exec: Pick<ExecutorClient, "action" | "wait">, session: Session): Exec {
  return Object.freeze({
    async action(action: string, params: Record<string, unknown>, timeoutMs?: number): Promise<ExecReply> {
      const kind = execKind(action, params);
      if (refusal(kind, { tainted: session.tainted() })) {
        return denied(
          kind === "work-net"
            ? "this session has read web content, so the workbench has no network for the rest of it. Run it without the network, or do it in a later session"
            : "this session has read web content: it may only observe and take notes",
        );
      }
      if (session.mode() === "observe" && action === "config.apply") {
        const status = await exec.action("config.status", { candidate: params.candidate });
        const asks = status.status === "ok" && Boolean((status.result as { requires_approval?: boolean } | undefined)?.requires_approval);
        if (!asks) return denied("acting on your own, you may not apply this change: it would take effect without the operator. Propose a goal, or ask them");
      }
      const reply = await exec.action(action, params, timeoutMs);
      if (kind === "work-net" && reply.status === "ok") {
        const output = String((reply.result as { output?: unknown } | undefined)?.output ?? "");
        session.readWeb("a workbench run with the network", textLinks(output));
      }
      return reply;
    },
    wait: (approvalId: string, timeoutMs?: number) => exec.wait(approvalId, timeoutMs),
  });
}

/**
 * The canvas behind the session's rules:
 *  * only the requests listed in policy.ts can be made, and a session that
 *    has read the web can make only those its policy allows;
 *  * whether a change was asked for by the operator, and which study a new
 *    thing explains, are written here from the session's own state, whatever
 *    the caller passed;
 *  * a picture is kept only by the web tools, never handed in by a canvas tool.
 */
export function gatedLink(link: Link, session: Session): Link {
  return Object.freeze({
    connected: () => link.connected(),
    async request(op: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
      const kind = CANVAS_KIND[op];
      if (!kind) throw new Error(`"${op}" is not a request Woody's canvas tools can make.`);
      const refused = refusal(kind, { tainted: session.tainted() });
      if (refused) throw new Error(refused);
      if (kind !== "canvas") return link.request(op, op === "may_add" ? { ...params } : params, timeoutMs);
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

/** What Woody's tools may send to the screens: a notice, or the news that a request waits for approval. Nothing that imitates the agent's own state. */
export function gatedNotify(broadcast: (message: Record<string, unknown>) => void): (message: Record<string, unknown>) => void {
  return (message) => {
    if (message.type === "notify" || message.type === "approval_pending") broadcast(message);
  };
}
