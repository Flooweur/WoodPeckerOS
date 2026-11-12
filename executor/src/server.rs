//! Two Unix sockets, each speaking one JSON object per line:
//!
//!  * action socket   - only the agent's uid. Request actions, wait on approvals.
//!  * approval socket - only the HUD gateway's uid and root. List and decide
//!                      approvals, read the audit tail.
//!
//! The agent has no access to the approval socket, so it cannot approve its
//! own requests whatever it is told to do.

use crate::audit::AuditLog;
use crate::catalog::{self, Tier};
use crate::config::Config;
use crate::scope::{self, Decision, Engagement, Scope};
use crate::util::{now_ms, random_id, sha256_hex};
use crate::web;
use ipnet::IpNet;
use nix::sys::socket::{getsockopt, sockopt::PeerCredentials};
use nix::unistd::{chown, Gid, Group, Uid, User};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

const MAX_LINE: usize = 1024 * 1024;
const MAX_WAIT_MS: u64 = 60_000;
const MAX_PENDING: usize = 50;

#[derive(Debug, Clone)]
enum ApprovalState {
    Pending,
    Approved(Result<Value, String>),
    Denied,
    Expired,
}

#[derive(Debug, Clone)]
struct Approval {
    id: String,
    action: String,
    params: Value,
    /// Hash of the exact action and parameters; what the human approves.
    action_hash: String,
    /// Extra context for the human (for example the diff of a config change).
    detail: Option<Value>,
    created_ms: u64,
    state: ApprovalState,
}

pub struct State {
    cfg: Config,
    deny: Vec<IpNet>,
    /// The lab networks an engagement must stay inside.
    limit: Vec<IpNet>,
    /// What was last loaded into the kernel filter ("" before the first sync),
    /// and the last error, if any.
    kernel: Mutex<(String, Option<String>)>,
    audit: Mutex<AuditLog>,
    approvals: Mutex<HashMap<String, Approval>>,
    changed: Condvar,
    agent_uid: u32,
    hud_uid: u32,
}

#[derive(Clone, Copy, PartialEq)]
enum Channel {
    Action,
    Approval,
}

fn action_hash(action: &str, params: &Value) -> String {
    sha256_hex(format!("{action}|{}", serde_json::to_string(params).unwrap_or_default()).as_bytes())
}

/// While paused, only read-only actions run. Returns the refusal reason.
pub fn pause_gate(tier: Tier, paused: bool) -> Option<&'static str> {
    if paused && !matches!(tier, Tier::Read) {
        Some("paused-by-operator")
    } else {
        None
    }
}

fn uid_of(user: &str) -> Result<u32, String> {
    User::from_name(user)
        .map_err(|e| format!("lookup user {user}: {e}"))?
        .map(|u| u.uid.as_raw())
        .ok_or_else(|| format!("user {user} does not exist"))
}

fn gid_of(group: &str) -> Result<u32, String> {
    Group::from_name(group)
        .map_err(|e| format!("lookup group {group}: {e}"))?
        .map(|g| g.gid.as_raw())
        .ok_or_else(|| format!("group {group} does not exist"))
}

impl State {
    fn paused(&self) -> bool {
        std::path::Path::new(&self.cfg.pause_path).exists()
    }

    fn status(&self) -> Value {
        json!({ "paused": self.paused(), "approval_ttl_ms": self.cfg.approval_ttl_ms })
    }

    fn audit(&self, kind: &str, data: Value) {
        let mut log = self.audit.lock().unwrap();
        if let Err(e) = log.append(kind, data) {
            // An executor that cannot write its audit log must not keep acting.
            eprintln!("FATAL: audit log write failed: {e}");
            std::process::exit(1);
        }
    }

    /// The engagement file is read on every check so a human edit takes effect
    /// at once. It is ignored unless it is owned by root and not writable by
    /// anyone else.
    fn load_scope(&self) -> Result<Scope, String> {
        let path = &self.cfg.engagement_path;
        let engagement = match std::fs::metadata(path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(format!("engagement file: {e}")),
            Ok(meta) => {
                if meta.uid() != 0 || meta.mode() & 0o022 != 0 {
                    return Err("engagement file must be owned by root and not group/world writable".into());
                }
                let text = std::fs::read_to_string(path).map_err(|e| format!("engagement file: {e}"))?;
                Some(serde_json::from_str::<Engagement>(&text).map_err(|e| format!("engagement file: {e}"))?)
            }
        };
        Scope::build(engagement.as_ref(), &self.deny)
    }

