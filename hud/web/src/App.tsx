import { useCallback, useEffect, useRef, useState } from "react";

// ---- protocol types -------------------------------------------------------

type Model = { id: string; label: string; note: string };
type Budget = { month: string; spent_usd: number; cap_usd: number; remaining_usd: number; exhausted: boolean };
type AgentState = {
  model: string;
  models: Model[];
  busy: boolean;
  budget: Budget;
  has_credential: boolean;
};
type Approval = {
  approval_id: string;
  action: string;
  params: unknown;
  action_hash: string;
  created_ms: number;
  expires_ms: number;
};

type Item =
  | { kind: "user"; key: number; text: string }
  | { kind: "assistant"; key: number; text: string; streaming: boolean }
  | { kind: "tool"; key: number; id: string; name: string; input: unknown; result?: string; isError?: boolean }
  | { kind: "meta"; key: number; text: string }
  | { kind: "error"; key: number; text: string };

type Link = "connecting" | "open" | "closed" | "no-token";

// ---- token ----------------------------------------------------------------

function takeToken(): string | null {
  const match = /[#&]t=([0-9a-f]{64})/.exec(location.hash);
  if (match) {
    sessionStorage.setItem("woody-token", match[1]!);
    history.replaceState(null, "", location.pathname);
  }
  return sessionStorage.getItem("woody-token");
}

const TOOL_PREFIX = "mcp__woody__";
const usd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;

const ERROR_TEXT: Record<string, string> = {
  "no-credential": "No Claude API key is configured for the agent.",
  "budget-exhausted": "The monthly spending cap has been reached.",
  busy: "Woody is still working on the previous message.",
  "agent-unavailable": "The agent service is not reachable.",
  "turn-failed": "The reply failed.",
};

// ---- app ------------------------------------------------------------------

export function App() {
  const [link, setLink] = useState<Link>("connecting");
  const [agentUp, setAgentUp] = useState(false);
  const [executorUp, setExecutorUp] = useState(true);
  const [state, setState] = useState<AgentState | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const socket = useRef<WebSocket | null>(null);
  const nextKey = useRef(1);
  const scroller = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);

  const push = useCallback((item: Record<string, unknown>) => {
    setItems((prev) => [...prev, { ...item, key: nextKey.current++ } as Item]);
  }, []);

  const onMessage = useCallback(
    (msg: Record<string, any>) => {
      switch (msg.type) {
        case "state":
          setState(msg as unknown as AgentState);
          setAgentUp(true);
          break;
        case "agent_up":
          setAgentUp(true);
          break;
        case "agent_down":
          setAgentUp(false);
          break;
        case "user_text":
          push({ kind: "user", text: msg.text });
          break;
        case "assistant_delta":
          setItems((prev) => {
            const last = prev[prev.length - 1];
            if (last?.kind === "assistant" && last.streaming) {
              return [...prev.slice(0, -1), { ...last, text: last.text + msg.text }];
            }
            return [...prev, { kind: "assistant", key: nextKey.current++, text: msg.text, streaming: true }];
          });
          break;
        case "assistant_text":
          setItems((prev) => {
            const last = prev[prev.length - 1];
            if (last?.kind === "assistant" && last.streaming) {
              return [...prev.slice(0, -1), { ...last, text: msg.text, streaming: false }];
            }
            return [...prev, { kind: "assistant", key: nextKey.current++, text: msg.text, streaming: false }];
          });
          break;
        case "tool_use":
          push({ kind: "tool", id: msg.id, name: msg.name, input: msg.input });
          break;
        case "tool_result":
          setItems((prev) =>
            prev.map((it) =>
              it.kind === "tool" && it.id === msg.id ? { ...it, result: msg.preview, isError: msg.is_error } : it,
            ),
          );
          break;
        case "result":
          setItems((prev) => prev.map((it) => (it.kind === "assistant" && it.streaming ? { ...it, streaming: false } : it)));
          push({
            kind: "meta",
            text:
              msg.subtype === "success"
                ? `${usd(msg.cost_usd ?? 0)} · ${((msg.duration_ms ?? 0) / 1000).toFixed(1)} s`
                : `stopped: ${String(msg.subtype).replaceAll("_", " ")} · ${usd(msg.cost_usd ?? 0)}`,
          });
          break;
        case "error":
          push({
            kind: "error",
            text: (ERROR_TEXT[msg.error] ?? msg.error) + (msg.detail && !ERROR_TEXT[msg.error] ? `: ${msg.detail}` : ""),
          });
          break;
        case "approvals":
          setApprovals(msg.items ?? []);
          setExecutorUp(Boolean(msg.executor_up));
          break;
        case "decide_result":
          setDeciding(null);
          if (!msg.ok) push({ kind: "error", text: `Decision not applied: ${msg.error ?? "unknown error"}` });
          break;
      }
    },
    [push],
  );

  // connection, with reconnect
  useEffect(() => {
    const token = takeToken();
    if (!token) {
      setLink("no-token");
      return;
    }
    let stopped = false;
    let timer: number | undefined;
    const connect = () => {
      if (stopped) return;
      setLink("connecting");
      const ws = new WebSocket(`ws://${location.host}/ws?t=${token}`);
      socket.current = ws;
      ws.onopen = () => setLink("open");
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

  // keep the transcript pinned to the bottom unless the reader scrolled up
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  const tx = (message: Record<string, unknown>) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message));
  };

  const busy = state?.busy ?? false;
  const canSend = link === "open" && agentUp && !busy && draft.trim().length > 0;

  const submit = () => {
    if (!canSend) return;
    stick.current = true;
    tx({ type: "chat", text: draft.trim() });
    setDraft("");
  };

  const decide = (approval: Approval, decision: "approve" | "deny") => {
    setDeciding(approval.approval_id);
    tx({ type: "decide", approval_id: approval.approval_id, action_hash: approval.action_hash, decision });
  };

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

  return (
    <div className="hud">
      <header className="bar">
        <div className="brand">
          WOODPECKER<span className="dim"> · WOODY</span>
        </div>
        <div className="status">
          <Dot ok={link === "open"} label="hud" />
          <Dot ok={agentUp} label="agent" />
          <Dot ok={executorUp} label="executor" />
        </div>
        <div className="controls">
          <label className="dim" htmlFor="model">
            model
          </label>
          <select
            id="model"
            value={state?.model ?? ""}
            disabled={!state || busy}
            onChange={(e) => tx({ type: "set_model", model: e.target.value })}
          >
            {(state?.models ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} ({m.note})
              </option>
            ))}
          </select>
          <button className="ghost" disabled={busy || !agentUp} onClick={() => { tx({ type: "new_session" }); setItems([]); }}>
            new chat
          </button>
          {state && <BudgetMeter budget={state.budget} />}
        </div>
      </header>

      <div
        className="transcript"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {items.length === 0 && (
          <div className="empty">
            <p>Woody is ready.</p>
            <p className="dim">Ask about this machine, or ask it to do something. Actions that change the system wait for your approval here.</p>
          </div>
        )}
        {state && !state.has_credential && (
          <div className="row error">No Claude API key is configured for the agent. See docs/AGENT.md.</div>
        )}
        {items.map((it) => (
          <Row key={it.key} item={it} />
        ))}
        {busy && <div className="row working">working…</div>}
      </div>

      <footer className="composer">
        <textarea
          value={draft}
          placeholder={agentUp ? "Message Woody (Enter to send, Shift+Enter for a new line)" : "Agent offline…"}
          rows={2}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {busy ? (
          <button className="danger" onClick={() => tx({ type: "interrupt" })}>
            stop
          </button>
        ) : (
          <button disabled={!canSend} onClick={submit}>
            send
          </button>
        )}
      </footer>

      {pending && (
        <ApprovalModal
          approval={pending}
          more={approvals.length - 1}
          deciding={deciding === pending.approval_id}
          onDecide={(d) => decide(pending, d)}
        />
      )}
    </div>
  );
}

