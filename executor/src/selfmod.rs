//! Self-modification: Woody proposes a change to the system configuration,
//! the executor decides whether it touches the locked core, and a separate
//! root job builds, tests and applies it with automatic rollback.
//!
//! The agent never hands the executor a path to read. It sends file contents
//! inside the request, and the executor writes them into its own root-owned
//! copy of the configuration. Everything after that works on the copy.
//!
//! A change needs human approval when either
//!   * it touches a locked path (the executor, the HUD, firewall, users...), or
//!   * the privilege fingerprint of the evaluated system differs from the
//!     running one (nix/locked/fingerprint.nix), whichever file caused it.

use crate::config::{Config, SelfMod};
use crate::util::{now_ms, sha256_hex};
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

const MAX_FILES: usize = 60;
const MAX_TOTAL_BYTES: usize = 600 * 1024;
const MAX_DIFF_BYTES: usize = 48 * 1024;
const MAX_TREE_ENTRIES: usize = 5000;
const KEEP_CANDIDATES: usize = 20;
const EVAL_TIMEOUT_S: &str = "300";
/// A job that has not updated its status for this long is considered dead.
const STALE_JOB_MS: u64 = 2 * 60 * 60 * 1000;

pub struct Proposal {
    pub summary: String,
    pub files: Vec<(String, String)>,
    pub delete: Vec<String>,
}

fn settings(cfg: &Config) -> Result<&SelfMod, String> {
    cfg.selfmod.as_ref().ok_or_else(|| "self-modification is not configured on this system".to_string())
}

/// A path inside the configuration repository: relative, plain components.
pub fn valid_path(p: &str) -> bool {
    !p.is_empty()
        && p.len() <= 200
        && p.split('/').count() <= 10
        && p.split('/').all(|c| {
            !c.is_empty()
                && c != "."
                && c != ".."
                && c != ".git"
                && !c.starts_with('-')
                && c.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-' | '+' | '@'))
        })
}

pub fn valid_id(id: &str) -> bool {
    id.len() == 16 && id.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))
}

pub fn is_locked(path: &str, locked: &[String]) -> bool {
    locked.iter().any(|l| if l.ends_with('/') { path.starts_with(l.as_str()) } else { path == l })
}

pub fn parse_proposal(map: &Map<String, Value>) -> Result<Proposal, String> {
    let summary = map.get("summary").and_then(Value::as_str).ok_or("missing parameter: summary")?.trim().to_string();
    if summary.is_empty() || summary.chars().count() > 200 || summary.chars().any(char::is_control) {
        return Err("summary must be 1..200 characters on one line".into());
    }
    let mut seen = BTreeSet::new();
    let mut files = Vec::new();
    let mut total = 0usize;
    if let Some(v) = map.get("files") {
        for item in v.as_array().ok_or("files must be a list")? {
            let o = item.as_object().ok_or("each file must be {path, content}")?;
            if o.keys().any(|k| k != "path" && k != "content") {
                return Err("each file must be {path, content}".into());
            }
            let path = o.get("path").and_then(Value::as_str).ok_or("file without a path")?;
            let content = o.get("content").and_then(Value::as_str).ok_or("file without content")?;
            if !valid_path(path) {
                return Err(format!("invalid path: {path}"));
            }
            if content.contains('\0') {
                return Err(format!("{path}: only text files can be proposed"));
            }
            if !seen.insert(path.to_string()) {
                return Err(format!("path listed twice: {path}"));
            }
            total += content.len();
            files.push((path.to_string(), content.to_string()));
        }
    }
    let mut delete = Vec::new();
    if let Some(v) = map.get("delete") {
        for item in v.as_array().ok_or("delete must be a list")? {
            let path = item.as_str().ok_or("delete must be a list of paths")?;
            if !valid_path(path) {
                return Err(format!("invalid path: {path}"));
            }
            if !seen.insert(path.to_string()) {
                return Err(format!("path listed twice: {path}"));
            }
            delete.push(path.to_string());
        }
    }
    if files.is_empty() && delete.is_empty() {
        return Err("the proposal contains no files".into());
    }
    if files.len() + delete.len() > MAX_FILES {
        return Err(format!("too many files (limit {MAX_FILES})"));
    }
    if total > MAX_TOTAL_BYTES {
        return Err(format!("proposal too large (limit {MAX_TOTAL_BYTES} bytes)"));
    }
    Ok(Proposal { summary, files, delete })
}

