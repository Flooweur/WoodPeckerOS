//! Read-only web access for Woody: any public site, except those on a block
//! list the human controls (Phase 9; until then it was an allow-list).
//!
//! * Only `https://` URLs on port 443, to hosts that are not on the block list.
//! * The host is resolved here, every address must be a public one (never
//!   loopback, private, link-local or the permanent deny list), and the
//!   connection is pinned to the address that was checked.
//! * A redirect is followed here, a few hops at most, and every hop passes
//!   the same checks as the first address.
//! * Requests are paced: a pause between two requests to one host, and a
//!   ceiling per hour.
//! * The request is made by `curl` running as a user with no privileges,
//!   which the firewall confines to public addresses on port 443.
//! * Only the human edits the block list.
//!
//! What comes back is untrusted. The agent never shows the page to the
//! working model directly (see agent/src/web.ts).

use crate::config::{Config, Web};
use crate::net;
use ipnet::IpNet;
use nix::unistd::User;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::net::IpAddr;
use std::os::unix::fs::MetadataExt;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const MAX_URL: usize = 2000;
const MAX_BODY_BYTES: usize = 3_000_000;
const MAX_RETURN_CHARS: usize = 600_000;
const MAX_DOMAINS: usize = 300;
/// A page may send the reader on to another address this many times.
const MAX_REDIRECTS: usize = 3;
/// Woody reads like one person's browser, not like a crawler.
const HOST_GAP: Duration = Duration::from_millis(1000);
const MAX_PER_HOUR: usize = 120;
const HOUR: Duration = Duration::from_secs(3600);

/// When each host was last asked, and the requests of the last hour.
struct Pace {
    last: HashMap<String, Instant>,
    recent: VecDeque<Instant>,
}

static PACE: Mutex<Option<Pace>> = Mutex::new(None);

/// What a request must do before it goes out: wait this long, or not go at all.
pub fn pace_decision(last_to_host: Option<Duration>, in_last_hour: usize) -> Result<Duration, String> {
    if in_last_hour >= MAX_PER_HOUR {
        return Err(format!("the ceiling of {MAX_PER_HOUR} page requests an hour is reached; read on later"));
    }
    Ok(match last_to_host {
        Some(ago) if ago < HOST_GAP => HOST_GAP - ago,
        _ => Duration::ZERO,
    })
}

/// Counts this request against the hourly ceiling and waits out the pause owed to its host.
fn pace(host: &str) -> Result<(), String> {
    let wait = {
        let mut guard = PACE.lock().map_err(|_| "the pacing record is damaged".to_string())?;
        let p = guard.get_or_insert_with(|| Pace { last: HashMap::new(), recent: VecDeque::new() });
        let now = Instant::now();
        while p.recent.front().is_some_and(|t| now.duration_since(*t) >= HOUR) {
            p.recent.pop_front();
        }
        p.last.retain(|_, t| now.duration_since(*t) < HOUR);
        let wait = pace_decision(p.last.get(host).map(|t| now.duration_since(*t)), p.recent.len())?;
        p.recent.push_back(now);
        p.last.insert(host.to_string(), now + wait);
        wait
    };
    if !wait.is_zero() {
        std::thread::sleep(wait);
    }
    Ok(())
}

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

/// A block-list entry: `example.org` (the site and everything under it), or
/// `*.example.org` for its subdomains only.
pub fn valid_entry(entry: &str) -> bool {
    valid_host(entry.strip_prefix("*.").unwrap_or(entry))
}

/// Blocking a name blocks what is under it too: that is what blocking a site means.
pub fn host_blocked(host: &str, list: &[String]) -> bool {
    let under = |base: &str| host.len() > base.len() + 1 && host.ends_with(base) && host.as_bytes()[host.len() - base.len() - 1] == b'.';
    list.iter().any(|e| match e.strip_prefix("*.") {
        Some(base) => under(base),
        None => host == e || under(e),
    })
}

