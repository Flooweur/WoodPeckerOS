//! Read-only web access for Woody, through an allow-list the human controls.
//!
//! * Only `https://` URLs on port 443, to hosts on the allow-list.
//! * The host is resolved here, every address must be a public one (never
//!   loopback, private, link-local, the lab or the permanent deny list), and
//!   the connection is pinned to the address that was checked.
//! * Redirects are not followed: the target is returned, and must pass the
//!   same checks if Woody asks for it.
//! * The request is made by `curl` running as a user with no privileges.
//! * Adding a host to the allow-list is an approval-tier action.
//!
//! What comes back is untrusted. The agent never shows the page to the
//! working model directly (see agent/src/web.ts).

use crate::config::{Config, Web};
use crate::scope;
use ipnet::IpNet;
use nix::unistd::User;
use serde_json::{json, Value};
use std::net::IpAddr;
use std::os::unix::fs::MetadataExt;
use std::process::Command;

const MAX_URL: usize = 2000;
const MAX_BODY_BYTES: usize = 3_000_000;
const MAX_RETURN_CHARS: usize = 600_000;
const MAX_DOMAINS: usize = 300;

fn settings(cfg: &Config) -> Result<&Web, String> {
    cfg.web.as_ref().ok_or_else(|| "web access is not configured on this system".to_string())
}

fn valid_host(host: &str) -> bool {
    let labels: Vec<&str> = host.split('.').collect();
    host.len() <= 253
        && labels.len() >= 2
        && labels.iter().all(|l| {
            !l.is_empty()
                && l.len() <= 63
                && !l.starts_with('-')
                && !l.ends_with('-')
                && l.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        })
        // A name whose last label is a number is an IP address in disguise.
        && labels.last().is_some_and(|l| l.chars().any(|c| c.is_ascii_lowercase()))
}

/// Accepts only `https://host[:443]/...`. Returns the host and the URL as it will be requested.
pub fn parse_url(url: &str) -> Result<(String, String), String> {
    if url.len() > MAX_URL {
        return Err("the URL is too long".into());
    }
    if url.chars().any(|c| c.is_control() || c == ' ' || c == '"' || c == '\\' || c == '<' || c == '>') {
        return Err("the URL contains characters that are not allowed".into());
    }
    let rest = url.strip_prefix("https://").ok_or("only https:// URLs can be fetched")?;
    let rest = rest.split('#').next().unwrap_or("");
    let end = rest.find(['/', '?']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    if authority.contains('@') || authority.contains('[') {
        return Err("the URL must name a host, without credentials or an address literal".into());
    }
    let host = match authority.split_once(':') {
        None => authority,
        Some((h, "443")) => h,
        Some(_) => return Err("only port 443 is allowed".into()),
    };
    let host = host.to_ascii_lowercase();
    if !valid_host(&host) {
        return Err("the URL does not name a valid host".into());
    }
    let tail = if tail.is_empty() { "/".to_string() } else if tail.starts_with('?') { format!("/{tail}") } else { tail.to_string() };
    Ok((host.clone(), format!("https://{host}{tail}")))
}

/// An allow-list entry: `example.org`, or `*.example.org` for any subdomain.
pub fn valid_entry(entry: &str) -> bool {
    valid_host(entry.strip_prefix("*.").unwrap_or(entry))
}

pub fn host_allowed(host: &str, list: &[String]) -> bool {
    list.iter().any(|e| match e.strip_prefix("*.") {
        Some(base) => host.len() > base.len() + 1 && host.ends_with(base) && host.as_bytes()[host.len() - base.len() - 1] == b'.',
        None => host == e,
    })
}

fn in_any(ip: IpAddr, nets: &[&str]) -> bool {
    nets.iter().filter_map(|n| n.parse::<IpNet>().ok()).any(|n| n.contains(&ip))
}

/// True only for addresses on the public internet.
pub fn is_public(ip: IpAddr) -> bool {
    let ip = match ip {
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => IpAddr::V6(v6),
        },
        v4 => v4,
    };
    !in_any(
        ip,
        &[
            "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
            "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24",
            "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
            "::/127", "64:ff9b::/96", "100::/64", "2001:db8::/32", "fc00::/7", "fe80::/10", "ff00::/8",
        ],
    )
}

/// The allow-list file is only honoured if it is root's and nobody else can write it.
pub fn load_allowlist(path: &str) -> Result<Vec<String>, String> {
    let meta = match std::fs::metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(format!("web allow-list: {e}")),
        Ok(m) => m,
    };
    #[cfg(not(test))]
    if meta.uid() != 0 || meta.mode() & 0o022 != 0 {
        return Err("the web allow-list must be owned by root and not group/world writable".into());
    }
    let _ = &meta;
    let text = std::fs::read_to_string(path).map_err(|e| format!("web allow-list: {e}"))?;
    let v: Value = serde_json::from_str(&text).map_err(|e| format!("web allow-list: {e}"))?;
    Ok(v.get("domains")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_ascii_lowercase).filter(|d| valid_entry(d)).collect())
        .unwrap_or_default())
}