    /// Loads the networks of the engagement in force into the kernel filter
    /// that confines the security-tools user. Nothing in force (none, ended,
    /// expired, invalid file) empties the set, so the tools user can reach
    /// nothing. Runs on every engagement change and on a timer, which also
    /// covers expiry, hand edits and a firewall reload.
    fn sync_kernel(&self) {
        let Some(set) = &self.cfg.scope_set else { return };
        let nets = match self.load_scope() {
            Ok(scope) => scope.kernel_nets(now_ms()),
            Err(_) => vec![],
        };
        let script = nft_script(set, &nets);
        let outcome = run_nft(&set.nft, &script);
        let listed: Vec<String> = nets.iter().map(|n| n.to_string()).collect();
        let key = if listed.is_empty() { "-".to_string() } else { listed.join(",") };
        let error = outcome.err();
        let changed = {
            let mut last = self.kernel.lock().unwrap();
            let changed = last.0 != key || last.1 != error;
            *last = (key, error.clone());
            changed
        };
        // The set is reloaded on every tick; the audit records only changes.
        if changed {
            if let Some(e) = &error {
                eprintln!("woody-execd: kernel scope filter: {e}");
            }
            self.audit("scope_set_synced", json!({ "networks": listed, "ok": error.is_none(), "error": error }));
        }
    }

