//! Scope engine: decides whether a target may be touched by a security tool.
//!
//! Rules, in order:
//!  1. No active, unexpired engagement -> everything is refused.
//!  2. Special ranges (loopback, link-local incl. cloud metadata, multicast,
//!     unspecified, reserved) are always refused.
//!  3. The permanent deny list (the Windows host, VMware gateways) is always
//!     refused and wins over any allow entry.
//!  4. An IP must be inside an allowed network.
//!  5. A network must sit entirely inside one allowed network; denied addresses
//!     inside it are returned as mandatory exclusions.
//!  6. A hostname is resolved once and the addresses pinned. It passes if every
//!     address is inside an allowed network, or if the name itself is allowed
//!     and no address is private (blocks DNS rebinding to internal hosts).

use ipnet::IpNet;
use serde::{Deserialize, Serialize};
use std::net::IpAddr;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Engagement {
    pub name: String,
    /// Who authorized this and on what basis. Required.
    pub authorization: String,
    pub expires_ms: u64,
    pub active: bool,
    /// IPs, CIDR networks, hostnames, or "*.suffix" wildcard hostnames.
    pub allow: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Decision {
    pub allowed: bool,
    /// Machine-readable reason code.
    pub reason: String,
    pub target: String,
    pub kind: String,
    /// Addresses or networks the tool must use (hostnames are pinned to these).
    pub addresses: Vec<String>,
    /// Addresses the tool must exclude when the target is a network.
    pub exclude: Vec<String>,
    pub engagement: Option<String>,
}

#[derive(Debug, Clone)]
enum NameRule {
    Exact(String),
    Suffix(String),
}

#[derive(Debug, Clone)]
pub struct Scope {
    name: String,
    active: bool,
    expires_ms: u64,
    nets: Vec<IpNet>,
    names: Vec<NameRule>,
    deny: Vec<IpNet>,
}

const SPECIAL: &[&str] = &[
    "0.0.0.0/8",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "224.0.0.0/4",
    "240.0.0.0/4",
    "::/128",
    "::1/128",
    "fe80::/10",
    "ff00::/8",
];

const PRIVATE: &[&str] = &[
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "100.64.0.0/10",
    "fc00::/7",
];

fn nets(list: &[&str]) -> Vec<IpNet> {
    list.iter().map(|s| s.parse().expect("static net")).collect()
}

/// IPv4-mapped IPv6 addresses are treated as their IPv4 form.
fn canon(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => IpAddr::V6(v6),
        },
        v4 => v4,
    }
}

fn host_net(ip: IpAddr) -> IpNet {
    IpNet::from(ip)
}

fn valid_hostname(name: &str) -> bool {
    if name.is_empty() || name.len() > 253 {
        return false;
    }
    name.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    })
}

pub fn parse_deny(list: &[String]) -> Result<Vec<IpNet>, String> {
    list.iter()
        .map(|s| {
            s.parse::<IpNet>()
                .map(|n| n.trunc())
                .or_else(|_| s.parse::<IpAddr>().map(|ip| host_net(canon(ip))))
                .map_err(|_| format!("bad deny entry: {s}"))
        })
        .collect()
}

/// The outer limit on what an engagement may allow (the lab networks). With a
/// limit set, every allow entry must be an address or network inside it;
/// hostnames are refused, because a name can point anywhere. An empty limit
/// means no outer limit.
pub fn within_limit(allow: &[String], limit: &[IpNet]) -> Result<(), String> {
    if limit.is_empty() {
        return Ok(());
    }
    for entry in allow {
        let entry = entry.trim();
        let net = entry
            .parse::<IpNet>()
            .map(|n| n.trunc())
            .or_else(|_| entry.parse::<IpAddr>().map(|ip| host_net(canon(ip))))
            .map_err(|_| format!("{entry}: only addresses and networks inside the lab are accepted"))?;
        if !limit.iter().any(|l| l.contains(&net)) {
            return Err(format!("{entry}: outside the lab networks this system is limited to"));
        }
    }
    Ok(())
}

#[derive(Debug, PartialEq)]
enum Target {
    Ip(IpAddr),
    Net(IpNet),
    Name(String),
}