/// Where a redirect points, as a full URL. `location` may be absolute,
/// start at the host's root, or be relative to the page that sent it.
pub fn resolve_location(base: &str, location: &str) -> Result<String, String> {
    let location = location.trim();
    if location.is_empty() {
        return Err("the redirect names no address".into());
    }
    if location.starts_with("https://") {
        return Ok(location.to_string());
    }
    if let Some(rest) = location.strip_prefix("//") {
        return Ok(format!("https://{rest}"));
    }
    if location.contains("://") {
        return Err("the redirect leaves https".into());
    }
    let (host, _) = parse_url(base)?;
    if location.starts_with('/') {
        return Ok(format!("https://{host}{location}"));
    }
    if location.starts_with('?') {
        let page = base.split(['?', '#']).next().unwrap_or(base);
        return Ok(format!("{page}{location}"));
    }
    // Relative to the directory of the page that redirected.
    let page = base.split(['?', '#']).next().unwrap_or(base);
    let dir = &page[..page.rfind('/').map(|i| i + 1).unwrap_or(page.len())];
    let dir = if dir.len() <= "https://".len() { format!("{page}/") } else { dir.to_string() };
    Ok(format!("{dir}{location}"))
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

/// The block-list file is only honoured if it is root's and nobody else can write it.
/// No file means nothing is blocked.
pub fn load_blocklist(path: &str) -> Result<Vec<String>, String> {
    let meta = match std::fs::metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(format!("web block list: {e}")),
        Ok(m) => m,
    };
    #[cfg(not(test))]
    if meta.uid() != 0 || meta.mode() & 0o022 != 0 {
        return Err("the web block list must be owned by root and not group/world writable".into());
    }
    let _ = &meta;
    let text = std::fs::read_to_string(path).map_err(|e| format!("web block list: {e}"))?;
    let v: Value = serde_json::from_str(&text).map_err(|e| format!("web block list: {e}"))?;
    Ok(v.get("domains")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_ascii_lowercase).filter(|d| valid_entry(d)).collect())
        .unwrap_or_default())
}

/// Adds one entry to the block list (the human's decision, from the HUD or woodyctl).
pub fn add_domain(path: &str, entry: &str) -> Result<Vec<String>, String> {
    let entry = entry.to_ascii_lowercase();
    if !valid_entry(&entry) {
        return Err("not a valid host name".into());
    }
    let mut list = load_blocklist(path)?;
    if !list.contains(&entry) {
        if list.len() >= MAX_DOMAINS {
            return Err("the block list is full".into());
        }
        list.push(entry);
        list.sort();
        let tmp = format!("{path}.tmp");
        let text = serde_json::to_string_pretty(&json!({ "domains": list })).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, text + "\n").map_err(|e| format!("write block list: {e}"))?;
        std::fs::rename(&tmp, path).map_err(|e| format!("write block list: {e}"))?;
    }
    Ok(list)
}