    fn write_engagement(&self, e: &Engagement) -> Result<(), String> {
        let path = &self.cfg.engagement_path;
        let tmp = format!("{path}.new");
        let text = serde_json::to_string_pretty(e).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, text + "\n").map_err(|e| format!("write engagement: {e}"))?;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o644)).map_err(|e| format!("write engagement: {e}"))?;
        std::fs::rename(&tmp, path).map_err(|e| format!("write engagement: {e}"))
    }

    fn read_engagement(&self) -> Option<Engagement> {
        let text = std::fs::read_to_string(&self.cfg.engagement_path).ok()?;
        serde_json::from_str(&text).ok()
    }

    /// The human sets the engagement: what may be tested, on what authority,
    /// and for how long. Only the approval socket reaches this.
    fn op_engagement_set(&self, req: &Value, uid: u32) -> Value {
        let err = |e: String| json!({ "status": "error", "error": e });
        let text = |k: &str| req.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();
        let (name, authorization) = (text("name"), text("authorization"));
        if name.is_empty() || name.len() > 64 {
            return err("an engagement needs a name (64 characters at most)".into());
        }
        if authorization.len() < 10 || authorization.len() > 500 {
            return err("say who authorized this testing and on what basis (10 to 500 characters)".into());
        }
        let allow: Vec<String> = req
            .get("allow")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
            .unwrap_or_default();
        if allow.is_empty() || allow.len() > 64 {
            return err("list 1 to 64 targets (addresses or networks)".into());
        }
        let hours = req.get("hours").and_then(Value::as_u64).unwrap_or(0);
        if hours == 0 || hours > self.cfg.max_engagement_hours {
            return err(format!("the duration must be 1 to {} hours", self.cfg.max_engagement_hours));
        }
        if let Err(e) = scope::within_limit(&allow, &self.limit) {
            return err(e);
        }
        let engagement = Engagement { name, authorization, expires_ms: now_ms() + hours * 3_600_000, active: true, allow };
        if let Err(e) = Scope::build(Some(&engagement), &self.deny) {
            return err(e);
        }
        if let Err(e) = self.write_engagement(&engagement) {
            return err(e);
        }
        self.audit("engagement_changed", json!({
            "op": "set", "by_uid": uid, "name": engagement.name, "authorization": engagement.authorization,
            "allow": engagement.allow, "expires_ms": engagement.expires_ms,
        }));
        self.sync_kernel();
        self.scope_report()
    }

    fn op_engagement_end(&self, uid: u32) -> Value {
        let Some(mut engagement) = self.read_engagement() else {
            return json!({ "status": "error", "error": "there is no engagement to end" });
        };
        engagement.active = false;
        if let Err(e) = self.write_engagement(&engagement) {
            return json!({ "status": "error", "error": e });
        }
        self.audit("engagement_changed", json!({ "op": "end", "by_uid": uid, "name": engagement.name }));
        self.sync_kernel();
        self.scope_report()
    }

    fn scope_report(&self) -> Value {
        let engagement = std::fs::read_to_string(&self.cfg.engagement_path)
            .ok()
            .map(|text| serde_json::from_str::<Value>(&text).unwrap_or(Value::Null));
        let kernel = self.kernel.lock().unwrap().clone();
        json!({
            "status": "ok",
            "result": {
                "engagement": engagement.clone().unwrap_or(Value::Null),
                "valid": engagement.is_none() || self.load_scope().is_ok(),
                "permanent_deny": self.cfg.permanent_deny,
                "limit": self.cfg.engagement_limit,
                "max_hours": self.cfg.max_engagement_hours,
                "kernel": {
                    "enabled": self.cfg.scope_set.is_some(),
                    "networks": if kernel.0 == "-" || kernel.0.is_empty() { vec![] } else { kernel.0.split(',').map(String::from).collect::<Vec<_>>() },
                    "error": kernel.1,
                },
            }
        })
    }

    fn scope_check(&self, target: &str) -> Decision {
        let decision = match self.load_scope() {
            Ok(scope) => scope.check(target, now_ms(), &scope::system_resolve),
            Err(e) => Decision {
                allowed: false,
                reason: format!("scope-unavailable: {e}"),
                target: target.to_string(),
                kind: "unknown".into(),
                addresses: vec![],
                exclude: vec![],
                engagement: None,
            },
        };
        self.audit("scope_check", json!({
            "target": target, "allowed": decision.allowed, "reason": decision.reason,
            "addresses": decision.addresses, "engagement": decision.engagement,
        }));
        decision
    }

    fn execute(&self, action: &str, params: &Value, via: &str) -> Result<Value, String> {
        let result = catalog::run(action, params, &self.cfg, &|t| self.scope_check(t));
        let (ok, digest, size, error) = match &result {
            Ok(v) => {
                let s = serde_json::to_string(v).unwrap_or_default();
                (true, sha256_hex(s.as_bytes()), s.len(), Value::Null)
            }
            Err(e) => (false, String::new(), 0, json!(e)),
        };
        self.audit("result", json!({
            "action": action, "action_hash": action_hash(action, params), "via": via,
            "ok": ok, "result_sha256": digest, "result_bytes": size, "error": error,
        }));
        // The outcome of a configuration change is recorded in full, once.
        if let Ok(v) = &result {
            if action == "config.status" && v.get("first_report") == Some(&json!(true)) {
                self.audit("config_outcome", json!({
                    "candidate": v.get("candidate"), "state": v.get("state"),
                    "step": v.get("step"), "message": v.get("message"), "summary": v.get("summary"),
                }));
            }
        }
        result
    }

    fn expire(&self, map: &mut HashMap<String, Approval>) {
        let now = now_ms();
        let mut expired = vec![];
        for a in map.values_mut() {
            if matches!(a.state, ApprovalState::Pending) && now.saturating_sub(a.created_ms) > self.cfg.approval_ttl_ms {
                a.state = ApprovalState::Expired;
                expired.push(a.id.clone());
            }
        }
        // Forget settled approvals after an hour.
        map.retain(|_, a| matches!(a.state, ApprovalState::Pending) || now.saturating_sub(a.created_ms) < 3_600_000);
        for id in expired {
            self.audit("approval_expired", json!({ "approval_id": id }));
        }
    }

    fn approval_response(a: &Approval) -> Value {
        match &a.state {
            ApprovalState::Pending => json!({ "status": "pending", "approval_id": a.id }),
            ApprovalState::Approved(Ok(v)) => json!({ "status": "ok", "approval_id": a.id, "result": v }),
            ApprovalState::Approved(Err(e)) => json!({ "status": "error", "approval_id": a.id, "error": e }),
            ApprovalState::Denied => json!({ "status": "denied", "approval_id": a.id, "reason": "denied-by-human" }),
            ApprovalState::Expired => json!({ "status": "denied", "approval_id": a.id, "reason": "approval-expired" }),
        }
    }

    // ---- action socket -------------------------------------------------

    fn handle_action_channel(&self, req: &Value, uid: u32) -> Value {
        match req.get("op").and_then(Value::as_str) {
            Some("catalog") => json!({ "status": "ok", "result": catalog::ACTIONS }),
            Some("status") => json!({ "status": "ok", "result": self.status() }),
            Some("action") => self.op_action(req, uid),
            Some("wait") => self.op_wait(req),
            Some("event") => {
                let mut data = req.get("data").cloned().unwrap_or(Value::Null);
                if serde_json::to_string(&data).map(|s| s.len()).unwrap_or(0) > 64 * 1024 {
                    data = json!({ "truncated": true });
                }
                self.audit("agent_event", json!({ "uid": uid, "data": data }));
                json!({ "status": "ok" })
            }
            _ => json!({ "status": "error", "error": "unknown op" }),
        }
    }

    fn op_action(&self, req: &Value, uid: u32) -> Value {
        let action = req.get("action").and_then(Value::as_str).unwrap_or("");
        let params = req.get("params").cloned().unwrap_or_else(|| json!({}));
        let hash = action_hash(action, &params);
        let logged = catalog::audit_params(action, &params);

        let tier = match catalog::classify(action, &params, &self.cfg) {
            Ok(t) => t,
            Err(reason) => {
                self.audit("request", json!({
                    "uid": uid, "action": action, "params": logged, "action_hash": hash,
                    "decision": "refused", "reason": reason,
                }));
                return json!({ "status": "denied", "reason": reason });
            }
        };

        if let Some(reason) = pause_gate(tier, self.paused()) {
            self.audit("request", json!({
                "uid": uid, "action": action, "params": logged, "action_hash": hash,
                "tier": tier, "decision": "refused", "reason": reason,
            }));
            return json!({ "status": "denied", "reason": reason });
        }

        match tier {
            Tier::Read | Tier::Reversible => {
                self.audit("request", json!({
                    "uid": uid, "action": action, "params": logged, "action_hash": hash,
                    "tier": tier, "decision": "run",
                }));
                match self.execute(action, &params, "direct") {
                    Ok(v) => json!({ "status": "ok", "result": v }),
                    Err(e) => json!({ "status": "error", "error": e }),
                }
            }
            Tier::Forbidden => {
                self.audit("request", json!({
                    "uid": uid, "action": action, "params": logged, "action_hash": hash,
                    "tier": tier, "decision": "refused", "reason": "forbidden",
                }));
                json!({ "status": "denied", "reason": "forbidden" })
            }
            Tier::Approval => {
                let mut map = self.approvals.lock().unwrap();
                self.expire(&mut map);
                let pending = map.values().filter(|a| matches!(a.state, ApprovalState::Pending)).count();
                if pending >= MAX_PENDING {
                    drop(map);
                    self.audit("request", json!({
                        "uid": uid, "action": action, "params": logged, "action_hash": hash,
                        "tier": tier, "decision": "refused", "reason": "too-many-pending-approvals",
                    }));
                    return json!({ "status": "denied", "reason": "too-many-pending-approvals" });
                }
                let id = match random_id() {
                    Ok(id) => id,
                    Err(e) => return json!({ "status": "error", "error": format!("random: {e}") }),
                };
                map.insert(id.clone(), Approval {
                    id: id.clone(),
                    action: action.to_string(),
                    params: params.clone(),
                    action_hash: hash.clone(),
                    detail: catalog::approval_detail(action, &params, &self.cfg),
                    created_ms: now_ms(),
                    state: ApprovalState::Pending,
                });
                drop(map);
                self.audit("request", json!({
                    "uid": uid, "action": action, "params": logged, "action_hash": hash,
                    "tier": tier, "decision": "pending-approval", "approval_id": id,
                }));
                self.changed.notify_all();
                json!({ "status": "pending", "approval_id": id })
            }
        }
    }

    /// Long-poll: returns as soon as the approval is settled, or "pending" after the timeout.
    fn op_wait(&self, req: &Value) -> Value {
        let Some(id) = req.get("approval_id").and_then(Value::as_str) else {
            return json!({ "status": "error", "error": "missing approval_id" });
        };
        let timeout = req.get("timeout_ms").and_then(Value::as_u64).unwrap_or(30_000).min(MAX_WAIT_MS);
        let deadline = now_ms() + timeout;
        let mut map = self.approvals.lock().unwrap();
        loop {
            self.expire(&mut map);
            match map.get(id) {
                None => return json!({ "status": "error", "error": "unknown approval_id" }),
                Some(a) if !matches!(a.state, ApprovalState::Pending) => return Self::approval_response(a),
                Some(a) => {
                    let now = now_ms();
                    if now >= deadline {
                        return Self::approval_response(a);
                    }
                    let (guard, _) = self
                        .changed
                        .wait_timeout(map, Duration::from_millis((deadline - now).min(5_000)))
                        .unwrap();
                    map = guard;
                }
            }
        }
    }

    // ---- approval socket -----------------------------------------------

    fn handle_approval_channel(&self, req: &Value, uid: u32) -> Value {
        match req.get("op").and_then(Value::as_str) {
            Some("pending") => {
                let mut map = self.approvals.lock().unwrap();
                self.expire(&mut map);
                let mut list: Vec<&Approval> =
                    map.values().filter(|a| matches!(a.state, ApprovalState::Pending)).collect();
                list.sort_by_key(|a| a.created_ms);
                let out: Vec<Value> = list
                    .iter()
                    .map(|a| json!({
                        "approval_id": a.id, "action": a.action, "params": a.params,
                        "action_hash": a.action_hash, "detail": a.detail, "created_ms": a.created_ms,
                        "expires_ms": a.created_ms + self.cfg.approval_ttl_ms,
                    }))
                    .collect();
                json!({ "status": "ok", "result": out })
            }
            Some("decide") => self.op_decide(req, uid),
            Some("status") => json!({ "status": "ok", "result": self.status() }),
            // The web allow-list is the human's: they can read and edit it here directly.
            Some("web_list") => match web::allowlist(&self.cfg) {
                Ok(v) => json!({ "status": "ok", "result": v }),
                Err(e) => json!({ "status": "error", "error": e }),
            },
            Some(op @ ("web_add" | "web_remove")) => {
                let domain = req.get("domain").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
                if !web::valid_entry(&domain) {
                    return json!({ "status": "error", "error": "not a valid host name (example.org, or *.example.org for its subdomains)" });
                }
                let done = if op == "web_add" { web::allow_add(&self.cfg, &domain) } else { web::allow_remove(&self.cfg, &domain) };
                match done {
                    Ok(v) => {
                        self.audit("web_allowlist_changed", json!({ "op": op, "domain": domain, "by_uid": uid }));
                        json!({ "status": "ok", "result": v })
                    }
                    Err(e) => json!({ "status": "error", "error": e }),
                }
            }
            Some("pause") => {
                let on = req.get("on").and_then(Value::as_bool).unwrap_or(true);
                let path = &self.cfg.pause_path;
                let done = if on {
                    std::fs::write(path, b"paused\n").map_err(|e| e.to_string())
                } else {
                    match std::fs::remove_file(path) {
                        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
                        _ => Ok(()),
                    }
                };
                match done {
                    Ok(()) => {
                        self.audit("pause_changed", json!({ "paused": on, "by_uid": uid }));
                        json!({ "status": "ok", "result": self.status() })
                    }
                    Err(e) => json!({ "status": "error", "error": format!("pause: {e}") }),
                }
            }
            Some("audit_tail") => {
                let n = req.get("n").and_then(Value::as_u64).unwrap_or(50).min(1000) as usize;
                match self.audit.lock().unwrap().tail(n) {
                    Ok(records) => json!({ "status": "ok", "result": records }),
                    Err(e) => json!({ "status": "error", "error": e }),
                }
            }
            Some("scope") => self.scope_report(),
            Some("engagement_set") => self.op_engagement_set(req, uid),
            Some("engagement_end") => self.op_engagement_end(uid),
            _ => json!({ "status": "error", "error": "unknown op" }),
        }
    }

    fn op_decide(&self, req: &Value, uid: u32) -> Value {
        let Some(id) = req.get("approval_id").and_then(Value::as_str) else {
            return json!({ "status": "error", "error": "missing approval_id" });
        };
        let approve = match req.get("decision").and_then(Value::as_str) {
            Some("approve") => true,
            Some("deny") => false,
            _ => return json!({ "status": "error", "error": "decision must be approve or deny" }),
        };

        let (action, params, hash) = {
            let mut map = self.approvals.lock().unwrap();
            self.expire(&mut map);
            let Some(a) = map.get_mut(id) else {
                return json!({ "status": "error", "error": "unknown approval_id" });
            };
            if !matches!(a.state, ApprovalState::Pending) {
                return json!({ "status": "error", "error": "approval already settled" });
            }
            // If the caller states what it thinks it is approving, it must match.
            if let Some(expect) = req.get("action_hash").and_then(Value::as_str) {
                if expect != a.action_hash {
                    return json!({ "status": "error", "error": "action_hash mismatch" });
                }
            }
            if approve && self.paused() {
                return json!({ "status": "error", "error": "paused-by-operator: resume Woody before approving actions" });
            }
            if !approve {
                a.state = ApprovalState::Denied;
            }
            (a.action.clone(), a.params.clone(), a.action_hash.clone())
        };

        self.audit("approval_decided", json!({
            "approval_id": id, "decided_by_uid": uid, "action": action,
            "action_hash": hash, "decision": if approve { "approve" } else { "deny" },
        }));

        if !approve {
            self.changed.notify_all();
            return json!({ "status": "ok", "result": { "approval_id": id, "decision": "deny" } });
        }

        // Re-validate: configuration may have changed since the request was made.
        let result = match catalog::classify(&action, &params, &self.cfg) {
            _ if self.paused() => Err("paused-by-operator: resume Woody before approving actions".to_string()),
            Ok(Tier::Forbidden) => Err("forbidden".to_string()),
            Ok(_) => self.execute(&action, &params, "approved"),
            Err(e) => Err(e),
        };
        let response = match &result {
            Ok(v) => json!({ "status": "ok", "result": { "approval_id": id, "decision": "approve", "result": v } }),
            Err(e) => json!({ "status": "error", "error": e }),
        };
        if let Some(a) = self.approvals.lock().unwrap().get_mut(id) {
            a.state = ApprovalState::Approved(result);
        }
        self.changed.notify_all();
        response
    }
}

