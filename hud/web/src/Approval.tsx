// The approval prompt. Deny has the focus, so a stray Enter can never approve.
import { useEffect, useRef, useState } from "react";
import type { Approval } from "./types";

export function ApprovalModal({
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
