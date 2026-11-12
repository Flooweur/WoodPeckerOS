# LOCKED CORE. Changes to this directory are never applied by the agent on its
# own: they require human approval (see locked_paths below and docs/SELFMOD.md).
#
# woody-execd: the only root component the agent can talk to.
#   /run/woody/exec.sock     action requests   (group woody, agent uid only)
#   /run/woody/approve.sock  human approvals   (group woody-hud, HUD gateway uid or root)
#   /var/log/woody/audit.jsonl                 hash-chained, append-only
{ config, lib, pkgs, settings, self, ... }:
let
  selfmodJob = import ./selfmod-job.nix { inherit pkgs config settings; };

  woody-execd = pkgs.rustPlatform.buildRustPackage {
    pname = "woody-execd";
    version = "0.1.0";
    src = ../../executor;
    cargoLock.lockFile = ../../executor/Cargo.lock;
    # Some tests write a small script and run it. Run in parallel, one test can
    # start a program while another still has its script open, and the build
    # then fails now and then with "Text file busy". One at a time, it cannot.
    dontUseCargoParallelTests = true;
    meta.mainProgram = "woody-execd";
  };

  auditPath = "/var/log/woody/audit.jsonl";

  configFile = pkgs.writeText "woody-execd.json" (builtins.toJSON {
    agent_user = "woody";
    hud_user = "woody-hud";
    exec_socket = "/run/woody/exec.sock";
    approve_socket = "/run/woody/approve.sock";
    audit_path = auditPath;
    # Addresses a web fetch may never reach, whatever a name resolves to.
    permanent_deny = settings.permanentDeny;
    systemctl = "${config.systemd.package}/bin/systemctl";
    journalctl = "${config.systemd.package}/bin/journalctl";
    # Units the agent may never start, stop or restart, approval or not.
    forbidden_units = [
      "woody-execd.service"
      "nftables.service"
      "firewall.service"
      "sshd.service"
      "systemd-journald.service"
      "woody-hud.service"
    ];
    # Approval requests wait a week for the human: Woody works unattended, so
    # a request must still be there when they come back.
    approval_ttl_ms = 7 * 24 * 3600 * 1000;

    # osquery: read-only SQL over host state. Only these tables exist for a
    # query; password hashes (shadow), process environments (process_envs),
    # the curl table, file contents and shell history are deliberately absent.
    osqueryi = "${pkgs.osquery}/bin/osqueryi";
    timeout_bin = "${pkgs.coreutils}/bin/timeout";
    osquery_tables = [
      "os_version" "system_info" "uptime" "time" "osquery_info"
      "kernel_info" "kernel_modules" "cpu_info" "cpu_time" "memory_info" "load_average"
      "mounts" "block_devices" "usb_devices" "pci_devices"
      "interface_addresses" "interface_details" "routes" "arp_cache" "dns_resolvers" "etc_hosts"
      "listening_ports" "process_open_sockets" "processes"
      "users" "groups" "logged_in_users" "last" "systemd_units"
    ];

    # Read-only web access (Phase 9): Woody may fetch https pages from any
    # public site except those in the block-list file. The file is
    # root-owned and only you edit it, from the HUD or with woodyctl. It
    # does not exist until you block a first site.
    web = {
      block_path = "/var/lib/woody-execd/web-block.json";
      user = "woody-web";
      curl = "${lib.getBin pkgs.curl}/bin/curl";
      setpriv = "${pkgs.util-linux}/bin/setpriv";
      timeout = "${pkgs.coreutils}/bin/timeout";
      ca_bundle = "/etc/ssl/certs/ca-certificates.crt";
      # Pictures from the web (Phase 9c) are decoded and written out again by
      # libvips, run as woody-web under limits on memory, time and output.
      vipsthumbnail = "${pkgs.vips}/bin/vipsthumbnail";
      prlimit = "${pkgs.util-linux}/bin/prlimit";
    };

    # Screenshots of the kiosk display, taken as the kiosk user.
    screen = {
      user = "kiosk";
      grim = "${pkgs.grim}/bin/grim";
      setpriv = "${pkgs.util-linux}/bin/setpriv";
      timeout = "${pkgs.coreutils}/bin/timeout";
      # Written by the HUD gateway while the operator's terminal is open.
      block_file = "/run/woody-hud/terminal-open";
    };

    # Self-modification (see docs/SELFMOD.md). Woody may propose changes to
    # this repository. A change to any path below, or one that alters the
    # privilege fingerprint (./fingerprint.nix), waits for human approval.
    selfmod = {
      # A fixed path, not the store path: the store path differs for every
      # candidate and would make the executor unit look changed each time.
      source = "/etc/woodpecker/source";
      state_dir = "/var/lib/woody-execd/selfmod";
      nix = "${config.nix.package}/bin/nix";
      diff = "${pkgs.diffutils}/bin/diff";
      timeout = "${pkgs.coreutils}/bin/timeout";
      systemd_run = "${config.systemd.package}/bin/systemd-run";
      script = "${selfmodJob}/bin/woody-selfmod";
      locked_paths = [
        "nix/locked/"
        "executor/"
        "hud/"
        "flake.nix"
        "flake.lock"
        "nix/hosts/"
        "nix/modules/base.nix"
        # How the agent is started and confined.
        "nix/modules/agent.nix"
        # The agent program, all of it: the loop, the rules, the gates and
        # the tools. Since the review of 2026-11-12 it changes only with
        # approval. What Woody changes by itself is data (its methods, its
        # identity, its face, the things on the canvas) and, later, programs
        # in its workbench, which run under another user (docs/REVIEW.md).
        "agent/"
        "nix/modules/snapshots.nix"
        # The kiosk browser's own network policy (the firewall rule behind it
        # is in nix/locked/hud.nix).
        "nix/modules/kiosk.nix"
        # Which model file the machine downloads and runs for recall by meaning.
        "nix/modules/embed.nix"
      ];
    };
  });

  prepareAudit = pkgs.writeShellScript "woody-execd-prepare" ''
    set -eu
    # Until Phase 9 there was an allow-list here. It is no longer read.
    rm -f /var/lib/woody-execd/web-allow.json
    if [ ! -e ${auditPath} ]; then
      install -m 0640 /dev/null ${auditPath}
    fi
    # Append-only at the filesystem level: even root must clear this flag
    # before the file can be truncated or rewritten.
    ${pkgs.e2fsprogs}/bin/chattr +a ${auditPath} \
      || echo "warning: could not set the append-only flag on ${auditPath}" >&2
  '';