/// One atomic nftables transaction: empty both sets, then load the networks.
pub fn nft_script(set: &crate::config::ScopeSet, nets: &[IpNet]) -> String {
    let mut out = String::new();
    for (name, want_v4) in [(&set.set4, true), (&set.set6, false)] {
        out.push_str(&format!("flush set inet {} {}\n", set.table, name));
        let members: Vec<String> = nets
            .iter()
            .filter(|n| matches!(n, IpNet::V4(_)) == want_v4)
            .map(|n| n.to_string())
            .collect();
        if !members.is_empty() {
            out.push_str(&format!("add element inet {} {} {{ {} }}\n", set.table, name, members.join(", ")));
        }
    }
    out
}

fn run_nft(nft: &str, script: &str) -> Result<(), String> {
    use std::process::{Command, Stdio};
    let mut child = Command::new(nft)
        .args(["-f", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("nft: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(script.as_bytes());
    }
    let out = child.wait_with_output().map_err(|e| format!("nft: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().chars().take(300).collect())
    }
}

fn serve_connection(state: Arc<State>, stream: UnixStream, channel: Channel) {
    let uid = match getsockopt(&stream, PeerCredentials) {
        Ok(cred) => cred.uid(),
        Err(_) => return,
    };
    let allowed = match channel {
        Channel::Action => uid == state.agent_uid,
        Channel::Approval => uid == state.hud_uid || uid == 0,
    };
    let mut writer = match stream.try_clone() {
        Ok(w) => w,
        Err(_) => return,
    };
    if !allowed {
        state.audit("connection_refused", json!({
            "uid": uid,
            "channel": if channel == Channel::Action { "action" } else { "approval" },
        }));
        let _ = writeln!(writer, "{}", json!({ "status": "denied", "reason": "peer-not-authorized" }));
        return;
    }

    let mut reader = BufReader::new(stream);
    loop {
        let mut line = String::new();
        // Read at most MAX_LINE bytes of one line.
        let mut limited = std::io::Read::take(&mut reader, MAX_LINE as u64 + 1);
        match limited.read_line(&mut line) {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        if line.len() > MAX_LINE {
            let _ = writeln!(writer, "{}", json!({ "status": "error", "error": "request too large" }));
            return;
        }
        if line.trim().is_empty() {
            continue;
        }
        let mut response = match serde_json::from_str::<Value>(&line) {
            Ok(req) if req.is_object() => {
                let mut r = match channel {
                    Channel::Action => state.handle_action_channel(&req, uid),
                    Channel::Approval => state.handle_approval_channel(&req, uid),
                };
                if let (Some(id), Some(obj)) = (req.get("id"), r.as_object_mut()) {
                    obj.insert("id".into(), id.clone());
                }
                r
            }
            _ => json!({ "status": "error", "error": "request must be a JSON object" }),
        };
        if response.is_null() {
            response = json!({ "status": "error", "error": "internal" });
        }
        if writeln!(writer, "{response}").is_err() {
            return;
        }
    }
}

fn bind(path: &str, group: &str) -> Result<UnixListener, String> {
    let _ = std::fs::remove_file(path);
    let listener = UnixListener::bind(path).map_err(|e| format!("bind {path}: {e}"))?;
    let gid = gid_of(group)?;
    chown(path, Some(Uid::from_raw(0)), Some(Gid::from_raw(gid))).map_err(|e| format!("chown {path}: {e}"))?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o660))
        .map_err(|e| format!("chmod {path}: {e}"))?;
    Ok(listener)
}

fn accept_loop(state: Arc<State>, listener: UnixListener, channel: Channel) {
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let state = state.clone();
                std::thread::spawn(move || serve_connection(state, stream, channel));
            }
            Err(e) => eprintln!("accept: {e}"),
        }
    }
}