/// Removes one entry from the block list (the human's decision, from the HUD or woodyctl).
pub fn remove_domain(path: &str, entry: &str) -> Result<Vec<String>, String> {
    let entry = entry.to_ascii_lowercase();
    let mut list = load_blocklist(path)?;
    let before = list.len();
    list.retain(|d| d != &entry);
    if list.len() == before {
        return Err(format!("{entry} is not on the list"));
    }
    let tmp = format!("{path}.tmp");
    let text = serde_json::to_string_pretty(&json!({ "domains": list })).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text + "\n").map_err(|e| format!("write block list: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("write block list: {e}"))?;
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

pub fn blocklist(cfg: &Config) -> Result<Value, String> {
    let w = settings(cfg)?;
    Ok(json!({ "domains": load_blocklist(&w.block_path)? }))
}

/// Checks a fetch request without making it (used to classify and to run).
pub fn check_url(cfg: &Config, url: &str) -> Result<(String, String), String> {
    let w = settings(cfg)?;
    let (host, url) = parse_url(url)?;
    let list = load_blocklist(&w.block_path)?;
    if host_blocked(&host, &list) {
        return Err(format!("{host} is on the operator's block list; it is not read"));
    }
    Ok((host, url))
}

/// One request to one address that has passed every check. Nothing is followed here.
fn request(cfg: &Config, w: &Web, host: &str, url: &str, accept: &str, max_bytes: usize) -> Result<Response, String> {
    // Resolve here, refuse anything that is not a public address, and pin the
    // connection to the address that was checked.
    let deny = net::parse_deny(&cfg.permanent_deny)?;
    let addrs = net::system_resolve(host).map_err(|e| format!("could not resolve {host}: {e}"))?;
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
    pace(host)?;

    let user = User::from_name(&w.user)
        .map_err(|e| format!("lookup user {}: {e}", w.user))?
        .ok_or_else(|| format!("user {} does not exist", w.user))?;
    let out = Command::new(&w.timeout)
        .args(["30", &w.setpriv, "--reuid", &w.user, "--regid", &user.gid.as_raw().to_string(), "--init-groups"])
        .args([
            w.curl.as_str(), "-q", "--silent", "--show-error", "--proto", "=https", "--tlsv1.2", "--noproxy", "*",
            "--max-redirs", "0", "--max-time", "20", "--max-filesize", &max_bytes.to_string(),
            "--resolve", &pin, "--user-agent", "WoodPecker-OS/0.2 (a personal assistant reading for one person)",
            "--header", accept,
            "--dump-header", "-", "--output", "-", "--", url,
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
        Some(63) => return Err("what the server sent is too large".into()),
        code => {
            let err = String::from_utf8_lossy(&out.stderr);
            let err: String = err.trim().chars().take(300).collect();
            return Err(format!("the request failed (curl {}): {err}", code.unwrap_or(-1)));
        }
    }
    split_response(&out.stdout)
}

/// Follows a request to its end: the address finally read, the addresses
/// passed through on the way, and the reply. Every hop passes the same checks.
fn follow(cfg: &Config, url: &str, accept: &str, max_bytes: usize) -> Result<(String, Vec<String>, Response), String> {
    let w = settings(cfg)?;
    let (mut host, mut url) = check_url(cfg, url)?;
    let mut redirects: Vec<String> = Vec::new();
    loop {
        let r = request(cfg, w, &host, &url, accept, max_bytes)?;
        if !(300..400).contains(&r.status) {
            return Ok((url, redirects, r));
        }
        if redirects.len() >= MAX_REDIRECTS {
            return Err(format!("{url} redirects again after {MAX_REDIRECTS} redirects; given up"));
        }
        let location = r.location.ok_or_else(|| format!("{url} redirects without saying where"))?;
        // The target passes the same checks as an address Woody asked for:
        // https, a named host, not on the block list, and (in `request`) a public address.
        let target = resolve_location(&url, &location).and_then(|t| check_url(cfg, &t));
        let (next_host, next_url) = target.map_err(|e| format!("{url} redirects to an address that is refused: {e}"))?;
        redirects.push(url);
        host = next_host;
        url = next_url;
    }
}

pub fn fetch(cfg: &Config, url: &str) -> Result<Value, String> {
    let (url, redirects, r) = follow(
        cfg,
        url,
        "Accept: text/html,application/xhtml+xml,application/json,application/xml;q=0.9,text/plain;q=0.8",
        MAX_BODY_BYTES,
    )?;
    if !r.body.is_empty() && !is_text(&r.content_type) {
        return Err(format!("not a text page (content type: {})", if r.content_type.is_empty() { "unknown" } else { &r.content_type }));
    }
    let text = String::from_utf8_lossy(&r.body);
    let truncated = text.chars().count() > MAX_RETURN_CHARS;
    let body: String = text.chars().take(MAX_RETURN_CHARS).collect();
    Ok(json!({
        "url": url, "status": r.status, "content_type": r.content_type, "redirected_from": redirects,
        "bytes": r.body.len(), "truncated": truncated, "untrusted": true, "body": body,
    }))
}

// ---- pictures (Phase 9c) -------------------------------------------------
//
// A picture from the web is never shown as it came. It is fetched like a
// page, checked to be one of four plain picture formats, then decoded and
// written out again as WebP by a converter that runs as the user with no
// rights, with limits on its memory, time and output. What is kept is the
// new file: pixels only, no metadata, at most 1280 pixels a side.

const MAX_PICTURE_BYTES: usize = 8_000_000;
const MAX_PICTURE_OUT: usize = 1_500_000;
const PICTURE_SIDE: u32 = 1280;

/// The picture format, from what the server says and what the file starts
/// with. Both must agree. SVG is not accepted: it is a program, not pixels.
pub fn picture_kind(content_type: &str, body: &[u8]) -> Result<&'static str, String> {
    let said = content_type.split(';').next().unwrap_or("").trim();
    let is = if body.starts_with(&[0xff, 0xd8, 0xff]) {
        "jpeg"
    } else if body.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        "png"
    } else if body.starts_with(b"GIF87a") || body.starts_with(b"GIF89a") {
        "gif"
    } else if body.len() >= 12 && &body[0..4] == b"RIFF" && &body[8..12] == b"WEBP" {
        "webp"
    } else {
        return Err(format!("not a picture this system accepts (JPEG, PNG, GIF or WebP); the server called it {}", if said.is_empty() { "nothing" } else { said }));
    };
    let expected = match is {
        "jpeg" => matches!(said, "image/jpeg" | "image/jpg" | "image/pjpeg"),
        other => said == format!("image/{other}"),
    };
    if !expected {
        return Err(format!("the server called this {}, but the file is a {is} picture; refused", if said.is_empty() { "nothing" } else { said }));
    }
    Ok(is)
}

/// The width and height of a WebP file, read from its header.
pub fn webp_size(b: &[u8]) -> Option<(u32, u32)> {
    if b.len() < 30 || &b[0..4] != b"RIFF" || &b[8..12] != b"WEBP" {
        return None;
    }
    let u24 = |s: &[u8]| u32::from(s[0]) | u32::from(s[1]) << 8 | u32::from(s[2]) << 16;
    match &b[12..16] {
        b"VP8X" => Some((1 + u24(&b[24..27]), 1 + u24(&b[27..30]))),
        b"VP8 " if b[23..26] == [0x9d, 0x01, 0x2a] => Some((
            u32::from(u16::from_le_bytes([b[26], b[27]]) & 0x3fff),
            u32::from(u16::from_le_bytes([b[28], b[29]]) & 0x3fff),
        )),
        b"VP8L" if b[20] == 0x2f => {
            let bits = u32::from_le_bytes([b[21], b[22], b[23], b[24]]);
            Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
        }
        _ => None,
    }
}

/// Decodes the picture and writes it out again, as the user with no rights.
fn reencode(w: &Web, body: &[u8], kind: &str) -> Result<Vec<u8>, String> {
    let vips = w.vipsthumbnail.as_deref().ok_or("pictures are not configured on this system")?;
    let prlimit = w.prlimit.as_deref().ok_or("pictures are not configured on this system")?;
    let user = User::from_name(&w.user)
        .map_err(|e| format!("lookup user {}: {e}", w.user))?
        .ok_or_else(|| format!("user {} does not exist", w.user))?;
    let (uid, gid) = (user.uid.as_raw(), user.gid.as_raw());
    // A directory of its own, which only the converting user can enter.
    let dir = std::env::temp_dir().join(format!("woody-picture-{}-{}", std::process::id(), crate::util::now_ms()));
    std::fs::create_dir(&dir).map_err(|e| format!("picture work directory: {e}"))?;
    let result = (|| {
        let input = dir.join(format!("in.{kind}"));
        let output = dir.join("out.webp");
        std::fs::write(&input, body).map_err(|e| format!("write the picture: {e}"))?;
        for p in [&dir, &input] {
            std::os::unix::fs::chown(p, Some(uid), Some(gid)).map_err(|e| format!("hand the picture to {}: {e}", w.user))?;
        }
        let out = Command::new(&w.timeout)
            .args(["20", &w.setpriv, "--reuid", &w.user, "--regid", &gid.to_string(), "--init-groups"])
            .args([prlimit, "--as=3000000000", "--cpu=15", "--fsize=40000000", "--core=0", "--"])
            .arg(vips)
            .arg(&input)
            .args(["--size", &format!("{PICTURE_SIDE}x{PICTURE_SIDE}>"), "-o"])
            .arg(format!("{}[Q=80,strip]", output.display()))
            .current_dir(&dir)
            .env_clear()
            .env("LC_ALL", "C")
            .env("HOME", "/")
            .env("VIPS_CONCURRENCY", "1")
            .output()
            .map_err(|e| format!("start the picture converter: {e}"))?;
        match out.status.code() {
            Some(0) => {}
            Some(124) => return Err("the picture took too long to convert".into()),
            code => {
                let err = String::from_utf8_lossy(&out.stderr);
                let err: String = err.trim().chars().take(200).collect();
                return Err(format!("the picture could not be decoded (converter {}): {err}", code.unwrap_or(-1)));
            }
        }
        let size = std::fs::metadata(&output).map_err(|_| "the converter produced no picture".to_string())?.len();
        if size == 0 || size as usize > MAX_PICTURE_OUT {
            return Err(format!("the converted picture is {size} bytes; the most kept is {MAX_PICTURE_OUT}"));
        }
        std::fs::read(&output).map_err(|e| format!("read the converted picture: {e}"))
    })();
    let _ = std::fs::remove_dir_all(&dir);
    result
}

/// Fetches one picture and returns it re-encoded. What comes back is untrusted: it is shown, never obeyed.
pub fn picture(cfg: &Config, url: &str) -> Result<Value, String> {
    let w = settings(cfg)?;
    let (url, redirects, r) = follow(cfg, url, "Accept: image/webp,image/png,image/jpeg,image/gif;q=0.9", MAX_PICTURE_BYTES)?;
    if r.status != 200 {
        return Err(format!("the server answered {} for this picture", r.status));
    }
    let kind = picture_kind(&r.content_type, &r.body)?;
    let out = reencode(w, &r.body, kind)?;
    let (width, height) = webp_size(&out).ok_or("the converted picture is not a readable WebP file")?;
    let id = format!("p-{}", &crate::util::sha256_hex(&out)[..16]);
    Ok(json!({
        "id": id, "url": url, "redirected_from": redirects, "original_type": kind, "original_bytes": r.body.len(),
        "mime": "image/webp", "bytes": out.len(), "width": width, "height": height, "untrusted": true,
        "base64": crate::util::base64(&out),
    }))
}

pub fn block_remove(cfg: &Config, entry: &str) -> Result<Value, String> {
    let w = settings(cfg)?;
    Ok(json!({ "removed": entry.to_ascii_lowercase(), "domains": remove_domain(&w.block_path, entry)? }))
}

pub fn block_add(cfg: &Config, entry: &str) -> Result<Value, String> {
    let w = settings(cfg)?;
    Ok(json!({ "added": entry.to_ascii_lowercase(), "domains": add_domain(&w.block_path, entry)? }))
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
    fn a_blocked_name_covers_what_is_under_it() {
        let list = vec!["example.org".to_string(), "*.tracker.net".to_string()];
        assert!(host_blocked("example.org", &list));
        assert!(host_blocked("www.example.org", &list)); // blocking a site blocks its subdomains
        assert!(host_blocked("a.b.example.org", &list));
        assert!(!host_blocked("evilexample.org", &list));
        assert!(!host_blocked("example.org.elsewhere.net", &list));
        assert!(host_blocked("ads.tracker.net", &list));
        assert!(!host_blocked("tracker.net", &list)); // the wildcard form leaves the apex readable
        assert!(!host_blocked("nixos.org", &list));
        assert!(!host_blocked("nixos.org", &[])); // an empty list blocks nothing
        for ok in ["example.org", "*.example.org", "a-b.example.co.uk"] {
            assert!(valid_entry(ok), "{ok}");
        }
        for bad in ["", "*", "*.", "org", "*.org.", "10.0.0.1", "*.*.example.org", "exa mple.org", "example.org/path", "https://example.org", "EXAMPLE.org"] {
            assert!(!valid_entry(bad), "{bad}");
        }
    }

    #[test]
    fn a_redirect_is_resolved_to_a_full_address() {
        let base = "https://example.org/docs/page.html?x=1";
        assert_eq!(resolve_location(base, "https://other.net/a").unwrap(), "https://other.net/a");
        assert_eq!(resolve_location(base, "//other.net/a").unwrap(), "https://other.net/a");
        assert_eq!(resolve_location(base, "/top").unwrap(), "https://example.org/top");
        assert_eq!(resolve_location(base, "next.html").unwrap(), "https://example.org/docs/next.html");
        assert_eq!(resolve_location(base, "?page=2").unwrap(), "https://example.org/docs/page.html?page=2");
        assert_eq!(resolve_location("https://example.org", "next").unwrap(), "https://example.org/next");
        // Leaving https is refused here; everything else is judged by parse_url afterwards.
        for bad in ["http://example.org/", "ftp://example.org/x", "file:///etc/shadow", "", "  "] {
            assert!(resolve_location(base, bad).is_err(), "{bad}");
        }
        // What a redirect may point to is checked like any other address.
        for refused in ["//127.0.0.1/", "//192.168.222.1/admin", "https://localhost/", "//user@evil.example/", "https://example.org:8443/"] {
            assert!(parse_url(&resolve_location(base, refused).unwrap()).is_err(), "{refused}");
        }
    }

    #[test]
    fn requests_are_paced() {
        // Nothing asked of this host lately: go at once.
        assert_eq!(pace_decision(None, 0), Ok(Duration::ZERO));
        assert_eq!(pace_decision(Some(Duration::from_secs(5)), 10), Ok(Duration::ZERO));
        // Asked 300 ms ago: wait out the rest of the second.
        assert_eq!(pace_decision(Some(Duration::from_millis(300)), 10), Ok(Duration::from_millis(700)));
        // The hour's ceiling: not at all.
        assert!(pace_decision(None, MAX_PER_HOUR).unwrap_err().contains("ceiling"));
        assert!(pace_decision(None, MAX_PER_HOUR - 1).is_ok());
    }

    #[test]
    fn a_picture_is_one_of_four_formats_and_the_server_must_agree() {
        let jpeg = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, b'J', b'F', b'I', b'F'];
        let png = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d];
        let webp = *b"RIFF\x24\x00\x00\x00WEBPVP8 ";
        assert_eq!(picture_kind("image/jpeg", &jpeg), Ok("jpeg"));
        assert_eq!(picture_kind("image/jpg; q=1", &jpeg), Ok("jpeg"));
        assert_eq!(picture_kind("image/png", &png), Ok("png"));
        assert_eq!(picture_kind("image/gif", b"GIF89a\x01\x00\x01\x00"), Ok("gif"));
        assert_eq!(picture_kind("image/webp", &webp), Ok("webp"));
        // The server's word and the file must agree.
        assert!(picture_kind("image/png", &jpeg).unwrap_err().contains("but the file is a jpeg"));
        assert!(picture_kind("text/html", &png).is_err());
        assert!(picture_kind("", &png).is_err());
        // Not pixels: a drawing that is a program, a page, an archive, nothing.
        for (said, body) in [
            ("image/svg+xml", b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script>x()</script></svg>".as_slice()),
            ("image/png", b"<html><body>not a picture</body></html>".as_slice()),
            ("image/jpeg", b"PK\x03\x04".as_slice()),
            ("image/png", b"".as_slice()),
        ] {
            assert!(picture_kind(said, body).unwrap_err().contains("not a picture this system accepts"), "{said}");
        }
    }

    #[test]
    fn the_size_of_a_webp_file_is_read_from_its_header() {
        // The extended form: a canvas of 1280 by 720.
        let mut x = b"RIFF\x00\x00\x00\x00WEBPVP8X\x0a\x00\x00\x00\x00\x00\x00\x00".to_vec();
        x.extend_from_slice(&[0xff, 0x04, 0x00, 0xcf, 0x02, 0x00]);
        assert_eq!(webp_size(&x), Some((1280, 720)));
        // The lossy form: 320 by 200.
        let mut l = b"RIFF\x00\x00\x00\x00WEBPVP8 \x00\x00\x00\x00".to_vec();
        l.extend_from_slice(&[0, 0, 0, 0x9d, 0x01, 0x2a, 0x40, 0x01, 0xc8, 0x00]);
        assert_eq!(webp_size(&l), Some((320, 200)));
        // The lossless form: 16 by 9.
        let mut ll = b"RIFF\x00\x00\x00\x00WEBPVP8L\x00\x00\x00\x00".to_vec();
        let bits: u32 = 15 | (8 << 14);
        ll.push(0x2f);
        ll.extend_from_slice(&bits.to_le_bytes());
        ll.extend_from_slice(&[0; 8]);
        assert_eq!(webp_size(&ll), Some((16, 9)));
        assert_eq!(webp_size(b"RIFF\x00\x00\x00\x00WAVEfmt \x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00"), None);
        assert_eq!(webp_size(b"short"), None);
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
    fn the_block_list_file_round_trips() {
        let path = std::env::temp_dir().join(format!("woody-web-{}.json", std::process::id()));
        let path = path.display().to_string();
        let _ = std::fs::remove_file(&path);
        assert_eq!(load_blocklist(&path).unwrap(), Vec::<String>::new()); // no file: nothing is blocked
        assert!(add_domain(&path, "not a host").is_err());
        assert_eq!(add_domain(&path, "NixOS.org").unwrap(), vec!["nixos.org"]);
        assert_eq!(add_domain(&path, "*.github.com").unwrap(), vec!["*.github.com", "nixos.org"]);
        assert_eq!(add_domain(&path, "nixos.org").unwrap().len(), 2); // no duplicates
        assert_eq!(remove_domain(&path, "NixOS.org").unwrap(), vec!["*.github.com"]);
        assert!(remove_domain(&path, "nixos.org").is_err()); // already gone
        std::fs::write(&path, r#"{"domains": ["ok.example.org", "10.0.0.1", 7, "bad host"]}"#).unwrap();
        assert_eq!(load_blocklist(&path).unwrap(), vec!["ok.example.org"]); // invalid entries are ignored
        let _ = std::fs::remove_file(&path);
    }
}