/// Adds one entry to the allow-list (after the human approved it).
pub fn add_domain(path: &str, entry: &str) -> Result<Vec<String>, String> {
    let entry = entry.to_ascii_lowercase();
    if !valid_entry(&entry) {
        return Err("not a valid host name".into());
    }
    let mut list = load_allowlist(path)?;
    if !list.contains(&entry) {
        if list.len() >= MAX_DOMAINS {
            return Err("the allow-list is full".into());
        }
        list.push(entry);
        list.sort();
        let tmp = format!("{path}.tmp");
        let text = serde_json::to_string_pretty(&json!({ "domains": list })).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, text + "\n").map_err(|e| format!("write allow-list: {e}"))?;
        std::fs::rename(&tmp, path).map_err(|e| format!("write allow-list: {e}"))?;
    }
    Ok(list)
}

/// Removes one entry from the allow-list (the human's decision, from the HUD or woodyctl).
pub fn remove_domain(path: &str, entry: &str) -> Result<Vec<String>, String> {
    let entry = entry.to_ascii_lowercase();
    let mut list = load_allowlist(path)?;
    let before = list.len();
    list.retain(|d| d != &entry);
    if list.len() == before {
        return Err(format!("{entry} is not on the list"));
    }
    let tmp = format!("{path}.tmp");
    let text = serde_json::to_string_pretty(&json!({ "domains": list })).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text + "\n").map_err(|e| format!("write allow-list: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("write allow-list: {e}"))?;
    Ok(list)
}

pub struct Response {
    pub status: u16,
    pub content_type: String,
    pub location: Option<String>,
    pub body: Vec<u8>,
}

/// Splits what `curl --dump-header -` prints: the header block, then the body.
pub fn split_response(raw: &[u8]) -> Result<Response, String> {
    let mut rest = raw;
    loop {
        let end = rest.windows(4).position(|w| w == b"\r\n\r\n").ok_or("the server's reply had no headers")?;
        let head = String::from_utf8_lossy(&rest[..end]).into_owned();
        let body = &rest[end + 4..];
        let mut lines = head.split("\r\n");
        let status: u16 = lines
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|s| s.parse().ok())
            .ok_or("the server's reply had no status")?;
        // An interim reply (100 Continue, 103 Early Hints) is followed by the real one.
        if (100..200).contains(&status) && body.starts_with(b"HTTP/") {
            rest = body;
            continue;
        }
        let mut content_type = String::new();
        let mut location = None;
        for line in lines {
            if let Some((k, v)) = line.split_once(':') {
                match k.trim().to_ascii_lowercase().as_str() {
                    "content-type" => content_type = v.trim().to_ascii_lowercase(),
                    "location" => location = Some(v.trim().to_string()),
                    _ => {}
                }
            }
        }
        return Ok(Response { status, content_type, location, body: body.to_vec() });
    }
}

fn is_text(content_type: &str) -> bool {
    let t = content_type.split(';').next().unwrap_or("").trim();
    t.starts_with("text/")
        || matches!(t, "application/json" | "application/xml" | "application/xhtml+xml" | "application/rss+xml" | "application/atom+xml" | "application/feed+json")
}

pub fn allowlist(cfg: &Config) -> Result<Value, String> {
    let w = settings(cfg)?;
    Ok(json!({ "domains": load_allowlist(&w.allow_path)? }))
}

/// Checks a fetch request without making it (used to classify and to run).
pub fn check_url(cfg: &Config, url: &str) -> Result<(String, String), String> {
    let w = settings(cfg)?;
    let (host, url) = parse_url(url)?;
    let list = load_allowlist(&w.allow_path)?;
    if !host_allowed(&host, &list) {
        return Err(format!(
            "{host} is not on the web allow-list. Ask the operator with web_allow_request if this site is worth adding."
        ));
    }
    Ok((host, url))
}

