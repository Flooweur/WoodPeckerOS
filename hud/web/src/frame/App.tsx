// The frame: the part of the screen Woody cannot change.
//
// A black canvas (Woody's: its things are shown by ../canvas/Canvas) and,
// fixed in the top right corner, the lattice. Clicking the lattice opens its menu: Pause, Stop and the
// records. Beside the lattice, the voice line shows what Woody is doing and
// what it last said. Typing anywhere opens a line to write to Woody. A record
// opens below the lattice; an approval prompt is drawn above everything.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "../canvas/Canvas";
import type { CanvasResult, CanvasState } from "../canvas/types";
import { ApprovalModal } from "./Approval";
import { ChangesRecord, ThingsRecord } from "./CanvasRecords";
import { Lattice, type MindStateName, type Overlay, type Play } from "./Lattice";
import { LifeRecord } from "./Life";
import { FaceRecord } from "./Face";
import { StudiesRecord } from "./Studies";
import { MethodsRecord } from "./Methods";
import { ownDesigns, type Design } from "./faceData";
import { PanelView, type Panel } from "./Panels";
import type {
  ActivityRow, AgentState, Approval, GatewayResult, Goal, Identity, Inner, InboxItem, Item, Mark, Meters, MindResult,
} from "./types";
import { TOOL_PREFIX, clock, money, until, usd } from "./types";

/** The lines of the conversation that are speech: yours, Woody's, and a failure to answer. */
type Said = Extract<Item, { kind: "user" | "assistant" | "error" }>;
type Notice = { key: number; title: string; body: string; level: "info" | "warn" | "alert"; copy?: string; copied?: boolean };
type Link = "connecting" | "open" | "closed" | "no-token";
/** Which door the page came through: the VM's own screen, or the operator's browser on the host. */
type Door = { kiosk: boolean; terminal: boolean };

