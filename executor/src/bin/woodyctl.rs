//! Human-side command line for the executor.
//!
//!   sudo woodyctl pending                  list actions waiting for approval
//!   sudo woodyctl approve <id>             approve one
//!   sudo woodyctl deny <id>                deny one
//!   sudo woodyctl audit-tail [n]           last audit records
//!   sudo woodyctl scope                    show the engagement in force
//!   sudo woodyctl pause | resume | status  stop or allow everything that is not read-only
//!   sudo woodyctl audit-verify [file]      verify the audit hash chain
//!
//! Testing as the agent (must run as the agent's user):
//!   sudo -u woody woodyctl catalog
//!   sudo -u woody woodyctl request <action> ['<json params>']
//!   sudo -u woody woodyctl wait <approval-id>

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn call(socket: &str, req: Value) -> Result<Value, String> {
    let mut stream = UnixStream::connect(socket).map_err(|e| format!("connect {socket}: {e}"))?;
    writeln!(stream, "{req}").map_err(|e| e.to_string())?;
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).map_err(|e| e.to_string())?;
    if line.is_empty() {
        return Err("connection closed without a reply".into());
    }
    serde_json::from_str(&line).map_err(|e| format!("bad reply: {e}"))
}

fn print_and_exit(result: Result<Value, String>) -> ! {
    match result {
        Ok(v) => {
            println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
            let ok = matches!(v.get("status").and_then(Value::as_str), Some("ok") | Some("pending"));
            std::process::exit(if ok { 0 } else { 1 });
        }
        Err(e) => {
            eprintln!("woodyctl: {e}");
            std::process::exit(1);
        }
    }
}

fn usage() -> ! {
    eprintln!(
        "usage: woodyctl pending | approve <id> | deny <id> | pause | resume | status | audit-tail [n] | scope | audit-verify [file]\n       woodyctl catalog | request <action> [json] | wait <id>   (as the agent user)"
    );
    std::process::exit(2);
}

fn main() {
    let exec = env_or("WOODY_EXEC_SOCKET", "/run/woody/exec.sock");
    let approve = env_or("WOODY_APPROVE_SOCKET", "/run/woody/approve.sock");
    let args: Vec<String> = std::env::args().skip(1).collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();

    match args.as_slice() {
        ["pending"] => print_and_exit(call(&approve, json!({ "op": "pending" }))),
        ["approve", id] => print_and_exit(call(&approve, json!({ "op": "decide", "approval_id": id, "decision": "approve" }))),
        ["deny", id] => print_and_exit(call(&approve, json!({ "op": "decide", "approval_id": id, "decision": "deny" }))),
        ["audit-tail"] => print_and_exit(call(&approve, json!({ "op": "audit_tail", "n": 20 }))),
        ["audit-tail", n] => {
            let n: u64 = n.parse().unwrap_or_else(|_| usage());
            print_and_exit(call(&approve, json!({ "op": "audit_tail", "n": n })))
        }
        ["scope"] => print_and_exit(call(&approve, json!({ "op": "scope" }))),
        ["pause"] => print_and_exit(call(&approve, json!({ "op": "pause", "on": true }))),
        ["resume"] => print_and_exit(call(&approve, json!({ "op": "pause", "on": false }))),
        ["status"] => print_and_exit(call(&approve, json!({ "op": "status" }))),
        ["audit-verify"] | ["audit-verify", _] => {
            let path = args.get(1).copied().unwrap_or("/var/log/woody/audit.jsonl");
            match woody_exec::audit::verify(path) {
                Ok(r) => println!("OK: {} records, head {}", r.records, r.last_hash),
                Err(e) => {
                    eprintln!("AUDIT LOG INVALID: {e}");
                    std::process::exit(1);
                }
            }
        }
        ["catalog"] => print_and_exit(call(&exec, json!({ "op": "catalog" }))),
        ["request", action] => print_and_exit(call(&exec, json!({ "op": "action", "action": action, "params": {} }))),
        ["request", action, params] => {
            let params: Value = serde_json::from_str(params).unwrap_or_else(|e| {
                eprintln!("woodyctl: params are not JSON: {e}");
                std::process::exit(2);
            });
            print_and_exit(call(&exec, json!({ "op": "action", "action": action, "params": params })))
        }
        ["wait", id] => print_and_exit(call(&exec, json!({ "op": "wait", "approval_id": id, "timeout_ms": 60000 }))),
        _ => usage(),
    }
}