/// What goes into the audit log for a proposal: hashes, not file contents.
pub fn audit_params(params: &Value) -> Value {
    let mut out = params.clone();
    if let Some(files) = out.get_mut("files").and_then(Value::as_array_mut) {
        for f in files {
            if let Some(content) = f.get("content").and_then(Value::as_str) {
                let (hash, bytes) = (sha256_hex(content.as_bytes()), content.len());
                if let Some(o) = f.as_object_mut() {
                    o.remove("content");
                    o.insert("sha256".into(), json!(hash));
                    o.insert("bytes".into(), json!(bytes));
                }
            }
        }
    }
    out
}

fn clip(s: &str, max: usize) -> (String, bool) {
    if s.len() <= max {
        return (s.to_string(), false);
    }
    let mut cut = max;
    while !s.is_char_boundary(cut) {
        cut -= 1;
    }
    (s[..cut].to_string(), true)
}

fn tail(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.len() <= max {
        return s.to_string();
    }
    let mut cut = s.len() - max;
    while !s.is_char_boundary(cut) {
        cut += 1;
    }
    format!("…{}", &s[cut..])
}

/// The configuration the running system was built from (a Nix store path).
fn base_path(sm: &SelfMod) -> Result<PathBuf, String> {
    let real = fs::canonicalize(&sm.source).map_err(|e| format!("configuration source {}: {e}", sm.source))?;
    #[cfg(not(test))]
    if !real.starts_with("/nix/store") {
        return Err("configuration source is not in the Nix store".into());
    }
    Ok(real)
}

fn copy_tree(src: &Path, dst: &Path, count: &mut usize) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("mkdir {}: {e}", dst.display()))?;
    for entry in fs::read_dir(src).map_err(|e| format!("read {}: {e}", src.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        *count += 1;
        if *count > MAX_TREE_ENTRIES {
            return Err("configuration tree is too large".into());
        }
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let meta = fs::symlink_metadata(&from).map_err(|e| e.to_string())?;
        if meta.is_dir() {
            copy_tree(&from, &to, count)?;
        } else if meta.file_type().is_symlink() {
            let target = fs::read_link(&from).map_err(|e| e.to_string())?;
            std::os::unix::fs::symlink(target, &to).map_err(|e| e.to_string())?;
        } else if meta.is_file() {
            fs::copy(&from, &to).map_err(|e| format!("copy {}: {e}", from.display()))?;
            let mode = if meta.permissions().mode() & 0o111 != 0 { 0o755 } else { 0o644 };
            fs::set_permissions(&to, fs::Permissions::from_mode(mode)).map_err(|e| e.to_string())?;
        }
    }
    fs::set_permissions(dst, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())
}

/// Every directory between `tree` and the file must be a real directory.
fn safe_parent(tree: &Path, rel: &str) -> Result<(), String> {
    let mut cur = tree.to_path_buf();
    let parts: Vec<&str> = rel.split('/').collect();
    for part in &parts[..parts.len() - 1] {
        cur.push(part);
        match fs::symlink_metadata(&cur) {
            Ok(m) if m.is_dir() => {}
            Ok(_) => return Err(format!("{rel}: {part} is not a directory")),
            Err(_) => fs::create_dir(&cur).map_err(|e| format!("mkdir {}: {e}", cur.display()))?,
        }
    }
    Ok(())
}