function takeToken(): string | null {
  const match = /[#&]t=([0-9a-f]{64})/.exec(location.hash);
  if (match) {
    sessionStorage.setItem("woody-token", match[1]!);
    history.replaceState(null, "", location.pathname);
  }
  return sessionStorage.getItem("woody-token");
}

const ERROR_TEXT: Record<string, string> = {
  "no-credential": "No Claude API key is configured for the agent.",
  "budget-exhausted": "The monthly spending cap has been reached.",
  busy: "Too many messages are waiting; let Woody catch up.",
  "agent-unavailable": "The agent service is not reachable.",
  "turn-failed": "The reply failed.",
  "api-error": "The model API refused the request",
  "pause-failed": "Pause could not be changed",
};

const STATE_LABEL: Record<MindStateName, string> = {
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
const INNER: Array<[keyof Omit<Inner, "at">, string]> = [
  ["energy", "energy"], ["ease", "ease"], ["curiosity", "curiosity"], ["attention", "attention to you"], ["unease", "unease"],
];
const ALERT_STATES: MindStateName[] = ["waiting", "paused", "out_of_allowance", "no_credential", "api_error"];

/** Tools whose use means something was written down. */
const SAVING_TOOLS = ["remember", "memory_update", "memory_merge", "goal_checkpoint", "goal_review", "goal_propose", "fs_write", "alarm_set"];

// One shape per kind of event.
const MARK_PATH: Record<Mark, string> = {
  said: "M5 1 A4 4 0 1 0 5 9 A4 4 0 1 0 5 1 Z",
  tool: "M2 2 H8 V8 H2 Z",
  woke: "M5 1 L9 9 L1 9 Z",
  saved: "M5 0.5 L9.5 5 L5 9.5 L0.5 5 Z",
  problem: "M1.5 1.5 L8.5 8.5 M8.5 1.5 L1.5 8.5",
};

function MarkIcon({ mark, tone = "dim", size = 12 }: { mark: Mark; tone?: "dim" | "amber" | "text" | "red"; size?: number }) {
  const color = tone === "amber" ? "var(--amber)" : tone === "text" ? "var(--text)" : tone === "red" ? "var(--red-soft)" : "var(--dim)";
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 10 10" role="img" aria-label={mark}>
      <path d={MARK_PATH[mark]} fill={mark === "problem" ? "none" : color} stroke={mark === "problem" ? "var(--red-soft)" : "none"} strokeWidth={1.5} />
    </svg>
  );
}

/** The state's own shape, so it reads without colour. */
function StateMark({ state }: { state: MindStateName }) {
  return <span className={`state-mark ${state}`} role="img" aria-label={STATE_LABEL[state].toLowerCase()} />;
}

function Bar({ fraction, tone = "amber", small = false }: { fraction: number; tone?: "amber" | "red"; small?: boolean }) {
  return (
    <span className={`bar ${small ? "small" : ""}`}>
      <span className={tone} style={{ width: `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%` }} />
    </span>
  );
}

function goalMark(g: Goal): string {
  if (g.status === "active") return "filled";
  if (g.status === "review" || g.status === "waiting" || g.status === "proposed") return "half";
  return "hollow";
}
const GOAL_WORD: Record<string, string> = {
  inbox: "NEW", review: "PLAN", ready: "READY", active: "ACTIVE", waiting: "ASKS", proposed: "IDEA", done: "DONE", dropped: "DROPPED",
};

export function App() {
  const [link, setLink] = useState<Link>("connecting");
  const [agentUp, setAgentUp] = useState(false);
  const [executorUp, setExecutorUp] = useState(true);
  const [state, setState] = useState<AgentState | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [notices, setNotices] = useState<Notice[]>([]);
  const [paused, setPaused] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [mindResult, setMindResult] = useState<MindResult | null>(null);
  const [gatewayResult, setGatewayResult] = useState<GatewayResult | null>(null);
  const [door, setDoor] = useState<Door>({ kiosk: true, terminal: false });
  const [version, setVersion] = useState(0);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [smallLimit, setSmallLimit] = useState(1);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [meters, setMeters] = useState<Meters>({});
  const [play, setPlay] = useState<{ name: Play; seq: number } | null>(null);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [session, setSession] = useState<{ steps: number; cost: number | null }>({ steps: 0, cost: null });
  const [typing, setTyping] = useState(false);
  const [menu, setMenu] = useState(false);
  /** The lattice designs Woody drew itself, checked (faceData.ts). */
  const [designs, setDesigns] = useState<Record<string, Design>>({});
  const [canvas, setCanvas] = useState<CanvasState>({ things: [], undo: null });
  const [canvasResult, setCanvasResult] = useState<CanvasResult | null>(null);
  /** The thing Woody is making right now, shown in the voice line until it is on the canvas. */
  const [making, setMaking] = useState<{ call: string; what: string } | null>(null);
  /** Lines of the conversation older than this are no longer shown by the voice line. */
  const [voiceFloor, setVoiceFloor] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [expressions, setExpressionsState] = useState(() => {
    try {
      return localStorage.getItem("woody-expressions") !== "off";
    } catch {
      return true;
    }
  });

  const socket = useRef<WebSocket | null>(null);
  const nextKey = useRef(1);
  const playSeq = useRef(0);
  const mindSeq = useRef(0);
  /** The versions of Woody's face and identity this page has asked for. */
  const faceSeen = useRef(-1);
  const identitySeen = useRef(-1);
  const mainThread = useRef<number | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const refresh = useRef<number | undefined>(undefined);
  const typingTimer = useRef<number | undefined>(undefined);
  const lineRef = useRef<HTMLTextAreaElement | null>(null);

  const tx = useCallback((message: Record<string, unknown>) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message));
  }, []);

  const show = useCallback((name: Play) => setPlay({ name, seq: ++playSeq.current }), []);

  /** Ask again for what the side columns show, shortly after something changed. */
  const reload = useCallback(() => {
    window.clearTimeout(refresh.current);
    refresh.current = window.setTimeout(() => {
      for (const op of ["goals", "inbox", "identity", "activity"]) tx({ type: "mind", op, n: 12 });
      setVersion((v) => v + 1);
    }, 400);
  }, [tx]);

  const push = useCallback((item: Record<string, unknown>) => {
    setItems((prev) => [...prev, { ...item, key: nextKey.current++, ts: Date.now() } as Item]);
  }, []);

  const onMessage = useCallback(
    (msg: Record<string, any>) => {
      // ---- the mind panel reacts to everything, whatever thread it happens in ----
      switch (msg.type) {
        case "turn_start":
          setSession({ steps: 0, cost: null });
          setOverlay(msg.source === "reflect" ? "reflecting" : null);
          if (msg.source && msg.source !== "operator") show("woke");
          break;
        case "user_text":
          show("message");
          break;
        case "tool_use": {
          const name = String(msg.name ?? "").replace(TOOL_PREFIX, "");
          setSession((s) => ({ ...s, steps: s.steps + 1 }));
          if (name === "web_search" || name === "web_fetch") setOverlay("web");
          if (name === "thing_make" || name === "thing_change" || name === "kit_place") {
            const title = typeof msg.input?.title === "string" ? `"${msg.input.title}"` : msg.input?.id ? `thing ${msg.input.id}` : "a thing";
            setMaking({ call: String(msg.id), what: `${name === "thing_change" ? "CHANGING" : "MAKING"} ${title.toUpperCase()}` });
          }
          show(SAVING_TOOLS.includes(name) ? "saved" : "tool");
          break;
        }
        case "tool_result":
          setMaking((m) => (m && m.call === msg.id ? null : m));
          break;
        case "result":
          setSession((s) => ({ ...s, cost: typeof msg.cost_usd === "number" ? msg.cost_usd : s.cost }));
          setOverlay(null);
          setMaking(null);
          break;
        case "error":
          show("problem");
          break;
        case "note":
          if (/ is done$/.test(String(msg.text))) show("done");
          break;
        case "moment":
          show(msg.name as Play);
          return;
      }
      if (["result", "note", "goals_changed", "user_text", "tool_use", "turn_start"].includes(msg.type)) reload();

      // ---- activity in a goal's thread is shown in that goal, not in the main conversation ----
      if (typeof msg.thread === "number" && mainThread.current !== null && msg.thread !== mainThread.current && msg.type !== "history") return;

      switch (msg.type) {
        case "state":
          setState(msg as unknown as AgentState);
          setAgentUp(true);
          // Woody redrew its lattice, or its identity changed: ask for the new one.
          if (typeof msg.face === "number" && msg.face !== faceSeen.current) {
            faceSeen.current = msg.face;
            tx({ type: "mind", op: "face" });
          }
          if (typeof msg.identity?.version === "number" && msg.identity.version !== identitySeen.current) {
            identitySeen.current = msg.identity.version;
            tx({ type: "mind", op: "identity" });
          }
          break;
        case "hello":
          setDoor({ kiosk: Boolean(msg.kiosk), terminal: Boolean(msg.terminal) });
          break;
        case "logs":
        case "web_list":
          setGatewayResult({ ...(msg as GatewayResult), seq: ++mindSeq.current });
          break;
        case "agent_up":
          setAgentUp(true);
          reload();
          break;
        case "agent_down":
          setAgentUp(false);
          break;
        case "history":
          mainThread.current = typeof msg.thread === "number" ? msg.thread : null;
          setItems(
            (Array.isArray(msg.items) ? msg.items : []).map((it: Record<string, unknown>) => ({
              ts: Date.now(),
              ...it,
              key: nextKey.current++,
              ...(it.kind === "assistant" ? { streaming: false } : {}),
            })) as Item[],
          );
          setVoiceFloor(nextKey.current);
          break;
        case "mind_result": {
          setMindResult({ seq: ++mindSeq.current, op: String(msg.op), ok: Boolean(msg.ok), result: msg.result, error: msg.error });
          if (!msg.ok) break;
          if (msg.op === "goals") {
            setGoals(msg.result.goals);
            setSmallLimit(msg.result.small_goal_usd);
          } else if (msg.op === "inbox") setInbox(msg.result);
          else if (msg.op === "identity" || String(msg.op).startsWith("identity_")) setIdentity((prev) => ({ ...prev, ...msg.result }));
          else if (msg.op === "face" || msg.op === "face_restore") setDesigns(ownDesigns(msg.result));
          else if (msg.op === "activity") setActivity(msg.result);
          else if (msg.op === "small_goal_limit") setSmallLimit(msg.result.small_goal_usd);
          break;
        }
        case "user_text":
          push({ kind: "user", text: msg.text });
          break;
        case "note":
          push({ kind: "meta", text: msg.text });
          break;
        case "assistant_delta":
          setItems((prev) => {
            const last = prev[prev.length - 1];
            if (last?.kind === "assistant" && last.streaming) return [...prev.slice(0, -1), { ...last, text: last.text + msg.text }];
            return [...prev, { kind: "assistant", key: nextKey.current++, ts: Date.now(), text: msg.text, streaming: true }];
          });
          break;
        case "assistant_text":
          setItems((prev) => {
            const last = prev[prev.length - 1];
            if (last?.kind === "assistant" && last.streaming) return [...prev.slice(0, -1), { ...last, text: msg.text, streaming: false }];
            return [...prev, { kind: "assistant", key: nextKey.current++, ts: Date.now(), text: msg.text, streaming: false }];
          });
          break;
        case "tool_use":
          push({ kind: "tool", id: msg.id, name: msg.name, input: msg.input });
          break;
        case "tool_result":
          setItems((prev) => prev.map((it) => (it.kind === "tool" && it.id === msg.id ? { ...it, result: msg.preview, isError: msg.is_error } : it)));
          break;
        case "result":
          setItems((prev) => prev.map((it) => (it.kind === "assistant" && it.streaming ? { ...it, streaming: false } : it)));
          push({
            kind: "meta",
            text:
              msg.subtype === "success"
                ? `${msg.silent ? "nothing needed · " : ""}${usd(msg.cost_usd ?? 0)} · ${((msg.duration_ms ?? 0) / 1000).toFixed(1)} s`
                : `stopped: ${String(msg.subtype).replaceAll("_", " ")} · ${usd(msg.cost_usd ?? 0)}`,
          });
          break;
        case "error":
          push({
            kind: "error",
            text: (ERROR_TEXT[msg.error] ?? msg.error) + (msg.detail && (!ERROR_TEXT[msg.error] || msg.error === "api-error" || msg.error === "pause-failed") ? `: ${msg.detail}` : ""),
          });
          break;
        case "approvals":
          setApprovals(msg.items ?? []);
          setPaused(Boolean(msg.paused));
          setExecutorUp(Boolean(msg.executor_up));
          break;
        case "meters":
          setMeters(msg as Meters);
          break;
        case "canvas":
          setCanvas({ things: Array.isArray(msg.things) ? msg.things : [], undo: msg.undo ?? null, limits: msg.limits ?? undefined });
          break;
        case "canvas_result": {
          setCanvasResult({ seq: ++mindSeq.current, rid: msg.rid ?? null, op: String(msg.op), ok: Boolean(msg.ok), result: msg.result, error: msg.error });
          // A refusal of something the operator did on the canvas is said out loud.
          if (!msg.ok && !String(msg.rid ?? "").startsWith("b") && msg.rid !== "viewport") {
            const key = nextKey.current++;
            setNotices((prev) => [...prev.slice(-3), { key, title: "The canvas refused that", body: String(msg.error ?? ""), level: "warn" }]);
            window.setTimeout(() => setNotices((prev) => prev.filter((n) => n.key !== key)), 15000);
          }
          break;
        }
        case "notify": {
          const key = nextKey.current++;
          const level = msg.level === "alert" || msg.level === "warn" ? msg.level : "info";
          const copy = typeof msg.copy === "string" && msg.copy ? msg.copy : undefined;
          setNotices((prev) => [...prev.slice(-3), { key, title: String(msg.title ?? ""), body: String(msg.body ?? ""), level, copy }]);
          if (level !== "alert" && !copy) window.setTimeout(() => setNotices((prev) => prev.filter((n) => n.key !== key)), 15000);
          break;
        }
        case "decide_result":
          setDeciding(null);
          if (!msg.ok) push({ kind: "error", text: `Decision not applied: ${msg.error ?? "unknown error"}` });
          break;
      }
    },
    [push, reload, show],
  );

  // connection, with reconnect
  useEffect(() => {
    const secure = location.protocol === "https:";
    const token = takeToken();
    if (!token && !secure) {
      setLink("no-token");
      return;
    }
    let stopped = false;
    let timer: number | undefined;
    let refused = 0;
    const connect = () => {
      if (stopped) return;
      setLink("connecting");
      // The kiosk proves itself with its token; the host browser with the session cookie from signing in.
      const ws = new WebSocket(secure ? `wss://${location.host}/ws` : `ws://${location.host}/ws?t=${token}`);
      socket.current = ws;
      ws.onopen = () => {
        refused = 0;
        setLink("open");
        // The screen's size, so that new things are placed where they can be seen.
        ws.send(JSON.stringify({ type: "canvas_op", op: "viewport", w: window.innerWidth, h: window.innerHeight, rid: "viewport" }));
      };
      ws.onmessage = (ev) => {
        try {
          onMessage(JSON.parse(ev.data));
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onclose = () => {
        setLink("closed");
        setAgentUp(false);
        // On the host door, being refused twice in a row means the session is over: sign in again.
        if (secure && ws.readyState === WebSocket.CLOSED && ++refused >= 2) {
          location.replace("/login");
          return;
        }
        timer = window.setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      socket.current?.close();
    };
  }, [onMessage]);

  // a clock for countdowns
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, []);

  // Tell the agent when someone is at the HUD (at most once a minute), so it
  // can say what happened while they were away.
  useEffect(() => {
    let last = 0;
    const signal = () => {
      const t = Date.now();
      if (t - last < 60_000) return;
      last = t;
      tx({ type: "presence" });
    };
    window.addEventListener("pointerdown", signal);
    window.addEventListener("keydown", signal);
    return () => {
      window.removeEventListener("pointerdown", signal);
      window.removeEventListener("keydown", signal);
    };
  }, [tx]);

  const busy = state?.busy ?? false;

  // Keys. The F keys open the records. Escape lets go of one thing at a time:
  // the line being typed, the menu, the open record, and last, Woody's work.
  // Any other key typed outside a field goes to the typing line.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const open: Record<string, Panel> = {
        F1: { kind: "needs" }, F2: { kind: "new-goal" }, F3: { kind: "goals" }, F4: { kind: "talk" }, F5: { kind: "memory" },
        F6: { kind: "journal" }, F7: { kind: "identity" }, F8: { kind: "settings" }, F9: { kind: "machine" }, F10: { kind: "activity" },
      };
      if (open[e.key]) {
        e.preventDefault();
        setMenu(false);
        setPanel(open[e.key]!);
        return;
      }
      if (e.key === "Escape") {
        if (document.activeElement === lineRef.current) lineRef.current?.blur();
        if (draft) setDraft("");
        else if (menu) setMenu(false);
        else if (panel) setPanel(null);
        else if (busy && approvals.length === 0) tx({ type: "interrupt" });
        return;
      }
      // Hand the keystroke to the typing line by focusing it now: the
      // character (or the paste, or an accent being composed) lands there.
      const t = e.target as HTMLElement | null;
      const inField = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || Boolean(t?.isContentEditable);
      if (inField || approvals.length > 0 || e.altKey || e.metaKey) return;
      const paste = e.ctrlKey && e.key.toLowerCase() === "v";
      if (e.ctrlKey && !paste) return;
      const onButton = t instanceof HTMLButtonElement || t instanceof HTMLAnchorElement || t?.tagName === "SUMMARY";
      if (onButton && (e.key === " " || e.key === "Enter")) return;
      if (e.key.length === 1 || e.key === "Dead" || e.key === "Process" || paste) lineRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel, menu, draft, busy, approvals.length, tx]);

  // keep the conversation pinned to the bottom unless the reader scrolled up
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items, panel]);

  // What was said stays beside the lattice for a while (longer for a longer
  // reply), then lets go. It remains in the conversation record.
  useEffect(() => {
    const said = [...items].reverse().find((it) => it.kind === "assistant" || it.kind === "error" || it.kind === "user");
    if (!said || said.key < voiceFloor || busy) return;
    if (said.kind === "assistant" && said.streaming) return;
    const timer = window.setTimeout(() => setVoiceFloor(nextKey.current), Math.min(180_000, 20_000 + said.text.length * 60));
    return () => window.clearTimeout(timer);
  }, [items, voiceFloor, busy]);

  const setExpressions = (on: boolean) => {
    setExpressionsState(on);
    try {
      localStorage.setItem("woody-expressions", on ? "on" : "off");
    } catch {
      /* not stored: it lasts until the page reloads */
    }
  };

  const canSend = link === "open" && agentUp && draft.trim().length > 0;
  const submit = () => {
    if (!canSend) return;
    stick.current = true;
    tx({ type: "chat", text: draft.trim() });
    setDraft("");
    setTyping(false);
  };
  const decide = (approval: Approval, decision: "approve" | "deny") => {
    setDeciding(approval.approval_id);
    tx({ type: "decide", approval_id: approval.approval_id, action_hash: approval.action_hash, decision });
  };

  const mind = state?.mind_state;
  const mindName: MindStateName = paused ? "paused" : mind?.state ?? "resting";
  // Asleep is Woody's own state now (its night, with nobody at the screen), not a guess from the clock.
  const hold: "listening" | "asleep" | null = typing ? "listening" : mindName === "sleeping" ? "asleep" : null;

  const open = useMemo(() => goals.filter((g) => !g.standing && g.status !== "done" && g.status !== "dropped"), [goals]);
  const duties = useMemo(() => goals.filter((g) => g.standing), [goals]);
  const needs = approvals.length + inbox.length + (identity?.pending.length ?? 0);
  /** Changes Woody made to its identity that have not been looked at: the frame says so by the lattice until the record is opened. */
  const changedSelf = state?.identity?.unseen?.length ?? 0;

  if (link === "no-token") {
    return (
      <div className="blocked">
        <h1>WOODPECKER</h1>
        <p>This page was opened without its access token.</p>
        <p className="dim">Open the HUD from the kiosk session, which supplies the token.</p>
      </div>
    );
  }

  const budget = state?.budget;
  const pending = approvals[0];
  const memUsed = meters.mem_used_kb !== undefined && meters.mem_total_kb ? meters.mem_used_kb / meters.mem_total_kb : undefined;
  const diskUsed = meters.disk_free_pct !== undefined ? 1 - meters.disk_free_pct / 100 : undefined;
  const failed = mind?.failed_units ?? [];
  const alertState = ALERT_STATES.includes(mindName);
  // Woody's energy sets how fast the lattice moves: quicker when fresh, slower when tired.
  const latticePace = state?.inner ? Number((1.4 - 0.8 * state.inner.energy.value).toFixed(1)) : 1;
  const headline = `${STATE_LABEL[mindName]}${mind?.focus && (mindName === "working" || mindName === "attending") ? ` · ${mind.focus.toUpperCase()}` : ""}`;
  const sub =
    mindName === "paused"
      ? "You paused Woody. Only read-only actions run until you resume."
      : mindName === "working" || mindName === "attending"
        ? `since ${mind ? clock(mind.since) : ""}${mind?.tainted ? " · read web content: observing only" : ""}`
        : mind?.focus || "";
  const trouble =
    link !== "open" ? "connecting to the HUD gateway…"
    : !agentUp ? "the agent is not reachable"
    : !executorUp ? "the executor is not reachable"
    : state && !state.has_credential ? "No Claude API key is configured for the agent. See docs/AGENT.md."
    : "";

  // ---- the voice line: what was just said, for as long as it is fresh ----
  const voiced = items.filter((it): it is Said => it.key >= voiceFloor && (it.kind === "user" || it.kind === "assistant" || it.kind === "error"));
  const lastYou = [...voiced].reverse().find((it) => it.kind === "user");
  const lastSaid = voiced[voiced.length - 1];
  const reply = lastSaid && lastSaid.kind !== "user" ? lastSaid : null;
  const you = lastYou && (!reply || lastYou.key < reply.key || lastSaid === lastYou) ? lastYou : null;
  const showState = (mindName !== "resting" && mindName !== "sleeping") || Boolean(trouble);

  const openRecord = (p: Panel) => {
    setMenu(false);
    setPanel(p);
  };

  // ---- records whose data the frame holds ----
  const needsBody = (
    <div className="stack wide">
      {needs === 0 && <p className="dim">Nothing needs you.</p>}
      {approvals.map((a) => (
        <div key={a.approval_id} className="entry static">
          <MarkIcon mark="problem" />
          <span className="entry-text">
            <span className="one">approve or deny: {a.action}</span>
            <span className="two">shown as a prompt</span>
          </span>
        </div>
      ))}
      {(identity?.pending ?? []).map((p) => (
        <button key={`id${p.id}`} className="entry" onClick={() => openRecord({ kind: "identity" })}>
          <MarkIcon mark="saved" tone="red" />
          <span className="entry-text">
            <span className="one">Woody proposes a change to who it is</span>
            <span className="two">{p.reason}</span>
          </span>
        </button>
      ))}
      {inbox.map((item) => (
        <button key={item.goal.id} className="entry" onClick={() => openRecord({ kind: "goal", id: item.goal.id })}>
          <MarkIcon mark={item.kind === "plan" ? "saved" : "said"} tone="red" />
          <span className="entry-text">
            <span className="one">
              {String(item.goal.id).padStart(2, "0")} {item.goal.title}
            </span>
            <span className="two">
              {item.kind === "plan" && item.goal.review
                ? `plan to accept · ${money(item.goal.review.estimate_usd)} · ${item.goal.review.changes_system ? "changes the system" : "read-only"}`
                : item.kind === "blocked"
                  ? item.goal.waiting_reason
                  : `Woody proposes · ${item.goal.reasoning}`}
            </span>
          </span>
        </button>
      ))}
    </div>
  );

  const goalsBody = (
    <div className="stack wide">
      <div className="row-actions">
        <button className="primary" onClick={() => openRecord({ kind: "new-goal" })}>
          + new goal
        </button>
        <span className="dim small">Your order is the priority. A read-only plan under {money(smallLimit)} starts by itself.</span>
      </div>
      <h4>Goals</h4>
      {open.length === 0 && <p className="dim">No goals yet. Give Woody something to work towards.</p>}
      {open.map((g) => (
        <button key={g.id} className="entry goal" onClick={() => openRecord({ kind: "goal", id: g.id })}>
          <span className={`goal-mark ${goalMark(g)}`} role="img" aria-label={g.status} />
          <span className="num">{String(g.id).padStart(2, "0")}</span>
          <span className="entry-text">
            <span className="one">{g.title}</span>
            <Bar fraction={g.budget_usd > 0 ? g.spent_usd / g.budget_usd : 0} small />
          </span>
          <span className="side">
            <span className={goalMark(g) === "half" ? "word alert" : g.status === "active" ? "word amber" : "word"}>{GOAL_WORD[g.status] ?? g.status}</span>
            <span className="dim">
              {g.budget_usd > 0 ? `${money(g.spent_usd)}/${g.budget_usd.toFixed(2)}` : g.review ? `est. ${money(g.review.estimate_usd)}` : ""}
            </span>
          </span>
        </button>
      ))}
      <h4>Standing duties · next run · share of the week's budget used</h4>
      {duties.map((d) => {
        const s = d.standing!;
        const due = d.last_worked + s.cadence_minutes * 60_000;
        return (
          <button key={d.id} className={`entry duty ${s.enabled ? "" : "off"}`} onClick={() => openRecord({ kind: "goal", id: d.id })}>
            <span className="one">{d.title}</span>
            <span className="when">{!s.enabled ? "off" : due <= now ? "due" : until(due, now).replace("in ", "")}</span>
            <span className="when">{s.enabled && s.weekly_usd > 0 ? `${Math.round((s.week_spent_usd / s.weekly_usd) * 100)} %` : ""}</span>
          </button>
        );
      })}
    </div>
  );

  const activityBody = (
    <div className="stack wide">
      {activity.length === 0 && <p className="dim">Nothing yet.</p>}
      {activity.map((a, i) => (
        <div key={`${a.ts}-${i}`} className="act">
          <span className="dim">{new Date(a.ts).toLocaleTimeString(undefined, { hourCycle: "h23" })}</span>
          <MarkIcon mark={a.mark} tone={a.text.startsWith("you") ? "amber" : "dim"} size={10} />
          <span className="one">{a.text}</span>
        </div>
      ))}
    </div>
  );

  const machineBody = (
    <div className="stack wide">
      <h4>Woody</h4>
      <div className="readouts">
        <div className="readout">
          <div className="label">STATE</div>
          <div className={`value ${alertState ? "problem" : ""}`}>{STATE_LABEL[mindName]}</div>
          <div className="note">{sub || trouble || (mind ? `since ${clock(mind.since)}` : "")}</div>
        </div>
        <div className="readout">
          <div className="label">NEXT ALARM</div>
          <div className="value">{mind?.next_alarm ? clock(mind.next_alarm.due) : "none"}</div>
          <div className="note">{mind?.next_alarm ? `${until(mind.next_alarm.due, now)} · ${mind.next_alarm.reason}` : "nothing scheduled"}</div>
        </div>
        <div className="readout">
          <div className="label">QUEUE</div>
          <div className="value">{String((mind?.queue.operator ?? 0) + (mind?.queue.autonomous ?? 0)).padStart(2, "0")}</div>
          <div className="note">
            {mind?.queue.operator ?? 0} from you · {mind?.queue.autonomous ?? 0} its own
          </div>
        </div>
        <div className="readout">
          <div className="label">ALLOWANCE</div>
          <div className="value">
            {budget ? money(budget.autonomous_usd ?? 0) : "…"} <span className="unit">free today</span>
          </div>
          {budget && <Bar fraction={budget.cap_usd > 0 ? budget.spent_usd / budget.cap_usd : 0} tone={budget.spent_usd / budget.cap_usd > 0.85 ? "red" : "amber"} small />}
          <div className="note">
            {budget ? `${money(budget.spent_usd)} of $${budget.cap_usd} this month${budget.own ? ` · Woody's own: ${money(budget.own.spent_usd)} of ${money(budget.own.share_usd)}` : ""}` : ""}
          </div>
        </div>
      </div>
      <div className="readouts">
        <div className="readout">
          <div className="label">MODEL</div>
          <div className="value">{state?.models.find((m) => m.id === state.model)?.label ?? "–"}</div>
        </div>
        <div className="readout">
          <div className="label">STEP</div>
          <div className="value">{busy ? `${String(session.steps).padStart(2, "0")}/40` : "–"}</div>
        </div>
        <div className="readout">
          <div className="label">COST OF THIS SESSION</div>
          <div className="value">{session.cost === null ? "–" : usd(session.cost)}</div>
        </div>
        <div className="readout">
          <div className="label">MODE</div>
          <div className="value">{mind?.tainted ? "notes only" : mind?.mode ?? "–"}</div>
        </div>
      </div>
      {state?.inner && (
        <>
          <h4>How Woody is, and why</h4>
          <div className="inner">
            {INNER.map(([key, name]) => {
              const f = state.inner![key];
              return (
                <div key={key} className="inner-row">
                  <span className="dim">{name}</span>
                  <Bar fraction={f.value} tone={key === "unease" && f.value > 0.66 ? "red" : "amber"} />
                  <span>{f.word}</span>
                  <span className="dim small">{f.causes.map((c) => c.text).join(" · ") || "nothing in particular"}</span>
                </div>
              );
            })}
          </div>
          <p className="dim small">Computed from the record of what happened. Woody does not choose it, and can tell you these same causes if you ask.</p>
        </>
      )}
      <h4>
        The machine
        {meters.generation ? ` · generation ${meters.generation}` : ""}
        {meters.uptime_s ? ` · up ${meters.uptime_s > 172_800 ? `${Math.floor(meters.uptime_s / 86_400)} d` : `${Math.floor(meters.uptime_s / 3600)} h`}` : ""}
      </h4>
      <div className="meters">
        <Meter label="CPU" fraction={meters.cpu_pct !== undefined ? meters.cpu_pct / 100 : undefined} value={meters.cpu_pct !== undefined ? `${meters.cpu_pct} %` : "–"} />
        <Meter
          label="MEM"
          fraction={memUsed}
          value={meters.mem_used_kb !== undefined ? `${(meters.mem_used_kb / 1_048_576).toFixed(1)} GB` : "–"}
          alert={memUsed !== undefined && memUsed > 0.9}
        />
        <Meter
          label="DISK"
          fraction={diskUsed}
          value={meters.disk_free_pct !== undefined ? `${meters.disk_free_pct.toFixed(0)} % free` : "–"}
          alert={meters.disk_free_pct !== undefined && meters.disk_free_pct < 10}
        />
        <Meter label="NET" fraction={meters.net_kbps !== undefined ? Math.min(1, meters.net_kbps / 1024) : undefined} value={meters.net_kbps !== undefined ? `${meters.net_kbps} kB/s` : "–"} />
      </div>
      <p className={failed.length ? "problem" : "dim"}>
        {failed.length ? `${failed.length} failed: ${failed.join(", ")}` : "No failed services."}
      </p>
      <h4>Services</h4>
      <p className="links-row">
        <span className={link === "open" ? "up" : "down"}>HUD gateway</span>
        <span className={agentUp ? "up" : "down"}>agent</span>
        <span className={executorUp ? "up" : "down"}>executor</span>
      </p>
    </div>
  );

  const talkBody = (
    <>
      <div
        className="talk"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {items.length === 0 && <div className="line dim empty">Nothing has been said yet. Type anywhere to write to Woody.</div>}
        {items.map((it) => (
          <TalkRow key={it.key} item={it} />
        ))}
        {busy && <div className="line dim working">{mindName === "working" ? "working on its own…" : "working…"}</div>}
      </div>
      <div className="legend">
        <span><MarkIcon mark="said" size={9} /> said</span>
        <span><MarkIcon mark="tool" size={9} /> tool</span>
        <span><MarkIcon mark="woke" size={9} /> woke</span>
        <span><MarkIcon mark="saved" size={9} /> saved</span>
        <span><MarkIcon mark="problem" size={9} /> problem</span>
      </div>
    </>
  );

  const onCanvas = canvas.things.filter((t) => !t.removed);
  const frameBody: Partial<Record<Panel["kind"], React.ReactNode>> = {
    needs: needsBody,
    goals: goalsBody,
    activity: activityBody,
    machine: machineBody,
    talk: talkBody,
    things: <ThingsRecord canvas={canvas} tx={tx} result={canvasResult} pick={panel?.kind === "things" ? panel.id : undefined} />,
    changes: <ChangesRecord canvas={canvas} tx={tx} result={canvasResult} />,
    life: <LifeRecord tx={tx} incoming={mindResult} version={version} canvas={canvas} />,
    face: <FaceRecord tx={tx} incoming={mindResult} faceVersion={state?.face ?? 0} />,
    methods: <MethodsRecord tx={tx} incoming={mindResult} version={version} />,
    studies: <StudiesRecord tx={tx} incoming={mindResult} version={version} openThing={(id) => openRecord({ kind: "things", id })} />,
  };
  const count = (n: number, width = 2) => String(n).padStart(width, "0");

  return (
    <div className={`frame ${panel ? "with-record" : ""}`}>
      {/* ---- the canvas: Woody's ---- */}
      <Canvas things={canvas.things} meters={meters} tx={tx} result={canvasResult} onWhy={(id) => openRecord({ kind: "things", id })} />
      {items.length === 0 && onCanvas.length === 0 && !panel && !draft && (
        <p className="canvas-hint">Woody is here. Start typing to talk to it. Click the lattice for its records.</p>
      )}

      {/* ---- the voice line ---- */}
      {(showState || you || reply || needs > 0 || changedSelf > 0) && (
        <div className="voice" aria-live="polite">
          {showState && (
            <div className={`voice-state ${alertState || trouble ? "alert" : ""}`}>
              <StateMark state={mindName} />
              <span>{trouble || making?.what || headline}</span>
            </div>
          )}
          {needs > 0 && (
            <button className="voice-needs" onClick={() => openRecord({ kind: "needs" })}>
              needs you · {count(needs)}
            </button>
          )}
          {changedSelf > 0 && (
            <button className="voice-note" title="See the before and the after" onClick={() => openRecord({ kind: "identity" })}>
              Woody changed its identity · see
            </button>
          )}
          {(you || reply) && (
            <button className="voice-said" title="Open the conversation" onClick={() => openRecord({ kind: "talk" })}>
              {you && <span className="voice-you">{you.text}</span>}
              {reply && (
                <span className={reply.kind === "error" ? "voice-reply problem" : "voice-reply"}>
                  {reply.text}
                  {reply.kind === "assistant" && reply.streaming && <span className="caret">▍</span>}
                </span>
              )}
            </button>
          )}
        </div>
      )}

      {/* ---- the lattice and its menu ---- */}
      <button
        className={`lattice-button ${needs > 0 ? "needs" : ""}`}
        aria-haspopup="menu"
        aria-expanded={menu}
        title="Woody. Click for Pause, Stop and the records."
        onClick={() => setMenu((m) => !m)}
      >
        <Lattice state={mindName} overlay={overlay} play={play} hold={hold} expressions={expressions} pace={latticePace} designs={designs} />
        {needs > 0 && <span className="badge">{needs}</span>}
      </button>
      {menu && (
        <>
          <div className="menu-backdrop" onClick={() => setMenu(false)} />
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
                <span className="code">F3</span> GOALS <span className="n">{count(open.length)}</span>
              </button>
              <button onClick={() => openRecord({ kind: "talk" })}>
                <span className="code">F4</span> CONVERSATION
              </button>
              <button onClick={() => openRecord({ kind: "things" })}>
                <span className="code" /> THINGS <span className="n">{count(onCanvas.length)}</span>
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
              <button onClick={() => openRecord({ kind: "methods" })}>
                <span className="code" /> ITS METHODS
              </button>
              <button onClick={() => openRecord({ kind: "face" })}>
                <span className="code" /> ITS FACE <span className="n">{Object.keys(designs).length ? count(Object.keys(designs).length) : ""}</span>
              </button>
              <button onClick={() => openRecord({ kind: "memory" })}>
                <span className="code">F5</span> MEMORY <span className="n">{count(state?.mind?.memories ?? 0, 3)}</span>
              </button>
              <button onClick={() => openRecord({ kind: "journal" })}>
                <span className="code">F6</span> JOURNAL <span className="n">{count(state?.mind?.journal ?? 0, 3)}</span>
              </button>
              <button onClick={() => openRecord({ kind: "identity" })}>
                <span className="code">F7</span> IDENTITY <span className="n">{changedSelf > 0 ? "new · " : ""}v{count(identity?.current.version ?? state?.mind?.identity_version ?? 1)}</span>
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
              {door.terminal && (
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
      )}

      {/* ---- a record, below the lattice ---- */}
      {panel && (
        <div className="record-layer">
          <PanelView
            panel={panel}
            setPanel={setPanel}
            tx={tx}
            incoming={mindResult}
            gateway={gatewayResult}
            door={door}
            version={version}
            state={state}
            identity={identity}
            smallLimit={smallLimit}
            expressions={expressions}
            setExpressions={setExpressions}
          >
            {frameBody[panel.kind]}
          </PanelView>
        </div>
      )}

      {/* ---- the typing line: always there to catch keystrokes, visible once something is typed ---- */}
      <form
        className={`typing ${draft ? "shown" : ""}`}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label htmlFor="message">&gt;</label>
        <textarea
          id="message"
          ref={lineRef}
          value={draft}
          rows={1}
          tabIndex={draft ? 0 : -1}
          aria-label="Write to Woody"
          placeholder={!agentUp ? "Agent offline…" : "Write to Woody"}
          onChange={(e) => {
            setDraft(e.target.value);
            setTyping(true);
            window.clearTimeout(typingTimer.current);
            typingTimer.current = window.setTimeout(() => setTyping(false), 2500);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button disabled={!canSend}>SEND</button>
        <span className="typing-note">{!agentUp ? "agent offline" : busy ? "Woody is working: it reads this at its next step" : "enter sends · shift+enter new line · esc clears"}</span>
      </form>

      {notices.length > 0 && (
        <div className="notices" aria-live="polite">
          {notices.map((n) => (
            <div key={n.key} className={`notice ${n.level}`}>
              <strong>{n.title}</strong>
              {n.body && <span>{n.body}</span>}
              {n.copy && <span className="copy-text">{n.copy.length > 300 ? `${n.copy.slice(0, 300)}…` : n.copy}</span>}
              <div className="notice-actions">
                {n.copy && (
                  <button
                    onClick={() => {
                      navigator.clipboard
                        .writeText(n.copy!)
                        .then(() => setNotices((prev) => prev.map((x) => (x.key === n.key ? { ...x, copied: true } : x))))
                        .catch(() => setNotices((prev) => prev.map((x) => (x.key === n.key ? { ...x, body: "Copy failed: the browser refused clipboard access." } : x))));
                    }}
                  >
                    {n.copied ? "copied" : "copy"}
                  </button>
                )}
                <button className="ghost" onClick={() => setNotices((prev) => prev.filter((x) => x.key !== n.key))}>
                  dismiss
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ---- the approval prompt: drawn by the frame, above everything ---- */}
      {pending && (
        <ApprovalModal approval={pending} more={approvals.length - 1} deciding={deciding === pending.approval_id} onDecide={(d) => decide(pending, d)} />
      )}
    </div>
  );
}

function Meter({ label, fraction, value, alert = false }: { label: string; fraction: number | undefined; value: string; alert?: boolean }) {
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
function TalkRow({ item }: { item: Item }) {
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
