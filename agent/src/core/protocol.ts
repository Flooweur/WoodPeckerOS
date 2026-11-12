// The agent's socket: what the screens (through the HUD gateway) and root's
// terminal client may send, one JSON message at a time.
import type { WebSocket } from "ws";
import type { Core } from "./core.js";
import { CHAT_MODELS } from "./models.js";

export function createProtocol(core: Core) {
  const { store, state, saveState, exec, clients, canvasLink, send, broadcast } = core;
  const stateMessage = () => core.stateMessage();
  const historyMessage = () => core.historyMessage();
  const operatorMessage = (text: string) => core.operatorMessage(text);
  const operatorPresent = () => core.operatorPresent();
  const pump = () => core.pump();
  const pulse = () => core.pulse();
  const mindRequest = (msg: Record<string, unknown>) => core.mindRequest(msg);
  const restingState = () => core.restingState();

  // ---- WebSocket protocol --------------------------------------------------

  /** A box as the canvas reports it, or null if it is not one. */
  function boxOf(v: unknown): { x: number; y: number; w: number; h: number } | null {
    const b = (v ?? {}) as Record<string, unknown>;
    const n = (k: string) => (typeof b[k] === "number" && Number.isFinite(b[k]) ? Math.round(b[k] as number) : null);
    const [x, y, w, h] = [n("x"), n("y"), n("w"), n("h")];
    return x === null || y === null || w === null || h === null ? null : { x, y, w, h };
  }

  /** Shows "sleeping" or "resting" at once when the operator changes the day's hours while Woody is idle. */
  function restingStateIfIdle(): void {
    if (!core.session) restingState();
  }

  function handle(ws: WebSocket, raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      send(ws, { type: "error", error: "bad-json" });
      return;
    }
    switch (msg.type) {
      case "chat": {
        if (typeof msg.text !== "string" || !msg.text.trim()) {
          send(ws, { type: "error", error: "empty-message" });
        } else if (msg.text.length > 100_000) {
          send(ws, { type: "error", error: "message-too-long" });
        } else if (store.queueDepth().operator >= 20) {
          send(ws, { type: "error", error: "busy", detail: "Too many messages are waiting; let Woody catch up." });
        } else {
          operatorMessage(msg.text);
        }
        break;
      }
      case "set_model": {
        if (!CHAT_MODELS.some((m) => m.id === msg.model)) {
          send(ws, { type: "error", error: "unknown-model" });
        } else {
          // Takes effect from the next session.
          state.model = msg.model as string;
          saveState();
          void exec.event({ kind: "model_changed", model: state.model });
          broadcast(stateMessage());
        }
        break;
      }
      case "new_session": {
        // Clears the model's working context only. The conversation, the
        // journal and memory stay; the next session starts from a recap.
        if (core.session) {
          send(ws, { type: "error", error: "busy" });
        } else {
          state.sessionId = undefined;
          state.sessionTurns = 0;
          saveState();
          store.event("working_context_cleared", {}, { actor: "operator" });
          broadcast(stateMessage());
        }
        break;
      }
      case "interrupt":
        core.session?.abort.abort();
        break;
      case "get_state":
        send(ws, stateMessage());
        break;
      case "get_history":
        send(ws, historyMessage());
        break;
      case "presence":
        operatorPresent();
        break;
      case "canvas_link":
        // The gateway's own connection for the canvas. It is not a screen.
        clients.delete(ws);
        canvasLink.attach(ws);
        break;
      case "canvas_reply":
        canvasLink.reply(msg);
        break;
      case "canvas_event": {
        // What changed on the canvas, by whom. Recorded, never a reason to wake:
        // it feeds the inner state and, later, what Woody notices about the operator.
        const c = (msg.change ?? {}) as Record<string, unknown>;
        const by = c.by === "you" ? "you" : "woody";
        store.event(
          "canvas_change",
          {
            by, op: String(c.op ?? ""), id: String(c.id ?? "").slice(0, 20), title: String(c.title ?? "").slice(0, 80), why: String(c.why ?? "").slice(0, 400),
            refused: c.refused ? String(c.refused).slice(0, 200) : null, thing_by: c.thing_by === "you" ? "you" : "woody",
            undid_by: c.undid_by ? String(c.undid_by) : null, pinned: c.pinned === true,
            // Whether Woody did it without being asked, whether the thing was put there that way, and where things were moved.
            uninvited: c.uninvited === true, thing_uninvited: c.thing_uninvited === true, for: c.for === "woody" ? "woody" : "you",
            box: boxOf(c.box), from: boxOf(c.from), screen: boxOf({ x: 0, y: 0, ...(c.screen as object) }),
          },
          { actor: by === "you" ? "operator" : "woody" },
        );
        core.forgetInner();
        break;
      }
      case "thing_event": {
        // Something happened on a thing (a button pressed, a line typed). The
        // gateway already paces these; the same event twice in a row is one.
        const id = String(msg.id ?? "").slice(0, 20);
        const name = String(msg.name ?? "").slice(0, 40);
        if (!id || !name) break;
        store.event("thing_event", { id, name, data: msg.data ?? null });
        store.enqueue({
          source: "thing",
          kind: "event",
          payload: { id, title: String(msg.title ?? "").slice(0, 80), name, data: msg.data ?? null },
          priority: 2,
          dedupe: `thing:${id}:${name}:${JSON.stringify(msg.data ?? null).slice(0, 200)}`,
          dedupeWindowMs: 5000,
        });
        void pump();
        break;
      }
      case "pulse":
        // Lets the operator (or a test) trigger a pulse without waiting.
        void pulse();
        break;
      case "mind": {
        try {
          send(ws, { type: "mind_result", op: msg.op, ok: true, result: mindRequest(msg) });
          const op = String(msg.op);
          const life = op === "interest_suggest" || op === "interest_drop" || op === "own_time" || op === "rhythm" || op === "study_add" || op === "study_drop" || op === "study_size";
          if (op === "method_restore" || op === "method_remove") {
            void exec.event({ kind: "mind_edit", op, id: msg.section ?? null });
            broadcast({ type: "goals_changed" });
          }
          if (op === "face_restore") {
            void exec.event({ kind: "mind_edit", op, id: msg.name ?? null });
            broadcast(stateMessage());
          }
          if (["pin", "unpin", "forget", "correct", "add", "alarm_cancel"].includes(op) || op.startsWith("goal_") || op.startsWith("identity_") || op === "standing" || op === "small_goal_limit" || life) {
            void exec.event({ kind: "mind_edit", op, id: msg.id ?? null });
            if (op.startsWith("goal_") || op.startsWith("identity_") || op === "standing") broadcast({ type: "goals_changed" });
            // The notice by the lattice follows what the operator has seen or restored.
            if (op.startsWith("identity_")) broadcast(stateMessage());
            if (life) {
              // The day's hours or Woody's own time changed: the screens show it at once.
              restingStateIfIdle();
              broadcast(stateMessage());
              void pump();
            }
          }
        } catch (err) {
          send(ws, { type: "mind_result", op: msg.op, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        break;
      }
      default:
        send(ws, { type: "error", error: "unknown-message-type" });
    }
  }

  return { handle };
}
