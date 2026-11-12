// Small pieces the frame's records share: the marks, the bars, the words for
// Woody's states, one line of the conversation.
import type { MindStateName } from "./Lattice";
import type { Goal, Inner, Item, Mark } from "./types";
import { TOOL_PREFIX, clock } from "./types";

export const STATE_LABEL: Record<MindStateName, string> = {
  attending: "ANSWERING YOU",
  working: "WORKING",
  resting: "RESTING",
  sleeping: "ASLEEP",
  waiting: "WAITING ON YOU",
  paused: "PAUSED",
  out_of_allowance: "OUT OF ALLOWANCE",
  pacing: "PACING ITSELF",
  no_credential: "NO API KEY",
  api_error: "MODEL REFUSED",
};
export const INNER: Array<[keyof Omit<Inner, "at">, string]> = [
  ["energy", "energy"], ["ease", "ease"], ["curiosity", "curiosity"], ["attention", "attention to you"], ["unease", "unease"],
];
export const ALERT_STATES: MindStateName[] = ["waiting", "paused", "out_of_allowance", "no_credential", "api_error"];

/** Tools whose use means something was written down. */
export const SAVING_TOOLS = ["remember", "memory_update", "memory_merge", "goal_checkpoint", "goal_review", "goal_propose", "fs_write", "alarm_set"];

// One shape per kind of event.
export const MARK_PATH: Record<Mark, string> = {
  said: "M5 1 A4 4 0 1 0 5 9 A4 4 0 1 0 5 1 Z",
  tool: "M2 2 H8 V8 H2 Z",
  woke: "M5 1 L9 9 L1 9 Z",
  saved: "M5 0.5 L9.5 5 L5 9.5 L0.5 5 Z",
  problem: "M1.5 1.5 L8.5 8.5 M8.5 1.5 L1.5 8.5",
};

export function MarkIcon({ mark, tone = "dim", size = 12 }: { mark: Mark; tone?: "dim" | "amber" | "text" | "red"; size?: number }) {
  const color = tone === "amber" ? "var(--amber)" : tone === "text" ? "var(--text)" : tone === "red" ? "var(--red-soft)" : "var(--dim)";
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 10 10" role="img" aria-label={mark}>
      <path d={MARK_PATH[mark]} fill={mark === "problem" ? "none" : color} stroke={mark === "problem" ? "var(--red-soft)" : "none"} strokeWidth={1.5} />
    </svg>
  );
}

/** The state's own shape, so it reads without colour. */
export function StateMark({ state }: { state: MindStateName }) {
  return <span className={`state-mark ${state}`} role="img" aria-label={STATE_LABEL[state].toLowerCase()} />;
}

export function Bar({ fraction, tone = "amber", small = false }: { fraction: number; tone?: "amber" | "red"; small?: boolean }) {
  return (
    <span className={`bar ${small ? "small" : ""}`}>
      <span className={tone} style={{ width: `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%` }} />
    </span>
  );
}

export function goalMark(g: Goal): string {
  if (g.status === "active") return "filled";
  if (g.status === "review" || g.status === "waiting" || g.status === "proposed") return "half";
  return "hollow";
}
export const GOAL_WORD: Record<string, string> = {
  inbox: "NEW", review: "PLAN", ready: "READY", active: "ACTIVE", waiting: "ASKS", proposed: "IDEA", done: "DONE", dropped: "DROPPED",
};

/** A count as the frame writes it: "03". */
export const count = (n: number, width = 2) => String(n).padStart(width, "0");

export function Meter({ label, fraction, value, alert = false }: { label: string; fraction: number | undefined; value: string; alert?: boolean }) {
  return (
    <div className={`meter ${alert ? "alert" : ""}`}>
      <div className="column">
        <span style={{ height: `${Math.round(Math.min(1, Math.max(0, fraction ?? 0)) * 100)}%` }} />
      </div>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}

/** One line of the conversation: its time, its mark on the spine, and what was said or done. */
export function TalkRow({ item }: { item: Item }) {
  const time = <span className="time">{clock(item.ts)}</span>;
  switch (item.kind) {
    case "user":
      return (
        <div className="talk-row you">
          {time}
          <MarkIcon mark="said" tone="amber" />
          <div className="body">
            <span className="who">YOU </span>
            {item.text}
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className="talk-row">
          {time}
          <MarkIcon mark="said" tone="text" />
          <div className="body">
            <span className="who">WOODY </span>
            {item.text}
            {item.streaming && <span className="caret">▍</span>}
          </div>
        </div>
      );
    case "tool": {
      const name = item.name.startsWith(TOOL_PREFIX) ? item.name.slice(TOOL_PREFIX.length) : item.name;
      const args = JSON.stringify(item.input);
      return (
        <details className={`talk-row tool ${item.isError ? "failed" : ""}`}>
          <summary>
            {time}
            <MarkIcon mark={item.isError ? "problem" : "tool"} />
            <span className="body small">
              <span className="name">{name}</span> <span className="args">{args === "{}" ? "" : args}</span>
              <span className="state">{item.result === undefined ? "running" : item.isError ? "failed" : "done"}</span>
            </span>
          </summary>
          {item.result !== undefined && <pre>{item.result}</pre>}
        </details>
      );
    }
    case "meta": {
      const woke = item.text.startsWith("woke up");
      const cost = /^(nothing needed · )?\$[\d.]+ · /.test(item.text) || item.text.startsWith("stopped");
      return (
        <div className={`talk-row meta ${cost ? "cost" : ""}`}>
          {time}
          {cost ? <span className="mark" /> : <MarkIcon mark={woke ? "woke" : "saved"} tone={woke ? "amber" : "dim"} />}
          <div className="body small">{item.text}</div>
        </div>
      );
    }
    case "error":
      return (
        <div className="talk-row problem">
          {time}
          <MarkIcon mark="problem" />
          <div className="body">{item.text}</div>
        </div>
      );
  }
}