/// Extracts the host part from a URL, host:port, [v6]:port, CIDR, IP or hostname.
fn parse_target(raw: &str) -> Result<Target, String> {
    let mut s = raw.trim();
    if s.is_empty() || s.len() > 2048 || s.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("malformed-target".into());
    }
    let mut was_url = false;
    if let Some(idx) = s.find("://") {
        was_url = true;
        s = &s[idx + 3..];
        let end = s.find(|c| c == '/' || c == '?' || c == '#').unwrap_or(s.len());
        s = &s[..end];
        if let Some(at) = s.rfind('@') {
            s = &s[at + 1..];
        }
    }
    if !was_url && s.contains('/') {
        return s
            .parse::<IpNet>()
            .map(|n| Target::Net(n.trunc()))
            .map_err(|_| "malformed-target".to_string());
    }
    // [v6] or [v6]:port
    if let Some(rest) = s.strip_prefix('[') {
        let close = rest.find(']').ok_or("malformed-target")?;
        let ip: IpAddr = rest[..close].parse().map_err(|_| "malformed-target")?;
        return Ok(Target::Ip(canon(ip)));
    }
    if let Ok(ip) = s.parse::<IpAddr>() {
        return Ok(Target::Ip(canon(ip)));
    }
    // host:port (a bare IPv6 literal has more than one colon and was handled above)
    if s.matches(':').count() == 1 {
        let (host, port) = s.split_once(':').unwrap();
        if port.is_empty() || !port.chars().all(|c| c.is_ascii_digit()) {
            return Err("malformed-target".into());
        }
        s = host;
        if let Ok(ip) = s.parse::<IpAddr>() {
            return Ok(Target::Ip(canon(ip)));
        }
    }
    let name = s.trim_end_matches('.').to_ascii_lowercase();
    if !valid_hostname(&name) {
        return Err("malformed-target".into());
    }
    // Things like "1.2.3" or "0x7f.1" are legal hostnames to some resolvers
    // and alternative IP spellings to others. Refuse all-numeric labels.
    if name.split('.').all(|l| l.chars().all(|c| c.is_ascii_digit() || c == 'x')) {
        return Err("malformed-target".into());
    }
    Ok(Target::Name(name))
}

impl Scope {
    /// Builds the scope. `engagement` is None when no engagement file exists.
    pub fn build(engagement: Option<&Engagement>, permanent_deny: &[IpNet]) -> Result<Scope, String> {
        let mut scope = Scope {
            name: String::new(),
            active: false,
            expires_ms: 0,
            nets: vec![],
            names: vec![],
            deny: permanent_deny.to_vec(),
        };
        let Some(e) = engagement else { return Ok(scope) };
        if e.name.trim().is_empty() {
            return Err("engagement has no name".into());
        }
        if e.authorization.trim().is_empty() {
            return Err("engagement has no authorization note".into());
        }
        scope.name = e.name.clone();
        scope.active = e.active;
        scope.expires_ms = e.expires_ms;
        for entry in &e.allow {
            let entry = entry.trim();
            if let Ok(net) = entry.parse::<IpNet>() {
                let net = net.trunc();
                let min_prefix = match net {
                    IpNet::V4(_) => 8,
                    IpNet::V6(_) => 32,
                };
                if net.prefix_len() < min_prefix {
                    return Err(format!("allow entry too broad: {entry}"));
                }
                scope.nets.push(net);
            } else if let Ok(ip) = entry.parse::<IpAddr>() {
                scope.nets.push(host_net(canon(ip)));
            } else if let Some(suffix) = entry.strip_prefix("*.") {
                let suffix = suffix.to_ascii_lowercase();
                if !valid_hostname(&suffix) || !suffix.contains('.') {
                    return Err(format!("bad wildcard allow entry: {entry}"));
                }
                scope.names.push(NameRule::Suffix(suffix));
            } else {
                let name = entry.trim_end_matches('.').to_ascii_lowercase();
                if !valid_hostname(&name) {
                    return Err(format!("bad allow entry: {entry}"));
                }
                scope.names.push(NameRule::Exact(name));
            }
        }
        Ok(scope)
    }

