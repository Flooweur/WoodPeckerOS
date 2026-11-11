// Client for woody-execd's action socket: one JSON object per line.
// The agent can only reach the action socket. Approvals travel on a different
// socket this process cannot open.
import net from "node:net";

export type ExecReply =
  | { status: "ok"; result?: unknown; approval_id?: string }
  | { status: "error"; error: string; approval_id?: string }
  | { status: "denied"; reason: string; approval_id?: string }
  | { status: "pending"; approval_id: string };

export class ExecutorClient {
  constructor(private readonly socketPath: string) {}

  private call(request: Record<string, unknown>, timeoutMs: number): Promise<ExecReply> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let buffer = "";
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        fn();
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error("executor did not answer in time"))),
        timeoutMs,
      );
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        finish(() => {
          try {
            resolve(JSON.parse(line) as ExecReply);
          } catch {
            reject(new Error("executor sent an unreadable reply"));
          }
        });
      });
      socket.on("error", (err) => finish(() => reject(new Error(`executor unreachable: ${err.message}`))));
      socket.on("close", () => finish(() => reject(new Error("executor closed the connection"))));
    });
  }

  action(action: string, params: Record<string, unknown>): Promise<ExecReply> {
    return this.call({ op: "action", action, params }, 60_000);
  }

  /** Long-poll for an approval decision. Returns "pending" again if nothing happened. */
  wait(approvalId: string, timeoutMs = 60_000): Promise<ExecReply> {
    return this.call({ op: "wait", approval_id: approvalId, timeout_ms: timeoutMs }, timeoutMs + 10_000);
  }

  /** Second audit stream: what the agent itself observed. Best effort. */
  async event(data: Record<string, unknown>): Promise<void> {
    try {
      await this.call({ op: "event", data }, 5_000);
    } catch {
      // The executor audits every action on its own; losing an agent-side note is not fatal.
    }
  }
}