pub fn fetch(cfg: &Config, url: &str) -> Result<Value, String> {
    let w = settings(cfg)?;
    let (host, url) = check_url(cfg, url)?;

    // Resolve here, refuse anything that is not a public address, and pin the
    // connection to the address that was checked.
    let deny = scope::parse_deny(&cfg.permanent_deny)?;
    let addrs = scope::system_resolve(&host).map_err(|e| format!("could not resolve {host}: {e}"))?;
    if addrs.is_empty() {
        return Err(format!("could not resolve {host}"));
    }
    if let Some(bad) = addrs.iter().find(|ip| !is_public(**ip) || deny.iter().any(|n| n.contains(*ip))) {
        return Err(format!("{host} resolves to {bad}, which is not a public address; refused"));
    }
    let ip = addrs.iter().find(|ip| ip.is_ipv4()).unwrap_or(&addrs[0]);
    let pin = match ip {
        IpAddr::V4(v4) => format!("{host}:443:{v4}"),
        IpAddr::V6(v6) => format!("{host}:443:[{v6}]"),
    };

    let user = User::from_name(&w.user)
        .map_err(|e| format!("lookup user {}: {e}", w.user))?
        .ok_or_else(|| format!("user {} does not exist", w.user))?;
    let out = Command::new(&w.timeout)
        .args(["30", &w.setpriv, "--reuid", &w.user, "--regid", &user.gid.as_raw().to_string(), "--init-groups"])
        .args([
            w.curl.as_str(), "-q", "--silent", "--show-error", "--proto", "=https", "--tlsv1.2", "--noproxy", "*",
            "--max-redirs", "0", "--max-time", "20", "--max-filesize", &MAX_BODY_BYTES.to_string(),
            "--resolve", &pin, "--user-agent", "WoodPecker-OS/0.1 (read-only fetch)",
            "--header", "Accept: text/html,application/xhtml+xml,application/json,application/xml;q=0.9,text/plain;q=0.8",
            "--dump-header", "-", "--output", "-", "--", &url,
        ])
        .env_clear()
        .env("LC_ALL", "C")
        .env("HOME", "/")
        .env("SSL_CERT_FILE", &w.ca_bundle)
        .output()
        .map_err(|e| format!("spawn curl: {e}"))?;
    match out.status.code() {
        Some(0) => {}
        Some(124) | Some(28) => return Err("the request timed out".into()),
        Some(63) => return Err("the page is too large".into()),
        code => {
            let err = String::from_utf8_lossy(&out.stderr);
            let err: String = err.trim().chars().take(300).collect();
            return Err(format!("the request failed (curl {}): {err}", code.unwrap_or(-1)));
        }
    }
    let r = split_response(&out.stdout)?;
    if (300..400).contains(&r.status) {
        // A relative target is on the same host; spell it out so it can be fetched.
        let target = r.location.map(|l| if l.starts_with('/') && !l.starts_with("//") { format!("https://{host}{l}") } else { l });
        return Ok(json!({
            "url": url, "status": r.status, "redirect": target, "untrusted": true,
            "note": "Redirects are not followed. Fetch the target yourself if it is on the allow-list.",
        }));
    }
    if !r.body.is_empty() && !is_text(&r.content_type) {
        return Err(format!("not a text page (content type: {})", if r.content_type.is_empty() { "unknown" } else { &r.content_type }));
    }
    let text = String::from_utf8_lossy(&r.body);
    let truncated = text.chars().count() > MAX_RETURN_CHARS;
    let body: String = text.chars().take(MAX_RETURN_CHARS).collect();
    Ok(json!({
        "url": url, "status": r.status, "content_type": r.content_type,
        "bytes": r.body.len(), "truncated": truncated, "untrusted": true, "body": body,
    }))
}

pub fn allow_remove(cfg: &Config, entry: &str) -> Result<Value, String> {
    let w = settings(cfg)?;
    Ok(json!({ "removed": entry.to_ascii_lowercase(), "domains": remove_domain(&w.allow_path, entry)? }))
}