    /// The networks the kernel filter may let the tools user reach right now:
    /// the allowed networks of an active, unexpired engagement, else nothing.
    /// Allowed hostnames are not included; a tool reaches a named target only
    /// if its address is also inside an allowed network.
    pub fn kernel_nets(&self, now_ms: u64) -> Vec<IpNet> {
        if self.name.is_empty() || !self.active || now_ms >= self.expires_ms {
            return vec![];
        }
        let special = nets(SPECIAL);
        self.nets
            .iter()
            .filter(|n| !special.iter().any(|s| s.contains(*n)))
            .cloned()
            .collect()
    }

    fn special(&self, ip: IpAddr) -> bool {
        nets(SPECIAL).iter().any(|n| n.contains(&ip))
    }

    fn private(&self, ip: IpAddr) -> bool {
        nets(PRIVATE).iter().any(|n| n.contains(&ip))
    }

    fn denied(&self, ip: IpAddr) -> bool {
        self.deny.iter().any(|n| n.contains(&ip))
    }

    fn in_allow(&self, ip: IpAddr) -> bool {
        self.nets.iter().any(|n| n.contains(&ip))
    }

    fn name_allowed(&self, name: &str) -> bool {
        self.names.iter().any(|r| match r {
            NameRule::Exact(n) => n == name,
            NameRule::Suffix(s) => name.len() > s.len() + 1 && name.ends_with(s) && name[..name.len() - s.len()].ends_with('.'),
        })
    }

    fn ip_verdict(&self, ip: IpAddr) -> Result<(), &'static str> {
        if self.special(ip) {
            return Err("special-range");
        }
        if self.denied(ip) {
            return Err("permanent-deny");
        }
        Ok(())
    }

    /// `resolve` turns a hostname into addresses; injected so tests need no DNS.
    pub fn check(
        &self,
        raw: &str,
        now_ms: u64,
        resolve: &dyn Fn(&str) -> Result<Vec<IpAddr>, String>,
    ) -> Decision {
        let mut d = Decision {
            allowed: false,
            reason: String::new(),
            target: raw.to_string(),
            kind: "unknown".into(),
            addresses: vec![],
            exclude: vec![],
            engagement: if self.name.is_empty() { None } else { Some(self.name.clone()) },
        };
        let refuse = |mut d: Decision, reason: &str| {
            d.allowed = false;
            d.reason = reason.to_string();
            d.addresses.clear();
            d.exclude.clear();
            d
        };

        if self.name.is_empty() {
            return refuse(d, "no-engagement");
        }
        if !self.active {
            return refuse(d, "engagement-inactive");
        }
        if now_ms >= self.expires_ms {
            return refuse(d, "engagement-expired");
        }

        let target = match parse_target(raw) {
            Ok(t) => t,
            Err(reason) => return refuse(d, &reason),
        };

        match target {
            Target::Ip(ip) => {
                d.kind = "ip".into();
                if let Err(reason) = self.ip_verdict(ip) {
                    return refuse(d, reason);
                }
                if !self.in_allow(ip) {
                    return refuse(d, "not-in-scope");
                }
                d.addresses.push(ip.to_string());
            }
            Target::Net(net) => {
                d.kind = "network".into();
                let all_special = nets(SPECIAL);
                if all_special.iter().any(|s| s.contains(&net)) {
                    return refuse(d, "special-range");
                }
                if self.deny.iter().any(|n| n.contains(&net)) {
                    return refuse(d, "permanent-deny");
                }
                if !self.nets.iter().any(|n| n.contains(&net)) {
                    return refuse(d, "not-in-scope");
                }
                d.addresses.push(net.to_string());
                for n in self.deny.iter().chain(all_special.iter()) {
                    if net.contains(n) {
                        d.exclude.push(n.to_string());
                    }
                }
            }
            Target::Name(name) => {
                d.kind = "hostname".into();
                let ips = match resolve(&name) {
                    Ok(ips) if !ips.is_empty() => ips,
                    _ => return refuse(d, "unresolvable"),
                };
                let named = self.name_allowed(&name);
                for ip in ips {
                    let ip = canon(ip);
                    if let Err(reason) = self.ip_verdict(ip) {
                        return refuse(d, reason);
                    }
                    if !self.in_allow(ip) {
                        if !named {
                            return refuse(d, "not-in-scope");
                        }
                        if self.private(ip) {
                            return refuse(d, "name-resolves-to-private");
                        }
                    }
                    let s = ip.to_string();
                    if !d.addresses.contains(&s) {
                        d.addresses.push(s);
                    }
                }
            }
        }
        d.allowed = true;
        d.reason = "in-scope".into();
        d
    }
}

