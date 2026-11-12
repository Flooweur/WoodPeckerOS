//! Address helpers for the web fetch: the list of addresses that may never
//! be reached, and name resolution.

use ipnet::IpNet;
use std::net::IpAddr;

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

/// Parses the configured deny list: addresses or networks.
pub fn parse_deny(list: &[String]) -> Result<Vec<IpNet>, String> {
    list.iter()
        .map(|s| {
            s.parse::<IpNet>()
                .map(|n| n.trunc())
                .or_else(|_| s.parse::<IpAddr>().map(|ip| IpNet::from(canon(ip))))
                .map_err(|_| format!("bad deny entry: {s}"))
        })
        .collect()
}

/// System resolver.
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

    #[test]
    fn deny_list_takes_addresses_and_networks() {
        let deny = parse_deny(&["192.168.222.1".into(), "192.168.130.77/24".into(), "::ffff:10.0.0.1".into()]).unwrap();
        let shown: Vec<String> = deny.iter().map(|n| n.to_string()).collect();
        assert_eq!(shown, vec!["192.168.222.1/32", "192.168.130.0/24", "10.0.0.1/32"]);
        assert!(deny[1].contains(&"192.168.130.2".parse::<IpAddr>().unwrap()));
        assert!(parse_deny(&["not an address".into()]).is_err());
    }
}