pub fn serve(cfg: Config) -> Result<(), String> {
    let deny = scope::parse_deny(&cfg.permanent_deny)?;
    let limit = scope::parse_deny(&cfg.engagement_limit).map_err(|e| e.replace("deny", "engagement limit"))?;
    let agent_uid = uid_of(&cfg.agent_user)?;
    let hud_uid = uid_of(&cfg.hud_user)?;
    let audit = AuditLog::open(&cfg.audit_path)?;

    let action_listener = bind(&cfg.exec_socket, &cfg.agent_user)?;
    let approval_listener = bind(&cfg.approve_socket, &cfg.hud_user)?;

    let state = Arc::new(State {
        cfg,
        deny,
        limit,
        kernel: Mutex::new((String::new(), None)),
        audit: Mutex::new(audit),
        approvals: Mutex::new(HashMap::new()),
        changed: Condvar::new(),
        agent_uid,
        hud_uid,
    });

    state.audit("executor_start", json!({
        "version": env!("CARGO_PKG_VERSION"), "paused": state.paused(),
        "agent_uid": agent_uid, "hud_uid": hud_uid,
        "actions": catalog::ACTIONS.iter().map(|a| a.name).collect::<Vec<_>>(),
    }));
    eprintln!("woody-execd: listening on {} and {}", state.cfg.exec_socket, state.cfg.approve_socket);

    // Keep the kernel filter in step with the engagement, including its expiry.
    let s3 = state.clone();
    std::thread::spawn(move || loop {
        s3.sync_kernel();
        std::thread::sleep(Duration::from_secs(15));
    });

    let s2 = state.clone();
    let t = std::thread::spawn(move || accept_loop(s2, approval_listener, Channel::Approval));
    accept_loop(state, action_listener, Channel::Action);
    let _ = t.join();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pause_blocks_everything_but_reads() {
        assert_eq!(pause_gate(Tier::Read, true), None);
        for tier in [Tier::Reversible, Tier::Approval, Tier::Forbidden] {
            assert_eq!(pause_gate(tier, true), Some("paused-by-operator"));
            assert_eq!(pause_gate(tier, false), None);
        }
        assert_eq!(pause_gate(Tier::Read, false), None);
    }

    #[test]
    fn kernel_filter_script_empties_then_loads() {
        let set = crate::config::ScopeSet { nft: "nft".into(), table: "woody_scope".into(), set4: "targets4".into(), set6: "targets6".into() };
        let nets: Vec<IpNet> = ["192.168.222.0/24", "10.9.8.7/32", "fd00:1::/64"].iter().map(|s| s.parse().unwrap()).collect();
        assert_eq!(
            nft_script(&set, &nets),
            "flush set inet woody_scope targets4\nadd element inet woody_scope targets4 { 192.168.222.0/24, 10.9.8.7/32 }\n\
             flush set inet woody_scope targets6\nadd element inet woody_scope targets6 { fd00:1::/64 }\n"
        );
        // Nothing in force: both sets are emptied and nothing is added.
        assert_eq!(nft_script(&set, &[]), "flush set inet woody_scope targets4\nflush set inet woody_scope targets6\n");
    }
}