/// System resolver, used outside tests.
pub fn system_resolve(name: &str) -> Result<Vec<IpAddr>, String> {
    use std::net::ToSocketAddrs;
    (name, 0u16)
        .to_socket_addrs()
        .map(|it| it.map(|sa| sa.ip()).collect())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_000;

    fn engagement() -> Engagement {
        Engagement {
            name: "home-lab".into(),
            authorization: "own lab".into(),
            expires_ms: 2_000,
            active: true,
            allow: vec![
                "192.168.222.0/24".into(),
                "10.9.8.7".into(),
                "fd00:1::/64".into(),
                "shop.example.org".into(),
                "*.lab.example.org".into(),
            ],
        }
    }

    fn scope() -> Scope {
        let deny = parse_deny(&["192.168.222.1".into(), "192.168.222.254/32".into()]).unwrap();
        Scope::build(Some(&engagement()), &deny).unwrap()
    }

    fn no_dns(_: &str) -> Result<Vec<IpAddr>, String> {
        Err("no dns in tests".into())
    }

    fn dns(map: &'static [(&'static str, &'static [&'static str])]) -> impl Fn(&str) -> Result<Vec<IpAddr>, String> {
        move |name| {
            map.iter()
                .find(|(n, _)| *n == name)
                .map(|(_, ips)| ips.iter().map(|s| s.parse().unwrap()).collect())
                .ok_or_else(|| "nxdomain".to_string())
        }
    }

    fn check(target: &str) -> Decision {
        scope().check(target, NOW, &no_dns)
    }

    #[test]
    fn ip_in_scope() {
        let d = check("192.168.222.130");
        assert!(d.allowed);
        assert_eq!(d.addresses, vec!["192.168.222.130"]);
        assert!(check("10.9.8.7").allowed);
    }

    #[test]
    fn ip_out_of_scope() {
        for t in ["192.168.223.1", "10.9.8.8", "8.8.8.8", "192.168.130.2", "192.168.1.1"] {
            let d = check(t);
            assert!(!d.allowed, "{t}");
            assert_eq!(d.reason, "not-in-scope", "{t}");
        }
    }

    #[test]
    fn permanent_deny_beats_allow() {
        assert_eq!(check("192.168.222.1").reason, "permanent-deny");
        assert_eq!(check("192.168.222.254").reason, "permanent-deny");
        assert_eq!(check("192.168.222.1/32").reason, "permanent-deny");
    }

    #[test]
    fn special_ranges_always_refused() {
        for t in ["127.0.0.1", "0.0.0.0", "169.254.169.254", "224.0.0.1", "255.255.255.255", "::1", "fe80::1", "ff02::1"] {
            assert_eq!(check(t).reason, "special-range", "{t}");
        }
    }

    #[test]
    fn special_refused_even_if_allow_listed() {
        let mut e = engagement();
        e.allow.push("127.0.0.0/8".into());
        e.allow.push("169.254.169.254".into());
        let s = Scope::build(Some(&e), &[]).unwrap();
        assert_eq!(s.check("127.0.0.1", NOW, &no_dns).reason, "special-range");
        assert_eq!(s.check("169.254.169.254", NOW, &no_dns).reason, "special-range");
    }

    #[test]
    fn ipv4_mapped_ipv6_is_normalised() {
        assert!(check("::ffff:192.168.222.130").allowed);
        assert_eq!(check("::ffff:192.168.222.1").reason, "permanent-deny");
        assert_eq!(check("::ffff:127.0.0.1").reason, "special-range");
        assert_eq!(check("[::ffff:8.8.8.8]:443").reason, "not-in-scope");
    }

    #[test]
    fn ipv6_scope() {
        assert!(check("fd00:1::5").allowed);
        assert!(check("[fd00:1::5]:8080").allowed);
        assert_eq!(check("fd00:2::5").reason, "not-in-scope");
    }

    #[test]
    fn network_inside_scope_gets_exclusions() {
        let d = check("192.168.222.0/24");
        assert!(d.allowed);
        assert_eq!(d.kind, "network");
        assert_eq!(d.addresses, vec!["192.168.222.0/24"]);
        assert_eq!(d.exclude, vec!["192.168.222.1/32", "192.168.222.254/32"]);
    }

    #[test]
    fn network_host_bits_are_truncated() {
        let d = check("192.168.222.77/25");
        assert!(d.allowed);
        assert_eq!(d.addresses, vec!["192.168.222.0/25"]);
        assert_eq!(d.exclude, vec!["192.168.222.1/32"]);
    }

    #[test]
    fn network_wider_than_scope_refused() {
        for t in ["192.168.0.0/16", "192.168.222.0/23", "0.0.0.0/0", "10.9.8.0/24", "::/0"] {
            assert!(!check(t).allowed, "{t}");
        }
        assert_eq!(check("127.0.0.0/8").reason, "special-range");
    }

    #[test]
    fn urls_and_ports_use_the_host() {
        assert!(check("http://192.168.222.130:3000/login?x=1").allowed);
        assert!(check("192.168.222.130:8080").allowed);
        assert!(check("https://user:pw@192.168.222.130/").allowed);
        assert_eq!(check("http://8.8.8.8/").reason, "not-in-scope");
        // The host is what follows the last '@', not what precedes it.
        assert_eq!(check("http://192.168.222.130@8.8.8.8/").reason, "not-in-scope");
        assert_eq!(check("http://192.168.222.130#@8.8.8.8/").allowed, true);
    }

    #[test]
    fn malformed_targets_refused() {
        for t in ["", " ", "a b", "192.168.222.130 ; rm -rf /", "host:port", "-oG", "a..b", "exa$mple.org", "1.2.3", "0x7f.1", "2130706433", "192.168.222.130/33", "[::1"] {
            let d = scope().check(t, NOW, &dns(&[]));
            assert!(!d.allowed, "{t:?}");
        }
    }

    #[test]
    fn hostname_resolving_into_scope() {
        let r = dns(&[("dvwa.local", &["192.168.222.131"])]);
        let d = scope().check("http://DVWA.local./", NOW, &r);
        assert!(d.allowed);
        assert_eq!(d.kind, "hostname");
        assert_eq!(d.addresses, vec!["192.168.222.131"]);
    }

    #[test]
    fn hostname_not_allowed_and_outside_scope() {
        let r = dns(&[("example.com", &["93.184.216.34"])]);
        assert_eq!(scope().check("example.com", NOW, &r).reason, "not-in-scope");
    }

    #[test]
    fn allowed_name_with_public_address() {
        let r = dns(&[("shop.example.org", &["93.184.216.34"]), ("a.lab.example.org", &["93.184.216.35"])]);
        assert!(scope().check("shop.example.org", NOW, &r).allowed);
        assert!(scope().check("a.lab.example.org", NOW, &r).allowed);
    }

    #[test]
    fn wildcard_does_not_match_lookalikes() {
        let r = dns(&[
            ("lab.example.org", &["93.184.216.34"]),
            ("evillab.example.org", &["93.184.216.34"]),
            ("lab.example.org.evil.com", &["93.184.216.34"]),
            ("xshop.example.org", &["93.184.216.34"]),
        ]);
        for t in ["lab.example.org", "evillab.example.org", "lab.example.org.evil.com", "xshop.example.org"] {
            assert!(!scope().check(t, NOW, &r).allowed, "{t}");
        }
    }

    #[test]
    fn rebinding_is_blocked() {
        let r = dns(&[
            ("shop.example.org", &["93.184.216.34", "192.168.1.10"]),
            ("a.lab.example.org", &["127.0.0.1"]),
            ("b.lab.example.org", &["192.168.222.1"]),
            ("c.lab.example.org", &["169.254.169.254"]),
            ("d.lab.example.org", &["::ffff:10.0.0.1"]),
        ]);
        assert_eq!(scope().check("shop.example.org", NOW, &r).reason, "name-resolves-to-private");
        assert_eq!(scope().check("a.lab.example.org", NOW, &r).reason, "special-range");
        assert_eq!(scope().check("b.lab.example.org", NOW, &r).reason, "permanent-deny");
        assert_eq!(scope().check("c.lab.example.org", NOW, &r).reason, "special-range");
        assert_eq!(scope().check("d.lab.example.org", NOW, &r).reason, "name-resolves-to-private");
    }

    #[test]
    fn refused_decisions_carry_no_addresses() {
        let r = dns(&[("shop.example.org", &["93.184.216.34", "192.168.1.10"])]);
        let d = scope().check("shop.example.org", NOW, &r);
        assert!(d.addresses.is_empty() && d.exclude.is_empty());
    }

    #[test]
    fn unresolvable_refused() {
        assert_eq!(scope().check("nope.lab.example.org", NOW, &dns(&[])).reason, "unresolvable");
    }

    #[test]
    fn engagement_state() {
        let none = Scope::build(None, &[]).unwrap();
        assert_eq!(none.check("192.168.222.130", NOW, &no_dns).reason, "no-engagement");

        let mut e = engagement();
        e.active = false;
        let s = Scope::build(Some(&e), &[]).unwrap();
        assert_eq!(s.check("192.168.222.130", NOW, &no_dns).reason, "engagement-inactive");

        assert_eq!(scope().check("192.168.222.130", 2_000, &no_dns).reason, "engagement-expired");
        assert_eq!(scope().check("192.168.222.130", 5_000, &no_dns).reason, "engagement-expired");
    }

    #[test]
    fn lab_limit_bounds_what_an_engagement_may_allow() {
        let limit = parse_deny(&["192.168.222.0/24".into()]).unwrap();
        assert!(within_limit(&["192.168.222.0/24".into(), "192.168.222.131".into(), "192.168.222.128/25".into()], &limit).is_ok());
        for bad in ["192.168.0.0/16", "192.168.223.5", "8.8.8.8", "shop.example.org", "*.lab.example.org", "fd00:1::/64", "nonsense/99"] {
            assert!(within_limit(&[bad.into()], &limit).is_err(), "{bad}");
        }
        // No limit configured: anything the scope engine accepts may be listed.
        assert!(within_limit(&["shop.example.org".into()], &[]).is_ok());
    }

    #[test]
    fn kernel_set_follows_the_engagement_state() {
        let nets: Vec<String> = scope().kernel_nets(NOW).iter().map(|n| n.to_string()).collect();
        assert_eq!(nets, vec!["192.168.222.0/24", "10.9.8.7/32", "fd00:1::/64"]);
        assert!(scope().kernel_nets(2_000).is_empty(), "expired");
        let mut e = engagement();
        e.active = false;
        assert!(Scope::build(Some(&e), &[]).unwrap().kernel_nets(NOW).is_empty(), "inactive");
        assert!(Scope::build(None, &[]).unwrap().kernel_nets(NOW).is_empty(), "none");
        let mut e = engagement();
        e.allow = vec!["127.0.0.0/8".into(), "192.168.222.9".into()];
        let nets: Vec<String> = Scope::build(Some(&e), &[]).unwrap().kernel_nets(NOW).iter().map(|n| n.to_string()).collect();
        assert_eq!(nets, vec!["192.168.222.9/32"], "special ranges never reach the kernel set");
    }

    #[test]
    fn bad_engagements_rejected() {
        let mut e = engagement();
        e.authorization = "  ".into();
        assert!(Scope::build(Some(&e), &[]).is_err());

        for bad in ["0.0.0.0/0", "10.0.0.0/7", "::/0", "*.org", "*.", "bad host"] {
            let mut e = engagement();
            e.allow = vec![bad.into()];
            assert!(Scope::build(Some(&e), &[]).is_err(), "{bad}");
        }
    }
}