pub fn allow_add(cfg: &Config, entry: &str) -> Result<Value, String> {
    let w = settings(cfg)?;
    Ok(json!({ "added": entry.to_ascii_lowercase(), "domains": add_domain(&w.allow_path, entry)? }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_https_urls_to_named_hosts() {
        for ok in [
            "https://nixos.org", "https://nixos.org/", "https://NixOS.org/blog/?page=2", "https://api.github.com:443/repos/x/y",
            "https://search.nixos.org?query=a%20b", "https://nixos.org/manual#section",
        ] {
            assert!(parse_url(ok).is_ok(), "{ok}");
        }
        assert_eq!(parse_url("https://NixOS.org/blog/?p=2#frag").unwrap(), ("nixos.org".into(), "https://nixos.org/blog/?p=2".into()));
        assert_eq!(parse_url("https://nixos.org?x=1").unwrap().1, "https://nixos.org/?x=1");
        for bad in [
            "http://nixos.org/", "ftp://nixos.org/", "file:///etc/shadow", "nixos.org", "https://", "https:///x",
            "https://user:pw@nixos.org/", "https://nixos.org@evil.example/", "https://nixos.org:8443/", "https://nixos.org:80/",
            "https://127.0.0.1/", "https://192.168.222.1/", "https://[::1]/", "https://2130706433/", "https://localhost/",
            "https://nixos.org/a b", "https://nixos.org/\n", "https://nixos.org/\"x", "https://-x.org/", "https://x..org/",
            "https://169.254.169.254/latest/meta-data", "https://0x7f.0.0.1/", "https://nixos.org\\@evil.example/",
        ] {
            assert!(parse_url(bad).is_err(), "{bad}");
        }
        assert!(parse_url(&format!("https://nixos.org/{}", "a".repeat(2000))).is_err());
    }

    #[test]
    fn allow_list_matches_exactly_or_by_subdomain() {
        let list = vec!["nixos.org".to_string(), "*.github.com".to_string()];
        assert!(host_allowed("nixos.org", &list));
        assert!(!host_allowed("search.nixos.org", &list)); // not a wildcard entry
        assert!(!host_allowed("evilnixos.org", &list));
        assert!(!host_allowed("nixos.org.evil.example", &list));
        assert!(host_allowed("api.github.com", &list));
        assert!(host_allowed("a.b.github.com", &list));
        assert!(!host_allowed("github.com", &list)); // the wildcard does not cover the apex
        assert!(!host_allowed("evilgithub.com", &list));
        assert!(!host_allowed("github.com.evil.example", &list));
        assert!(!host_allowed("nixos.org", &[]));
        for ok in ["example.org", "*.example.org", "a-b.example.co.uk"] {
            assert!(valid_entry(ok), "{ok}");
        }
        for bad in ["", "*", "*.", "org", "*.org.", "10.0.0.1", "*.*.example.org", "exa mple.org", "example.org/path", "https://example.org", "EXAMPLE.org"] {
            assert!(!valid_entry(bad), "{bad}");
        }
    }

    #[test]
    fn only_public_addresses_are_reachable() {
        for bad in [
            "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.222.1", "192.168.130.2", "169.254.169.254",
            "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1",
            "ff02::1", "::ffff:127.0.0.1", "::ffff:192.168.1.1", "64:ff9b::7f00:1",
        ] {
            assert!(!is_public(bad.parse().unwrap()), "{bad}");
        }
        for ok in ["1.1.1.1", "140.82.121.4", "172.32.0.1", "2606:4700::1111", "::ffff:1.1.1.1"] {
            assert!(is_public(ok.parse().unwrap()), "{ok}");
        }
    }

    #[test]
    fn replies_are_split_into_headers_and_body() {
        let r = split_response(b"HTTP/2 200 \r\ncontent-type: text/html; charset=utf-8\r\nx: y\r\n\r\n<html>hi\r\n\r\nthere</html>").unwrap();
        assert_eq!((r.status, r.content_type.as_str()), (200, "text/html; charset=utf-8"));
        assert_eq!(r.body, b"<html>hi\r\n\r\nthere</html>");
        let r = split_response(b"HTTP/1.1 301 Moved\r\nLocation: https://evil.example/x\r\n\r\n").unwrap();
        assert_eq!((r.status, r.location.as_deref()), (301, Some("https://evil.example/x")));
        let r = split_response(b"HTTP/1.1 103 Early Hints\r\nLink: x\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{}").unwrap();
        assert_eq!((r.status, r.body.as_slice()), (200, b"{}".as_slice()));
        assert!(split_response(b"garbage").is_err());
        assert!(is_text("text/html; charset=utf-8") && is_text("application/json") && is_text("application/atom+xml"));
        assert!(!is_text("application/octet-stream") && !is_text("image/png") && !is_text("application/zip") && !is_text(""));
    }

    #[test]
    fn the_allow_list_file_round_trips() {
        let path = std::env::temp_dir().join(format!("woody-web-{}.json", std::process::id()));
        let path = path.display().to_string();
        let _ = std::fs::remove_file(&path);
        assert_eq!(load_allowlist(&path).unwrap(), Vec::<String>::new()); // no file: nothing is allowed
        assert!(add_domain(&path, "not a host").is_err());
        assert_eq!(add_domain(&path, "NixOS.org").unwrap(), vec!["nixos.org"]);
        assert_eq!(add_domain(&path, "*.github.com").unwrap(), vec!["*.github.com", "nixos.org"]);
        assert_eq!(add_domain(&path, "nixos.org").unwrap().len(), 2); // no duplicates
        assert_eq!(remove_domain(&path, "NixOS.org").unwrap(), vec!["*.github.com"]);
        assert!(remove_domain(&path, "nixos.org").is_err()); // already gone
        std::fs::write(&path, r#"{"domains": ["ok.example.org", "10.0.0.1", 7, "bad host"]}"#).unwrap();
        assert_eq!(load_allowlist(&path).unwrap(), vec!["ok.example.org"]); // invalid entries are ignored
        let _ = std::fs::remove_file(&path);
    }
}
