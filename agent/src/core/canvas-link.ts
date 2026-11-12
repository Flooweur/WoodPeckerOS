// The agent's connection to the canvas, which the HUD gateway keeps. It is
// part of the locked side: every request Woody's canvas tools make goes
// through here.
/** The gateway's end of the connection: a WebSocket, or a stand-in for one in the tests. */
export type LinkSocket = { readyState: number; send(data: string): void; on(event: "close", listener: () => void): unknown };

export type Link = {
  connected(): boolean;
  request(op: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
};

export class CanvasLink implements Link {
  private ws: LinkSocket | null = null;
  private seq = 0;
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  /** The gateway opened its canvas connection. A newer one replaces an older one. */
  attach(ws: LinkSocket): void {
    this.ws = ws;
    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      for (const [rid, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("The HUD went away before it answered."));
        this.pending.delete(rid);
      }
    });
  }

  connected(): boolean {
    return this.ws !== null && this.ws.readyState === 1;
  }

  request(op: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.connected()) return reject(new Error("The HUD is not connected, so the canvas cannot be reached right now."));
      const rid = `c${++this.seq}`;
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new Error("The HUD did not answer in time."));
      }, timeoutMs);
      this.pending.set(rid, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ type: "canvas_request", rid, op, ...params }));
    });
  }

  /** The gateway's answer to one request. */
  reply(msg: Record<string, unknown>): void {
    const p = this.pending.get(String(msg.rid));
    if (!p) return;
    this.pending.delete(String(msg.rid));
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(String(msg.error ?? "refused")));
  }
}
