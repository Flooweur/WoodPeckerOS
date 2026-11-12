# LOCKED CORE. The kernel side of the target allow-list.
#
# Purpose: this system's security tools are for the owner's own lab only.
# The executor already refuses any target outside the engagement the human
# set. This file is the second, independent barrier: the kernel drops every
# packet the security-tools user sends to an address that is not in the
# engagement, so a wrapper bug or a tool following a redirect cannot reach
# a machine that was never authorized.
#
#  * Security tools run as the user `woody-tools` and nothing else does.
#  * That user may send packets only to the addresses in the sets
#    targets4 / targets6. The executor fills them from the engagement in
#    force and empties them when it ends or expires.
#  * With no engagement the sets are empty: the tools user reaches nothing,
#    not even this machine's own services.
#  * The permanent deny list (the Windows host, the VMware gateways) is
#    dropped first, whatever the sets contain.
{ lib, pkgs, settings, ... }:
let
  toolsUid = 9100;
  never4 = lib.filter (a: !(lib.hasInfix ":" a)) settings.permanentDeny;

  # Run by the administrator: shows that the barrier holds.
  isolationTest = pkgs.writeShellApplication {
    name = "woody-isolation-test";
    runtimeInputs = [ pkgs.coreutils pkgs.util-linux pkgs.nftables pkgs.gnugrep pkgs.bash ];
    text = ''
      # Usage: sudo woody-isolation-test [in-scope-address:port]
      # Tries, as the security-tools user, to open connections that must be
      # blocked. With an argument, also tries one that must be let through
      # (a lab target inside the engagement, with a port that is open).
      if [ "$(id -u)" != 0 ]; then echo "run with sudo"; exit 2; fi
      fails=0
      try() { # prints: blocked | reached
        local out
        out=$(setpriv --reuid ${toString toolsUid} --regid ${toString toolsUid} --clear-groups \
          timeout 4 bash -c "exec 3<>/dev/tcp/$1/$2" 2>&1) && { echo reached; return; }
        case "$out" in
          *"refused"*) echo reached ;;   # an answer came back: the packet left
          *) echo blocked ;;             # not permitted, or no answer
        esac
      }
      must_block() {
        local got; got=$(try "$1" "$2")
        if [ "$got" = blocked ]; then echo "ok    blocked  $1:$2  ($3)"
        else echo "FAIL  reached  $1:$2  ($3)"; fails=$((fails + 1)); fi
      }
      echo "== the security-tools user must not reach:"
      must_block ${settings.hostAddress} 445 "the Windows host"
      must_block ${settings.hostAddress} ${toString settings.hudHostPort} "the Windows host"
      ${lib.concatMapStringsSep "\n" (a: "must_block ${a} 53 \"permanent deny list\"") never4}
      must_block 1.1.1.1 443 "the internet"
      must_block 127.0.0.1 7800 "this machine's own HUD"
      must_block 127.0.0.1 22 "this machine's own SSH"

      if [ -n "''${1:-}" ]; then
        echo "== and must reach the lab target you named:"
        host=''${1%:*}; port=''${1##*:}
        got=$(try "$host" "$port")
        if [ "$got" = reached ]; then echo "ok    reached  $host:$port"
        else echo "FAIL  blocked  $host:$port  (is an engagement active, and is the port open?)"; fails=$((fails + 1)); fi
      fi

      echo "== addresses the kernel currently lets the tools user reach:"
      nft list set inet woody_scope targets4 | grep -E "elements|^\s+[0-9]" || echo "   (none)"
      echo
      if [ "$fails" = 0 ]; then echo "PASS"; else echo "$fails check(s) FAILED"; exit 1; fi
    '';
  };
in
{
  users.groups.woody-tools.gid = toolsUid;
  users.users.woody-tools = {
    isSystemUser = true;
    uid = toolsUid;
    group = "woody-tools";
    description = "Security tools (kernel-confined to the engagement's targets)";
  };

  networking.nftables.tables.woody_scope = {
    family = "inet";
    content = ''
      set targets4 { type ipv4_addr; flags interval; auto-merge; }
      set targets6 { type ipv6_addr; flags interval; auto-merge; }
      set never4 {
        type ipv4_addr; flags interval; auto-merge;
        elements = { ${lib.concatStringsSep ", " never4} }
      }
      chain output {
        type filter hook output priority filter; policy accept;
        meta skuid != ${toString toolsUid} accept
        ip daddr @never4 counter drop
        ip daddr @targets4 accept
        ip6 daddr @targets6 accept
        limit rate 6/minute log prefix "woody-scope-drop: "
        counter drop
      }
    '';
  };

  environment.systemPackages = [ isolationTest ];
}