// ---- pieces ---------------------------------------------------------------

function Dot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`dot ${ok ? "ok" : "bad"}`} title={`${label}: ${ok ? "up" : "down"}`}>
      <i />
      {label}
    </span>
  );
}

function BudgetMeter({ budget }: { budget: Budget }) {
  const fraction = budget.cap_usd > 0 ? Math.min(1, budget.spent_usd / budget.cap_usd) : 0;
  return (
    <div className={`budget ${fraction > 0.8 ? "warn" : ""}`} title={`Claude API spend in ${budget.month}`}>
      <span>
        {usd(budget.spent_usd)} / ${budget.cap_usd}
      </span>
      <div className="track">
        <div className="fill" style={{ width: `${fraction * 100}%` }} />
      </div>
    </div>
  );
}

function Row({ item }: { item: Item }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="row user">
          <span className="who">you</span>
          <div className="text">{item.text}</div>
        </div>
      );
    case "assistant":
      return (
        <div className="row assistant">
          <span className="who">woody</span>
          <div className="text">
            {item.text}
            {item.streaming && <span className="caret">▍</span>}
          </div>
        </div>
      );
    case "tool": {
      const name = item.name.startsWith(TOOL_PREFIX) ? item.name.slice(TOOL_PREFIX.length) : item.name;
      const args = JSON.stringify(item.input);
      return (
        <details className={`row tool ${item.isError ? "failed" : ""}`}>
          <summary>
            <span className="who">tool</span>
            <span className="name">{name}</span>
            <span className="args">{args === "{}" ? "" : args}</span>
            <span className="state">{item.result === undefined ? "running" : item.isError ? "failed" : "done"}</span>
          </summary>
          {item.result !== undefined && <pre>{item.result}</pre>}
        </details>
      );
    }
    case "meta":
      return <div className="row meta">{item.text}</div>;
    case "error":
      return <div className="row error">{item.text}</div>;
  }
}

function ApprovalModal({
  approval,
  more,
  deciding,
  onDecide,
}: {
  approval: Approval;
  more: number;
  deciding: boolean;
  onDecide: (decision: "approve" | "deny") => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const left = Math.max(0, Math.round((approval.expires_ms - now) / 1000));
  const denyRef = useRef<HTMLButtonElement | null>(null);
  // Focus starts on Deny so a stray Enter can never approve.
  useEffect(() => denyRef.current?.focus(), [approval.approval_id]);

  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-labelledby="approval-title">
      <div className="modal">
        <h2 id="approval-title">Approval needed</h2>
        <p className="dim">Woody is asking to run an action that changes the system.</p>
        <dl>
          <dt>action</dt>
          <dd className="strong">{approval.action}</dd>
          <dt>parameters</dt>
          <dd>
            <pre>{JSON.stringify(approval.params, null, 2)}</pre>
          </dd>
          <dt>request</dt>
          <dd className="dim">
            {approval.approval_id} · sha256 {approval.action_hash.slice(0, 16)}…
          </dd>
          <dt>expires</dt>
          <dd className="dim">
            in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
          </dd>
        </dl>
        {more > 0 && <p className="dim">{more} more waiting after this one.</p>}
        <div className="actions">
          <button ref={denyRef} className="ghost" disabled={deciding} onClick={() => onDecide("deny")}>
            deny
          </button>
          <button className="danger" disabled={deciding} onClick={() => onDecide("approve")}>
            approve
          </button>
        </div>
      </div>
    </div>
  );
}