in
{
  # The agent's identity. It gets no sudo, no wheel, no login shell.
  users.groups.woody = { };
  users.users.woody = {
    isSystemUser = true;
    group = "woody";
    home = "/var/lib/woody";
    createHome = true;
    description = "Woody agent (unprivileged reasoning process)";
  };

  # The identity web requests are made under: no home, no groups, no rights.
  users.groups.woody-web = { };
  users.users.woody-web = {
    isSystemUser = true;
    group = "woody-web";
    description = "Woody's read-only web fetches";
  };

  # The second barrier around web fetches. The executor already refuses any
  # address that is not public before it starts curl. This rule holds even if
  # that check were wrong: whatever runs as woody-web can reach public
  # addresses on port 443 and nothing else. Not this machine, not a private
  # network, not the Windows host, no other port, not even DNS (the executor
  # resolves the name itself and hands curl the address).
  networking.nftables.tables.woody_web = {
    family = "inet";
    content = ''
      chain refuse {
        limit rate 6/minute log prefix "woody-web-drop: "
        counter drop
      }
      chain output {
        type filter hook output priority filter; policy accept;
        meta skuid != "woody-web" accept
        oifname "lo" jump refuse
        ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.168.0.0/16, 198.18.0.0/15, 224.0.0.0/4, 240.0.0.0/4 } jump refuse
        ip6 daddr { ::/127, 64:ff9b::/96, fc00::/7, fe80::/10, ff00::/8 } jump refuse
        tcp dport 443 accept
        jump refuse
      }
    '';
  };

  # The HUD gateway's identity: the only non-root uid allowed to approve.
  users.groups.woody-hud = { };
  users.users.woody-hud = {
    isSystemUser = true;
    group = "woody-hud";
    description = "HUD gateway (carries human approvals)";
  };

  systemd.services.woody-execd = {
    description = "WoodPecker privileged executor";
    wantedBy = [ "multi-user.target" ];
    after = [ "network.target" ];
    path = [ pkgs.coreutils ];
    serviceConfig = {
      ExecStartPre = "${prepareAudit}";
      ExecStart = "${woody-execd}/bin/woody-execd serve --config ${configFile}";
      Restart = "always";
      RestartSec = 2;

      RuntimeDirectory = "woody";
      RuntimeDirectoryMode = "0755";
      StateDirectory = "woody-execd woody-execd/selfmod";
      StateDirectoryMode = "0755";
      LogsDirectory = "woody";
      LogsDirectoryMode = "0750";

      # It runs as root by design, but needs nothing from these.
      NoNewPrivileges = true;
      # Read-only: the repository check reads the admin's checkout.
      ProtectHome = "read-only";
      PrivateTmp = true;
      ProtectKernelModules = true;
      ProtectKernelTunables = true;
      LockPersonality = true;
      RestrictSUIDSGID = true;
    };
  };

  # The configuration this system was built from, where Woody can read it.
  environment.etc."woodpecker/source".source = self.outPath;

  # `woodyctl` for the human administrator.
  environment.systemPackages = [ woody-execd ];
}