/// Applies the proposal to a fresh copy of `base`. Returns (path, kind) for
/// each file that really changed.
fn stage(base: &Path, tree: &Path, p: &Proposal) -> Result<Vec<(String, &'static str)>, String> {
    let mut count = 0;
    copy_tree(base, tree, &mut count)?;
    let mut changes = Vec::new();
    for (rel, content) in &p.files {
        safe_parent(tree, rel)?;
        let target = tree.join(rel);
        let kind = match fs::symlink_metadata(&target) {
            Ok(m) if m.is_file() => {
                if fs::read(&target).map(|old| old == content.as_bytes()).unwrap_or(false) {
                    continue;
                }
                "modified"
            }
            Ok(_) => return Err(format!("{rel}: not a regular file")),
            Err(_) => "added",
        };
        fs::write(&target, content).map_err(|e| format!("write {rel}: {e}"))?;
        fs::set_permissions(&target, fs::Permissions::from_mode(0o644)).map_err(|e| e.to_string())?;
        changes.push((rel.clone(), kind));
    }
    for rel in &p.delete {
        let target = tree.join(rel);
        match fs::symlink_metadata(&target) {
            Ok(m) if m.is_file() => fs::remove_file(&target).map_err(|e| format!("delete {rel}: {e}"))?,
            _ => return Err(format!("{rel}: cannot delete, no such file")),
        }
        changes.push((rel.clone(), "deleted"));
    }
    if changes.is_empty() {
        return Err("the proposal changes nothing: every file already has that content".into());
    }
    Ok(changes)
}

fn tool(program: &str) -> Command {
    let mut c = Command::new(program);
    c.env_clear()
        .env("LC_ALL", "C")
        .env("HOME", "/var/lib/woody-execd")
        .env("NIX_REMOTE", "daemon")
        .env("NIX_CONFIG", "experimental-features = nix-command flakes");
    c
}

fn unified_diff(sm: &SelfMod, base: &Path, tree: &Path) -> (String, bool) {
    let out = tool(&sm.diff).arg("-ruN").arg(base).arg(tree).output();
    let text = match out {
        Ok(o) if matches!(o.status.code(), Some(0) | Some(1)) => String::from_utf8_lossy(&o.stdout).into_owned(),
        _ => return ("(diff unavailable)".into(), false),
    };
    let text = text
        .replace(&format!("{}/", base.display()), "a/")
        .replace(&format!("{}/", tree.display()), "b/");
    clip(&text, MAX_DIFF_BYTES)
}

fn eval_fingerprint(sm: &SelfMod, flake_dir: &Path) -> Result<Value, String> {
    let out = tool(&sm.timeout)
        .args([EVAL_TIMEOUT_S, &sm.nix, "eval", "--json", "--no-write-lock-file"])
        .arg(format!("path:{}#fingerprint", flake_dir.display()))
        .output()
        .map_err(|e| format!("spawn nix: {e}"))?;
    if out.status.code() == Some(124) {
        return Err("evaluation timed out".into());
    }
    if !out.status.success() {
        return Err(tail(&String::from_utf8_lossy(&out.stderr), 1500));
    }
    serde_json::from_slice(&out.stdout).map_err(|e| format!("fingerprint output: {e}"))
}

/// "section/item" for every fingerprint entry that differs.
pub fn fingerprint_changes(a: &Value, b: &Value) -> Vec<String> {
    let empty = Map::new();
    let (a, b) = (a.as_object().unwrap_or(&empty), b.as_object().unwrap_or(&empty));
    let sections: BTreeSet<&String> = a.keys().chain(b.keys()).collect();
    let mut out = Vec::new();
    for s in sections {
        let x = a.get(s).and_then(Value::as_object).unwrap_or(&empty);
        let y = b.get(s).and_then(Value::as_object).unwrap_or(&empty);
        let items: BTreeSet<&String> = x.keys().chain(y.keys()).collect();
        for i in items {
            if x.get(i) != y.get(i) {
                out.push(format!("{s}/{i}"));
            }
        }
    }
    out
}

fn base_fingerprint(sm: &SelfMod, base: &Path) -> Result<Value, String> {
    let cache = Path::new(&sm.state_dir).join(format!(
        "base-{}.json",
        &sha256_hex(base.display().to_string().as_bytes())[..16]
    ));
    if let Ok(text) = fs::read_to_string(&cache) {
        if let Ok(v) = serde_json::from_str(&text) {
            return Ok(v);
        }
    }
    let v = eval_fingerprint(sm, base).map_err(|e| format!("could not evaluate the running configuration: {e}"))?;
    let _ = fs::write(&cache, v.to_string());
    Ok(v)
}

