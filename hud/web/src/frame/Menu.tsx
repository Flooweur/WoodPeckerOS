// The lattice's menu: Woody's state in a line, Pause and Stop, undo, and the
// records. It is part of the frame: Woody cannot draw here.
import type { CanvasState } from "../canvas/types";
import type { Panel } from "./Panels";
import { count } from "./parts";
import type { AgentState, Send } from "./types";
import { money, until } from "./types";

export function Menu(p: {
  headline: string;
  sub: string;
  trouble: string;
  alertState: boolean;
  state: AgentState | null;
  now: number;
  paused: boolean;
  executorUp: boolean;
  busy: boolean;
  canvas: CanvasState;
  /** How many things wait for the operator. */
  needs: number;
  openGoals: number;
  /** How many things are on the canvas. */
  onCanvas: number;
  /** How many lattice designs Woody drew itself. */
  designs: number;
  /** Changes Woody made to its identity that the operator has not looked at. */
  changedSelf: number;
  identityVersion: number;
  /** The operator's terminal is offered on this screen. */
  terminal: boolean;
  tx: Send;
  openRecord: (panel: Panel) => void;
  onClose: () => void;
}) {
  const { headline, sub, trouble, alertState, state, now, paused, executorUp, busy, canvas, needs, openGoals, onCanvas, designs, changedSelf, identityVersion, terminal, tx, openRecord, onClose } = p;
  const mind = state?.mind_state;
  const budget = state?.budget;
  return (
  <>
    <div className="menu-backdrop" onClick={() => onClose()} />
    <div className="menu" role="menu">
      <div className={`menu-state ${alertState ? "alert" : ""}`}>
        <div className="headline">{headline}</div>
        <div className="sub">{trouble || sub || (mind?.next_alarm ? `next alarm ${until(mind.next_alarm.due, now)}` : "nothing scheduled")}</div>
        {budget && (
          <div className="sub dim">
            {money(budget.autonomous_usd ?? 0)} free today · {money(budget.spent_usd)} of ${budget.cap_usd} this month
          </div>
        )}
      </div>
      <div className="switches">
        <button className={paused ? "on-alert" : ""} disabled={!executorUp} onClick={() => tx({ type: "pause", on: !paused })}>
          {paused ? "RESUME" : "PAUSE"}
        </button>
        <button className="stop" disabled={!busy} onClick={() => tx({ type: "interrupt" })}>
          STOP
        </button>
      </div>
      <button className="undo" disabled={!canvas.undo} title="Take back the last change to the canvas" onClick={() => tx({ type: "canvas_op", op: "undo" })}>
        {canvas.undo ? `UNDO · ${canvas.undo.by === "you" ? "you" : "Woody"} ${canvas.undo.text}` : "UNDO · nothing to undo"}
      </button>
      <nav className="menu-list" aria-label="Records">
        <button className={needs ? "alert" : ""} onClick={() => openRecord({ kind: "needs" })}>
          <span className="code">F1</span> NEEDS YOU <span className="n">{count(needs)}</span>
        </button>
        <button onClick={() => openRecord({ kind: "new-goal" })}>
          <span className="code">F2</span> NEW GOAL
        </button>
        <button onClick={() => openRecord({ kind: "goals" })}>
          <span className="code">F3</span> GOALS <span className="n">{count(openGoals)}</span>
        </button>
        <button onClick={() => openRecord({ kind: "talk" })}>
          <span className="code">F4</span> CONVERSATION
        </button>
        <button onClick={() => openRecord({ kind: "things" })}>
          <span className="code" /> THINGS <span className="n">{count(onCanvas)}</span>
        </button>
        <button onClick={() => openRecord({ kind: "changes" })}>
          <span className="code" /> CHANGES
        </button>
        <button onClick={() => openRecord({ kind: "life" })}>
          <span className="code" /> ITS OWN LIFE <span className="n">{state?.life?.asleep ? "zz" : ""}</span>
        </button>
        <button onClick={() => openRecord({ kind: "studies" })}>
          <span className="code" /> STUDIES <span className="n">{state?.mind?.studies_open ? count(state.mind.studies_open) : ""}</span>
        </button>
        <button onClick={() => openRecord({ kind: "files" })}>
          <span className="code" /> FILES
        </button>
        <button onClick={() => openRecord({ kind: "methods" })}>
          <span className="code" /> ITS METHODS
        </button>
        <button onClick={() => openRecord({ kind: "face" })}>
          <span className="code" /> ITS FACE <span className="n">{designs ? count(designs) : ""}</span>
        </button>
        <button onClick={() => openRecord({ kind: "memory" })}>
          <span className="code">F5</span> MEMORY <span className="n">{count(state?.mind?.memories ?? 0, 3)}</span>
        </button>
        <button onClick={() => openRecord({ kind: "journal" })}>
          <span className="code">F6</span> JOURNAL <span className="n">{count(state?.mind?.journal ?? 0, 3)}</span>
        </button>
        <button onClick={() => openRecord({ kind: "identity" })}>
          <span className="code">F7</span> IDENTITY <span className="n">{changedSelf > 0 ? "new · " : ""}v{count(identityVersion)}</span>
        </button>
        <button onClick={() => openRecord({ kind: "machine" })}>
          <span className="code">F9</span> MACHINE
        </button>
        <button onClick={() => openRecord({ kind: "activity" })}>
          <span className="code">F10</span> ACTIVITY
        </button>
        <button onClick={() => openRecord({ kind: "logs" })}>
          <span className="code" /> SYSTEM LOG
        </button>
        <button onClick={() => openRecord({ kind: "web" })}>
          <span className="code" /> BLOCKED SITES
        </button>
        {terminal && (
          <button onClick={() => openRecord({ kind: "terminal" })}>
            <span className="code" /> TERMINAL
          </button>
        )}
        <button onClick={() => openRecord({ kind: "settings" })}>
          <span className="code">F8</span> SETTINGS
        </button>
      </nav>
      <div className="menu-foot">ESC lets go: the line, the record, this menu, then Woody's work</div>
    </div>
  </>
  );
}
