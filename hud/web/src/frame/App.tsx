// The frame: the part of the screen Woody cannot change.
//
// A black canvas (Woody's: its things are shown by ../canvas/Canvas) and,
// fixed in the top right corner, the lattice. Clicking the lattice opens its menu: Pause, Stop and the
// records. Beside the lattice, the voice line shows what Woody is doing and
// what it last said. Typing anywhere opens a line to write to Woody. A record
// opens below the lattice; an approval prompt is drawn above everything.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, type BridgeAnswer } from "../canvas/Canvas";
import type { CanvasResult, CanvasState } from "../canvas/types";
import { ApprovalModal } from "./Approval";
import { ChangesRecord, ThingsRecord } from "./CanvasRecords";
import { Lattice, type MindStateName, type Overlay, type Play } from "./Lattice";
import { LifeRecord } from "./Life";
import { FaceRecord } from "./Face";
import { StudiesRecord } from "./Studies";
import { MethodsRecord } from "./Methods";
import { FilesRecord } from "./Files";
import { ActivityRecord, GoalsRecord, MachineRecord, NeedsRecord, TalkRecord } from "./FrameRecords";
import { Menu } from "./Menu";
import { ALERT_STATES, SAVING_TOOLS, STATE_LABEL, StateMark, count } from "./parts";
import { ownDesigns, type Design } from "./faceData";
import { PanelView, type Panel } from "./Panels";
import type {
  ActivityRow, AgentState, Approval, GatewayResult, Goal, Identity, InboxItem, Item, Meters, MindResult,
} from "./types";
import { TOOL_PREFIX, clock, usd } from "./types";

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
  /** Changes when the workbench's folder may have changed: the Files record then asks for it again. */
  const [filesTick, setFilesTick] = useState(0);
  /** Files dropped on the screen, on their way to Woody's workbench. */
  const [dropped, setDropped] = useState<File[]>([]);
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
  /** Where the canvas takes the gateway's answers to what things asked (each one, as it arrives). */
  const bridge = useRef<((answer: BridgeAnswer) => void) | null>(null);
  /** Content Woody just wrote into a thing, on its way to that thing. */
  const [pushed, setPushed] = useState<{ id: string; value: unknown; seq: number } | null>(null);
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
  /** The build of the frame this page was loaded with, as the gateway named it at the first greeting. */
  const frameBuild = useRef("");
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
      // Woody may have made a file during its session, or the operator gave one from another screen.
      if (msg.type === "files_changed" || msg.type === "result") setFilesTick((n) => n + 1);

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
          // The gateway says which build of the frame it serves. If it is no longer the one this
          // page was loaded with (the system was updated while the screen stayed open), the page
          // loads the new one: an old frame would not know what the new gateway can do.
          if (typeof msg.build === "string" && msg.build) {
            if (frameBuild.current && frameBuild.current !== msg.build) location.reload();
            frameBuild.current = msg.build;
          }
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
        case "thing_state":
          setPushed({ id: String(msg.id), value: msg.value ?? null, seq: ++mindSeq.current });
          break;
        case "canvas_result": {
          // What a thing asked through the bridge goes straight to the canvas, one answer at a time.
          if (String(msg.rid ?? "").startsWith("b")) {
            bridge.current?.({ rid: String(msg.rid), ok: Boolean(msg.ok), result: msg.result, error: msg.error });
            break;
          }
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
  const needs = approvals.length + inbox.length;
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

  const pending = approvals[0];
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

  // A file dropped anywhere on the screen is given to Woody: the Files record opens and takes it.
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!files.length) return;
      e.preventDefault();
      setMenu(false);
      setPanel({ kind: "files" });
      setDropped(files);
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, []);

  // ---- records whose data the frame holds ----

  const onCanvas = canvas.things.filter((t) => !t.removed);
  const frameBody: Partial<Record<Panel["kind"], React.ReactNode>> = {
    needs: <NeedsRecord approvals={approvals} inbox={inbox} openRecord={openRecord} />,
    goals: <GoalsRecord open={open} duties={duties} smallLimit={smallLimit} now={now} openRecord={openRecord} />,
    activity: <ActivityRecord activity={activity} />,
    machine: (
      <MachineRecord state={state} mindName={mindName} alertState={alertState} sub={sub} trouble={trouble} busy={busy} session={session} meters={meters} now={now} link={link} agentUp={agentUp} executorUp={executorUp} />
    ),
    talk: <TalkRecord items={items} busy={busy} mindName={mindName} scroller={scroller} stick={stick} />,
    things: <ThingsRecord canvas={canvas} tx={tx} result={canvasResult} pick={panel?.kind === "things" ? panel.id : undefined} />,
    changes: <ChangesRecord canvas={canvas} tx={tx} result={canvasResult} />,
    life: <LifeRecord tx={tx} incoming={mindResult} version={version} canvas={canvas} />,
    face: <FaceRecord tx={tx} incoming={mindResult} faceVersion={state?.face ?? 0} />,
    methods: <MethodsRecord tx={tx} incoming={mindResult} version={version} />,
    files: <FilesRecord tick={filesTick} dropped={dropped} />,
    studies: <StudiesRecord tx={tx} incoming={mindResult} version={version} openThing={(id) => openRecord({ kind: "things", id })} />,
  };

  return (
    <div className={`frame ${panel ? "with-record" : ""}`}>
      {/* ---- the canvas: Woody's ---- */}
      <Canvas things={canvas.things} meters={meters} tx={tx} result={canvasResult} onWhy={(id) => openRecord({ kind: "things", id })} bridge={bridge} pushed={pushed} />
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
        <Menu
          headline={headline}
          sub={sub}
          trouble={trouble}
          alertState={alertState}
          state={state}
          now={now}
          paused={paused}
          executorUp={executorUp}
          busy={busy}
          canvas={canvas}
          needs={needs}
          openGoals={open.length}
          onCanvas={onCanvas.length}
          designs={Object.keys(designs).length}
          changedSelf={changedSelf}
          identityVersion={identity?.current.version ?? state?.mind?.identity_version ?? 1}
          terminal={door.terminal}
          tx={tx}
          openRecord={openRecord}
          onClose={() => setMenu(false)}
        />
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