fn candidate_dir(sm: &SelfMod, id: &str) -> PathBuf {
    Path::new(&sm.state_dir).join("candidates").join(id)
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

fn load_meta(sm: &SelfMod, id: &str) -> Result<Value, String> {
    if !valid_id(id) {
        return Err("invalid candidate id".into());
    }
    read_json(&candidate_dir(sm, id).join("meta.json"))
        .ok_or_else(|| "unknown candidate (propose the change first)".to_string())
}

fn status_of(sm: &SelfMod, id: &str) -> Value {
    read_json(&candidate_dir(sm, id).join("status.json")).unwrap_or_else(|| json!({ "state": "proposed" }))
}

fn job_running(status: &Value) -> bool {
    let state = status.get("state").and_then(Value::as_str).unwrap_or("");
    let updated_ms = status.get("updated_s").and_then(Value::as_u64).unwrap_or(0) * 1000;
    matches!(state, "starting" | "running") && now_ms().saturating_sub(updated_ms) < STALE_JOB_MS
}

fn prune(sm: &SelfMod) {
    let dir = Path::new(&sm.state_dir).join("candidates");
    let Ok(read) = fs::read_dir(&dir) else { return };
    let mut all: Vec<(std::time::SystemTime, PathBuf)> = read
        .flatten()
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    all.sort();
    let excess = all.len().saturating_sub(KEEP_CANDIDATES);
    for (_, path) in all.into_iter().take(excess) {
        if !job_running(&read_json(&path.join("status.json")).unwrap_or(Value::Null)) {
            let _ = fs::remove_dir_all(path);
        }
    }
}

/// Without the diff: what the agent gets back.
fn public_meta(meta: &Value, with_diff: bool) -> Value {
    let mut m = meta.clone();
    if !with_diff {
        if let Some(o) = m.as_object_mut() {
            o.remove("diff");
        }
    }
    m
}

pub fn propose(cfg: &Config, map: &Map<String, Value>) -> Result<Value, String> {
    let sm = settings(cfg)?;
    let proposal = parse_proposal(map)?;
    let base = base_path(sm)?;

    let mut files = proposal.files.clone();
    files.sort();
    let mut delete = proposal.delete.clone();
    delete.sort();
    let id = sha256_hex(json!([base.display().to_string(), files, delete]).to_string().as_bytes())[..16].to_string();

    let dir = candidate_dir(sm, &id);
    if let Some(meta) = read_json(&dir.join("meta.json")) {
        return Ok(public_meta(&meta, true));
    }

    // The human's checkout must match what is running, or applying this
    // change would silently drop theirs (or the next rebuild would drop ours).
    let check = tool(&sm.script).arg("check").output().map_err(|e| format!("spawn check: {e}"))?;
    if !check.status.success() {
        return Err(format!(
            "the configuration repository does not match the running system ({}). The operator needs to run woody-rebuild before a change can be proposed.",
            tail(&String::from_utf8_lossy(&check.stderr), 300)
        ));
    }

    let tmp = dir.with_extension("tmp");
    let _ = fs::remove_dir_all(&tmp);
    let tree = tmp.join("tree");
    fs::create_dir_all(&tmp).map_err(|e| format!("mkdir {}: {e}", tmp.display()))?;

    let result = (|| -> Result<Value, String> {
        let changes = stage(&base, &tree, &proposal)?;
        let locked: Vec<&str> = changes.iter().map(|c| c.0.as_str()).filter(|p| is_locked(p, &sm.locked_paths)).collect();
        let (diff, diff_truncated) = unified_diff(sm, &base, &tree);
        let before = base_fingerprint(sm, &base)?;
        let after = eval_fingerprint(sm, &tree)
            .map_err(|e| format!("the proposed configuration does not evaluate:\n{e}"))?;
        let fp = fingerprint_changes(&before, &after);
        let meta = json!({
            "candidate": id,
            "summary": proposal.summary,
            "base": base.display().to_string(),
            "created_ms": now_ms(),
            "changed": changes.iter().map(|(p, k)| json!({ "path": p, "kind": k })).collect::<Vec<_>>(),
            "locked_paths": locked,
            "privilege_changes": fp,
            "requires_approval": !locked.is_empty() || !fp.is_empty(),
            "diff": diff,
            "diff_truncated": diff_truncated,
        });
        let list: String = changes
            .iter()
            .map(|(p, k)| format!("{} {p}\n", if *k == "deleted" { "D" } else { "M" }))
            .collect();
        fs::write(tmp.join("changes.txt"), list).map_err(|e| e.to_string())?;
        fs::write(tmp.join("summary.txt"), format!("{}\n", proposal.summary)).map_err(|e| e.to_string())?;
        fs::write(tmp.join("meta.json"), meta.to_string()).map_err(|e| e.to_string())?;
        Ok(meta)
    })();

    match result {
        Ok(meta) => {
            fs::rename(&tmp, &dir).map_err(|e| format!("store candidate: {e}"))?;
            prune(sm);
            Ok(public_meta(&meta, true))
        }
        Err(e) => {
            let _ = fs::remove_dir_all(&tmp);
            Err(e)
        }
    }
}

/// Checks an apply request. Ok(true) means it needs human approval.
pub fn classify_apply(cfg: &Config, id: &str) -> Result<bool, String> {
    let sm = settings(cfg)?;
    let meta = load_meta(sm, id)?;
    let base = base_path(sm)?;
    if meta.get("base").and_then(Value::as_str) != Some(&base.display().to_string()) {
        return Err("stale: the system has changed since this was proposed; propose it again".into());
    }
    match status_of(sm, id).get("state").and_then(Value::as_str) {
        Some("applied") => return Err("this candidate has already been applied".into()),
        Some("starting") | Some("running") if job_running(&status_of(sm, id)) => {
            return Err("this candidate is already being applied".into())
        }
        _ => {}
    }
    Ok(meta.get("requires_approval").and_then(Value::as_bool).unwrap_or(true))
}

pub fn apply(cfg: &Config, id: &str) -> Result<Value, String> {
    let sm = settings(cfg)?;
    classify_apply(cfg, id)?;
    let dir = candidate_dir(sm, id);

    let active = Path::new(&sm.state_dir).join("active");
    if let Ok(other) = fs::read_to_string(&active) {
        let other = other.trim();
        if valid_id(other) && job_running(&status_of(sm, other)) {
            return Err(format!("another configuration change is being applied (candidate {other})"));
        }
    }
    let now = now_ms();
    fs::write(
        dir.join("status.json"),
        json!({ "state": "starting", "step": "queue", "message": "", "updated_s": now / 1000 }).to_string(),
    )
    .map_err(|e| e.to_string())?;
    let _ = fs::remove_file(dir.join("reported"));
    fs::write(&active, id).map_err(|e| e.to_string())?;

    // The job runs as its own systemd unit so that it survives if activating
    // the new configuration restarts the executor or the agent.
    let unit = format!("woody-selfmod-{id}-{}", now / 1000);
    let out = tool(&sm.systemd_run)
        .args(["--unit", &unit, "--collect", "--no-block", "--quiet", "--description", "Woody configuration change"])
        .arg(&sm.script)
        .arg("apply")
        .arg(&dir)
        .output()
        .map_err(|e| format!("spawn systemd-run: {e}"))?;
    if !out.status.success() {
        let msg = tail(&String::from_utf8_lossy(&out.stderr), 400);
        let _ = fs::write(
            dir.join("status.json"),
            json!({ "state": "failed", "step": "queue", "message": msg, "updated_s": now_ms() / 1000 }).to_string(),
        );
        return Err(format!("could not start the job: {msg}"));
    }
    Ok(json!({
        "candidate": id, "started": true, "unit": format!("{unit}.service"),
        "note": "The change is being built and tested in the background. Poll config.status.",
    }))
}

pub fn status(cfg: &Config, id: &str) -> Result<Value, String> {
    let sm = settings(cfg)?;
    let meta = load_meta(sm, id)?;
    let mut st = status_of(sm, id);
    let state = st.get("state").and_then(Value::as_str).unwrap_or("").to_string();
    let terminal = matches!(state.as_str(), "applied" | "failed");
    let marker = candidate_dir(sm, id).join("reported");
    let first = terminal && !marker.exists() && fs::write(&marker, "").is_ok();
    if let Some(o) = st.as_object_mut() {
        o.insert("candidate".into(), json!(id));
        o.insert("summary".into(), meta.get("summary").cloned().unwrap_or(Value::Null));
        o.insert("requires_approval".into(), meta.get("requires_approval").cloned().unwrap_or(Value::Null));
        o.insert("finished".into(), json!(terminal));
        if first {
            o.insert("first_report".into(), json!(true));
        }
    }
    Ok(st)
}

/// What the human is shown when asked to approve an apply.
pub fn approval_detail(cfg: &Config, id: &str) -> Option<Value> {
    let sm = settings(cfg).ok()?;
    load_meta(sm, id).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// Finds a tool on the test process PATH (the Nix build sandbox has no /usr/bin).
    fn which(name: &str) -> String {
        std::env::var("PATH")
            .unwrap_or_default()
            .split(':')
            .map(|d| Path::new(d).join(name))
            .find(|p| p.is_file())
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| panic!("{name} not found on PATH"))
    }

    fn script(path: &Path, body: &str) -> String {
        fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        path.display().to_string()
    }

    /// A fake system: a source tree, a `nix` that reports a fingerprint that
    /// changes when the tree contains the word "root-service", and a job
    /// script whose `check` succeeds.
    fn fixture(name: &str) -> (Config, PathBuf) {
        let root = std::env::temp_dir().join(format!("woody-selfmod-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let src = root.join("source");
        fs::create_dir_all(src.join("nix/modules")).unwrap();
        fs::create_dir_all(src.join("nix/locked")).unwrap();
        fs::write(src.join("flake.nix"), "{ }\n").unwrap();
        fs::write(src.join("nix/modules/woody.nix"), "{ }\n").unwrap();
        fs::write(src.join("nix/locked/executor.nix"), "{ }\n").unwrap();
        let bin = root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        let grep = which("grep");
        let nix = script(
            &bin.join("nix"),
            &r#"for a in "$@"; do case "$a" in path:*) dir="${a#path:}"; dir="${dir%%#*}";; esac; done
if grep -rq "does-not-evaluate" "$dir"; then echo "error: undefined variable" >&2; exit 1; fi
if grep -rq "root-service" "$dir"; then echo '{"units":{"a.service":"1","evil.service":"9"},"users":{"woody":"1"}}'
else echo '{"units":{"a.service":"1"},"users":{"woody":"1"}}'; fi"#
                .replace("grep -rq", &format!("{grep} -rq")),
        );
        let timeout = script(&bin.join("timeout"), r#"shift; exec "$@""#);
        let job = script(&bin.join("job"), "exit 0");
        let systemd_run = script(&bin.join("systemd-run"), "exit 0");
        let cfg: Config = serde_json::from_value(json!({
            "agent_user": "woody", "hud_user": "woody-hud",
            "exec_socket": "/x", "approve_socket": "/y", "audit_path": "/z",
            "systemctl": "/bin/false", "journalctl": "/bin/false",
            "selfmod": {
                "source": src.display().to_string(),
                "state_dir": root.join("state").display().to_string(),
                "nix": nix, "diff": which("diff"), "timeout": timeout,
                "systemd_run": systemd_run, "script": job,
                "locked_paths": ["nix/locked/", "executor/", "flake.nix"],
            }
        }))
        .unwrap();
        fs::create_dir_all(root.join("state")).unwrap();
        (cfg, root)
    }

    fn params(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn paths_are_strict() {
        for bad in [
            "", "/etc/passwd", "../x", "a/../b", "a//b", "./a", "a/./b", ".git/config", "a/.git/hooks/x",
            "a b", "a;b", "$(id)", "-rf", "a/-x", "a\nb", "a\\b", "a/b/c/d/e/f/g/h/i/j/k",
        ] {
            assert!(!valid_path(bad), "{bad:?}");
        }
        for ok in ["flake.nix", "nix/modules/woody.nix", ".gitignore", "agent/src/server.ts", "docs/A+B@1.md"] {
            assert!(valid_path(ok), "{ok}");
        }
        assert!(valid_id("0123456789abcdef"));
        for bad in ["", "0123", "0123456789ABCDEF", "../../../etc/pass", "0123456789abcdeg"] {
            assert!(!valid_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn locked_paths_match_by_prefix_or_name() {
        let locked = vec!["nix/locked/".to_string(), "flake.nix".to_string()];
        assert!(is_locked("nix/locked/executor.nix", &locked));
        assert!(is_locked("flake.nix", &locked));
        assert!(!is_locked("flake.nix.bak", &locked));
        assert!(!is_locked("nix/lockedx/a", &locked));
        assert!(!is_locked("nix/modules/woody.nix", &locked));
    }

    #[test]
    fn proposals_are_validated() {
        let bad = [
            json!({}),
            json!({"summary": "x"}),
            json!({"summary": "", "files": [{"path": "a", "content": "b"}]}),
            json!({"summary": "two\nlines", "files": [{"path": "a", "content": "b"}]}),
            json!({"summary": "x", "files": [{"path": "../a", "content": "b"}]}),
            json!({"summary": "x", "files": [{"path": "a", "content": "b", "mode": "4755"}]}),
            json!({"summary": "x", "files": [{"path": "a", "content": "b"}, {"path": "a", "content": "c"}]}),
            json!({"summary": "x", "files": [{"path": "a", "content": "b"}], "delete": ["a"]}),
            json!({"summary": "x", "files": [{"path": "a", "content": "nul\u{0}"}]}),
            json!({"summary": "x", "files": "a"}),
            json!({"summary": "x", "files": [{"path": "a", "content": "y".repeat(MAX_TOTAL_BYTES + 1)}]}),
        ];
        for b in bad {
            assert!(parse_proposal(&params(b.clone())).is_err(), "{b}");
        }
        assert!(parse_proposal(&params(json!({"summary": "ok", "delete": ["a/b"]}))).is_ok());
    }

    #[test]
    fn fingerprint_diff_names_entries() {
        let a = json!({"units": {"a": "1", "b": "2"}, "users": {"u": "1"}});
        let b = json!({"units": {"a": "1", "b": "3", "c": "4"}, "sudo": {"config": "x"}});
        assert_eq!(fingerprint_changes(&a, &b), vec!["sudo/config", "units/b", "units/c", "users/u"]);
        assert!(fingerprint_changes(&a, &a).is_empty());
    }

    #[test]
    fn harmless_change_needs_no_approval() {
        let (cfg, root) = fixture("free");
        let meta = propose(&cfg, &params(json!({
            "summary": "add a package",
            "files": [{"path": "nix/modules/woody.nix", "content": "{ pkgs }: { }\n"}],
        })))
        .unwrap();
        assert_eq!(meta["requires_approval"], json!(false));
        assert_eq!(meta["changed"], json!([{"path": "nix/modules/woody.nix", "kind": "modified"}]));
        assert!(meta["diff"].as_str().unwrap().contains("+{ pkgs }: { }"));
        let id = meta["candidate"].as_str().unwrap();
        assert_eq!(classify_apply(&cfg, id), Ok(false));
        // The source itself is untouched.
        assert_eq!(fs::read_to_string(root.join("source/nix/modules/woody.nix")).unwrap(), "{ }\n");
        // Proposing the same thing again gives the same candidate.
        let again = propose(&cfg, &params(json!({
            "summary": "add a package",
            "files": [{"path": "nix/modules/woody.nix", "content": "{ pkgs }: { }\n"}],
        })))
        .unwrap();
        assert_eq!(again["candidate"], meta["candidate"]);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn locked_path_needs_approval() {
        let (cfg, root) = fixture("locked");
        let meta = propose(&cfg, &params(json!({
            "summary": "touch the executor",
            "files": [{"path": "nix/locked/executor.nix", "content": "{ changed = true; }\n"}],
        })))
        .unwrap();
        assert_eq!(meta["requires_approval"], json!(true));
        assert_eq!(meta["locked_paths"], json!(["nix/locked/executor.nix"]));
        assert_eq!(classify_apply(&cfg, meta["candidate"].as_str().unwrap()), Ok(true));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn indirect_privilege_change_needs_approval() {
        let (cfg, root) = fixture("indirect");
        // A non-locked file that changes what runs as root.
        let meta = propose(&cfg, &params(json!({
            "summary": "looks harmless",
            "files": [{"path": "nix/modules/woody.nix", "content": "{ root-service = true; }\n"}],
        })))
        .unwrap();
        assert_eq!(meta["locked_paths"], json!([]));
        assert_eq!(meta["privilege_changes"], json!(["units/evil.service"]));
        assert_eq!(meta["requires_approval"], json!(true));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn broken_or_empty_proposals_are_refused() {
        let (cfg, root) = fixture("broken");
        let e = propose(&cfg, &params(json!({
            "summary": "broken",
            "files": [{"path": "nix/modules/woody.nix", "content": "does-not-evaluate\n"}],
        })))
        .unwrap_err();
        assert!(e.contains("does not evaluate") && e.contains("undefined variable"), "{e}");
        let e = propose(&cfg, &params(json!({
            "summary": "same",
            "files": [{"path": "nix/modules/woody.nix", "content": "{ }\n"}],
        })))
        .unwrap_err();
        assert!(e.contains("changes nothing"), "{e}");
        assert!(propose(&cfg, &params(json!({"summary": "x", "delete": ["nope.nix"]}))).is_err());
        // Nothing is left behind.
        let left = fs::read_dir(root.join("state/candidates")).map(|d| d.count()).unwrap_or(0);
        assert_eq!(left, 0);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn out_of_sync_repository_blocks_proposals() {
        let (mut cfg, root) = fixture("sync");
        let sm = cfg.selfmod.as_mut().unwrap();
        sm.script = script(&root.join("bin/job"), "echo 'uncommitted changes' >&2; exit 1");
        let e = propose(&cfg, &params(json!({
            "summary": "x", "files": [{"path": "a.nix", "content": "1\n"}],
        })))
        .unwrap_err();
        assert!(e.contains("woody-rebuild") && e.contains("uncommitted changes"), "{e}");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn apply_and_status_lifecycle() {
        let (cfg, root) = fixture("apply");
        assert!(classify_apply(&cfg, "0123456789abcdef").is_err());
        assert!(classify_apply(&cfg, "../../etc").is_err());
        let meta = propose(&cfg, &params(json!({
            "summary": "new file", "files": [{"path": "docs/note.md", "content": "hi\n"}],
        })))
        .unwrap();
        let id = meta["candidate"].as_str().unwrap().to_string();
        assert_eq!(status(&cfg, &id).unwrap()["state"], json!("proposed"));

        let started = apply(&cfg, &id).unwrap();
        assert_eq!(started["started"], json!(true));
        assert_eq!(status(&cfg, &id).unwrap()["state"], json!("starting"));
        // A second apply, or another candidate, is refused while it runs.
        assert!(apply(&cfg, &id).is_err());
        let other = propose(&cfg, &params(json!({
            "summary": "other", "files": [{"path": "docs/other.md", "content": "x\n"}],
        })))
        .unwrap();
        assert!(apply(&cfg, other["candidate"].as_str().unwrap()).unwrap_err().contains("another configuration change"));

        // The job finishes: reported once, then no longer "first".
        let dir = root.join("state/candidates").join(&id);
        fs::write(dir.join("status.json"), json!({"state": "applied", "step": "done", "message": "", "updated_s": 1}).to_string()).unwrap();
        let s = status(&cfg, &id).unwrap();
        assert_eq!((s["finished"].clone(), s["first_report"].clone()), (json!(true), json!(true)));
        assert!(status(&cfg, &id).unwrap().get("first_report").is_none());
        assert!(classify_apply(&cfg, &id).unwrap_err().contains("already been applied"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn stale_candidate_is_refused() {
        let (mut cfg, root) = fixture("stale");
        let meta = propose(&cfg, &params(json!({
            "summary": "x", "files": [{"path": "docs/a.md", "content": "1\n"}],
        })))
        .unwrap();
        // The system moves on to a different source.
        let newer = root.join("source2");
        fs::create_dir_all(&newer).unwrap();
        cfg.selfmod.as_mut().unwrap().source = newer.display().to_string();
        assert!(classify_apply(&cfg, meta["candidate"].as_str().unwrap()).unwrap_err().contains("stale"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn audit_never_stores_file_contents() {
        let v = audit_params(&json!({"summary": "s", "files": [{"path": "a", "content": "secret"}]}));
        let text = v.to_string();
        assert!(!text.contains("secret") && text.contains("sha256") && text.contains("\"bytes\":6"));
    }
}
