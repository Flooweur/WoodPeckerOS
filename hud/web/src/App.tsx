import { useCallback, useEffect, useRef, useState } from "react";

// ---- protocol types -------------------------------------------------------

type Model = { id: string; label: string; note: string };
type Budget = { month: string; spent_usd: number; cap_usd: number; remaining_usd: number; exhausted: boolean };
type MindState = {
  state: "attending" | "working" | "resting" | "waiting" | "paused" | "out_of_allowance" | "no_credential";
  focus: string;
  since: number;
  queue: { operator: number; autonomous: number };
  next_alarm: { id: number; due: number; reason: string } | null;
  waiting_on_operator: number;
};
type AgentState = {
  model: string;
  models: Model[];
  busy: boolean;
  budget: Budget;
  has_credential: boolean;
  mind_state?: MindState;
};

const MIND_LABEL: Record<MindState["state"], string> = {
  attending: "answering you",
  working: "working",
  resting: "resting",
  waiting: "waiting on you",
  paused: "paused",
  out_of_allowance: "out of allowance",
  no_credential: "no API key",
};
type Approval = {
  approval_id: string;
  action: string;
  params: unknown;
  action_hash: string;
  created_ms: number;
  expires_ms: number;
  /** Extra context from the executor; for config.apply, the staged change. */
  detail?: ConfigChange | null;
};
type ConfigChange = {
  summary?: string;
  changed?: Array<{ path: string; kind: string }>;
  locked_paths?: string[];
  privilege_changes?: string[];
  diff?: string;
  diff_truncated?: boolean;
};

type Item =
  | { kind: "user"; key: number; text: string }
  | { kind: "assistant"; key: number; text: string; streaming: boolean }
  | { kind: "tool"; key: number; id: string; name: string; input: unknown; result?: string; isError?: boolean }
  | { kind: "meta"; key: number; text: string }
  | { kind: "error"; key: number; text: string };

type Notice = { key: number; title: string; body: string; level: "info" | "warn" | "alert"; copy?: string; copied?: boolean };

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
  const [notices, setNotices] = useState<Notice[]>([]);
  const [paused, setPaused] = useState(false);

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
        case "history":
          // The conversation as stored by the agent: shown again after a reload.
          setItems(
            (Array.isArray(msg.items) ? msg.items : []).map((it: Record<string, unknown>) => ({
              ...it,
              key: nextKey.current++,
              ...(it.kind === "assistant" ? { streaming: false } : {}),
            })) as Item[],
          );
          break;
        case "user_text":
          push({ kind: "user", text: msg.text });
          break;
        case "note":
          // Woody woke up by itself, or something else worth a line.
          push({ kind: "meta", text: msg.text });
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
          setPaused(Boolean(msg.paused));
          setExecutorUp(Boolean(msg.executor_up));
          break;
        case "notify": {
          const key = nextKey.current++;
          const level = msg.level === "alert" || msg.level === "warn" ? msg.level : "info";
          const copy = typeof msg.copy === "string" && msg.copy ? msg.copy : undefined;
          setNotices((prev) => [...prev.slice(-4), { key, title: String(msg.title ?? ""), body: String(msg.body ?? ""), level, copy }]);
          // Alerts and copy offers stay until dismissed; the rest clear themselves.
          if (level !== "alert" && !copy) window.setTimeout(() => setNotices((prev) => prev.filter((n) => n.key !== key)), 15000);
          break;
        }
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
  // A message can be sent while Woody works: it reads it at its next step.
  const canSend = link === "open" && agentUp && draft.trim().length > 0;
  const mind = state?.mind_state;

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
        {mind && (
          <div className={`presence ${paused ? "paused" : mind.state}`} title={mind.focus}>
            <strong>{paused ? "paused" : MIND_LABEL[mind.state]}</strong>
            {mind.focus && <span className="dim"> · {mind.focus.length > 70 ? `${mind.focus.slice(0, 70)}…` : mind.focus}</span>}
          </div>
        )}
        <div className="controls">
          <label className="dim" htmlFor="model">
            model
          </label>
          <select
            id="model"
            value={state?.model ?? ""}
            disabled={!state}
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
          <button
            className={paused ? "danger" : "ghost"}
            disabled={!executorUp}
            title={paused ? "Woody is paused: nothing but read-only actions can run" : "Stop everything Woody does on its own until you resume"}
            onClick={() => tx({ type: "pause", on: !paused })}
          >
            {paused ? "resume" : "pause"}
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
        {busy && <div className="row working">{mind?.state === "working" ? "working on its own…" : "working…"}</div>}
      </div>

      <footer className="composer">
        <textarea
          value={draft}
          placeholder={
            !agentUp
              ? "Agent offline…"
              : busy
                ? "Woody is working. Your message will reach it at its next step (Enter to send)"
                : "Message Woody (Enter to send, Shift+Enter for a new line)"
          }
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
        <div className="composer-buttons">
          <button disabled={!canSend} onClick={submit}>
            send
          </button>
          {busy && (
            <button className="danger" onClick={() => tx({ type: "interrupt" })}>
              stop
            </button>
          )}
        </div>
      </footer>

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
  const change = approval.action === "config.apply" && approval.detail ? approval.detail : null;

  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-labelledby="approval-title">
      <div className={change ? "modal wide" : "modal"}>
        <h2 id="approval-title">Approval needed</h2>
        <p className="dim">
          {change
            ? "Woody is asking to change this system's configuration in a way that touches the locked core."
            : "Woody is asking to run an action that changes the system."}
        </p>
        <dl>
          <dt>action</dt>
          <dd className="strong">{approval.action}</dd>
          {change ? (
            <>
              <dt>change</dt>
              <dd>{change.summary}</dd>
              <dt>files</dt>
              <dd>
                {(change.changed ?? []).map((f) => (
                  <div key={f.path}>
                    <span className="dim">{f.kind}</span> {f.path}
                  </div>
                ))}
              </dd>
              <dt>why it asks</dt>
              <dd>
                {(change.locked_paths ?? []).map((p) => (
                  <div key={p} className="alert-text">locked file: {p}</div>
                ))}
                {(change.privilege_changes ?? []).map((p) => (
                  <div key={p} className="alert-text">privilege change: {p}</div>
                ))}
              </dd>
              <dt>diff</dt>
              <dd>
                <pre className="diff">
                  {(change.diff ?? "").split("\n").map((line, i) => (
                    <span
                      key={i}
                      className={
                        line.startsWith("+") && !line.startsWith("+++")
                          ? "add"
                          : line.startsWith("-") && !line.startsWith("---")
                            ? "del"
                            : undefined
                      }
                    >
                      {line + "\n"}
                    </span>
                  ))}
                </pre>
                {change.diff_truncated && <p className="alert-text">The diff is longer than shown here.</p>}
              </dd>
            </>
          ) : (
            <>
              <dt>parameters</dt>
              <dd>
                <pre>{JSON.stringify(approval.params, null, 2)}</pre>
              </dd>
            </>
          )}
          <dt>request</dt>
          <dd className="dim">
            {approval.approval_id} · sha256 {approval.action_hash.slice(0, 16)}…
          </dd>
          <dt>expires</dt>
          <dd className="dim">
            {left > 172800
              ? `in ${Math.floor(left / 86400)} days`
              : left > 7200
                ? `in ${Math.floor(left / 3600)} hours`
                : `in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`}
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
