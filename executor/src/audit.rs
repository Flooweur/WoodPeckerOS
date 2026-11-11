//! Append-only, hash-chained audit log (one JSON object per line).
//!
//! Each record's hash covers its own content and the previous record's hash,
//! so editing, removing or reordering any line breaks verification from that
//! point on. The file is also marked append-only at the filesystem level by
//! the service unit.

use crate::util::{now_ms, sha256_hex};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};

pub const GENESIS: &str = "0000000000000000000000000000000000000000000000000000000000000000";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Record {
    pub seq: u64,
    pub ts_ms: u64,
    pub prev: String,
    pub kind: String,
    pub data: Value,
    pub hash: String,
}

fn compute_hash(seq: u64, ts_ms: u64, prev: &str, kind: &str, data: &Value) -> String {
    // serde_json keeps object keys sorted, so this serialisation is stable.
    let body = serde_json::to_string(data).unwrap_or_default();
    sha256_hex(format!("{seq}|{ts_ms}|{prev}|{kind}|{body}").as_bytes())
}

#[derive(Debug, PartialEq)]
pub struct VerifyReport {
    pub records: u64,
    pub last_hash: String,
}

/// Verifies the whole chain. Returns the line number of the first bad record on failure.
pub fn verify(path: &str) -> Result<VerifyReport, String> {
    let file = match File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(VerifyReport { records: 0, last_hash: GENESIS.into() })
        }
        Err(e) => return Err(format!("open {path}: {e}")),
    };
    let mut prev = GENESIS.to_string();
    let mut count = 0u64;
    for (i, line) in BufReader::new(file).lines().enumerate() {
        let n = i + 1;
        let line = line.map_err(|e| format!("line {n}: {e}"))?;
        if line.is_empty() {
            return Err(format!("line {n}: empty line"));
        }
        let rec: Record = serde_json::from_str(&line).map_err(|e| format!("line {n}: not a record: {e}"))?;
        if rec.seq != count + 1 {
            return Err(format!("line {n}: sequence {} where {} was expected", rec.seq, count + 1));
        }
        if rec.prev != prev {
            return Err(format!("line {n}: chain broken (previous hash does not match)"));
        }
        let expect = compute_hash(rec.seq, rec.ts_ms, &rec.prev, &rec.kind, &rec.data);
        if rec.hash != expect {
            return Err(format!("line {n}: record was modified (hash mismatch)"));
        }
        prev = rec.hash;
        count += 1;
    }
    Ok(VerifyReport { records: count, last_hash: prev })
}

pub struct AuditLog {
    file: File,
    seq: u64,
    prev: String,
    path: String,
}

impl AuditLog {
    /// Opens the log, refusing to continue a chain that does not verify.
    pub fn open(path: &str) -> Result<AuditLog, String> {
        let report = verify(path)?;
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|e| format!("open {path}: {e}"))?;
        Ok(AuditLog { file, seq: report.records, prev: report.last_hash, path: path.to_string() })
    }

    pub fn append(&mut self, kind: &str, data: Value) -> Result<Record, String> {
        let seq = self.seq + 1;
        let ts_ms = now_ms();
        let hash = compute_hash(seq, ts_ms, &self.prev, kind, &data);
        let rec = Record { seq, ts_ms, prev: self.prev.clone(), kind: kind.to_string(), data, hash };
        let mut line = serde_json::to_string(&rec).map_err(|e| e.to_string())?;
        line.push('\n');
        self.file.write_all(line.as_bytes()).map_err(|e| format!("audit write: {e}"))?;
        self.file.sync_data().map_err(|e| format!("audit sync: {e}"))?;
        self.seq = seq;
        self.prev = rec.hash.clone();
        Ok(rec)
    }

    /// Last `n` records, oldest first.
    pub fn tail(&self, n: usize) -> Result<Vec<Record>, String> {
        let file = File::open(&self.path).map_err(|e| e.to_string())?;
        let mut all: Vec<Record> = Vec::new();
        for line in BufReader::new(file).lines() {
            let line = line.map_err(|e| e.to_string())?;
            if let Ok(rec) = serde_json::from_str::<Record>(&line) {
                all.push(rec);
                if all.len() > n {
                    all.remove(0);
                }
            }
        }
        Ok(all)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp(name: &str) -> String {
        let p = std::env::temp_dir().join(format!("woody-audit-{}-{}.jsonl", name, std::process::id()));
        let _ = std::fs::remove_file(&p);
        p.to_string_lossy().into_owned()
    }

    fn write_three(path: &str) {
        let mut log = AuditLog::open(path).unwrap();
        log.append("request", json!({"action": "system.info", "b": 1, "a": [1, 2]})).unwrap();
        log.append("result", json!({"ok": true})).unwrap();
        log.append("request", json!({"action": "service.restart", "unit": "x.service"})).unwrap();
    }

    #[test]
    fn chain_verifies_and_resumes() {
        let p = temp("ok");
        write_three(&p);
        assert_eq!(verify(&p).unwrap().records, 3);
        let mut log = AuditLog::open(&p).unwrap();
        let rec = log.append("result", json!({"ok": false})).unwrap();
        assert_eq!(rec.seq, 4);
        assert_eq!(verify(&p).unwrap().records, 4);
        assert_eq!(log.tail(2).unwrap().iter().map(|r| r.seq).collect::<Vec<_>>(), vec![3, 4]);
    }

    #[test]
    fn missing_file_is_an_empty_chain() {
        let p = temp("missing");
        assert_eq!(verify(&p).unwrap(), VerifyReport { records: 0, last_hash: GENESIS.into() });
    }

    #[test]
    fn edited_record_is_detected() {
        let p = temp("edit");
        write_three(&p);
        let text = std::fs::read_to_string(&p).unwrap().replace("x.service", "y.service");
        std::fs::write(&p, text).unwrap();
        assert!(verify(&p).unwrap_err().contains("line 3"));
        assert!(AuditLog::open(&p).is_err());
    }

    #[test]
    fn removed_record_is_detected() {
        let p = temp("remove");
        write_three(&p);
        let text = std::fs::read_to_string(&p).unwrap();
        let kept: Vec<&str> = text.lines().enumerate().filter(|(i, _)| *i != 1).map(|(_, l)| l).collect();
        std::fs::write(&p, kept.join("\n") + "\n").unwrap();
        assert!(verify(&p).unwrap_err().contains("line 2"));
    }

    #[test]
    fn reordered_records_are_detected() {
        let p = temp("reorder");
        write_three(&p);
        let text = std::fs::read_to_string(&p).unwrap();
        let mut lines: Vec<&str> = text.lines().collect();
        lines.swap(0, 1);
        std::fs::write(&p, lines.join("\n") + "\n").unwrap();
        assert!(verify(&p).is_err());
    }
}
