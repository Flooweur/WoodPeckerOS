# LOCKED CORE. Changes to this directory are never applied by the agent on its
# own: they require human approval (enforced from Phase 3 on, when the agent
# gains the ability to rebuild the system).
#
# woody-execd: the only root component the agent can talk to.
#   /run/woody/exec.sock     action requests   (group woody, agent uid only)
#   /run/woody/approve.sock  human approvals   (group woody-hud, HUD gateway uid or root)
#   /var/log/woody/audit.jsonl                 hash-chained, append-only
#   /var/lib/woody-execd/engagement.json       the scope in force (root-owned, written by a human)
{ config, lib, pkgs, settings, self, ... }:
let
  selfmodJob = import ./selfmod-job.nix { inherit pkgs config settings; };

  woody-execd = pkgs.rustPlatform.buildRustPackage {
    pname = "woody-execd";
    version = "0.1.0";
    src = ../../executor;
    cargoLock.lockFile = ../../executor/Cargo.lock;
    meta.mainProgram = "woody-execd";
  };

  auditPath = "/var/log/woody/audit.jsonl";

  configFile = pkgs.writeText "woody-execd.json" (builtins.toJSON {
    agent_user = "woody";
    hud_user = "woody-hud";
    exec_socket = "/run/woody/exec.sock";
    approve_socket = "/run/woody/approve.sock";
    audit_path = auditPath;
    engagement_path = "/var/lib/woody-execd/engagement.json";
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

    # Read-only web access. Woody can only fetch https pages from hosts in
    # the allow-list file, which is root-owned and seeded from the list
    # below on first start. Woody can ask to add a host; a human approves.
    web = {
      allow_path = "/var/lib/woody-execd/web-allow.json";
      user = "woody-web";
      curl = "${pkgs.curl}/bin/curl";
      setpriv = "${pkgs.util-linux}/bin/setpriv";
      timeout = "${pkgs.coreutils}/bin/timeout";
      ca_bundle = "/etc/ssl/certs/ca-certificates.crt";
    };

    # Screenshots of the kiosk display, taken as the kiosk user.
    screen = {
      user = "kiosk";
      grim = "${pkgs.grim}/bin/grim";
      setpriv = "${pkgs.util-linux}/bin/setpriv";
      timeout = "${pkgs.coreutils}/bin/timeout";
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
        "nix/modules/secrets.nix"
        "nix/modules/snapshots.nix"
        "lab/"
      ];
    };
  });

  # The hosts Woody may read from, until the human edits the list.
  defaultWebAllow = pkgs.writeText "web-allow.json" (builtins.toJSON {
    domains = [
      "nixos.org" "*.nixos.org"
      "github.com" "api.github.com" "raw.githubusercontent.com"
      "docs.anthropic.com" "www.anthropic.com" "docs.claude.com" "platform.claude.com" "code.claude.com"
      "nvd.nist.gov" "www.cisa.gov" "cve.mitre.org" "www.cve.org"
      "www.kernel.org" "lwn.net"
    ];
  });

  prepareAudit = pkgs.writeShellScript "woody-execd-prepare" ''
    set -eu
    if [ ! -e /var/lib/woody-execd/web-allow.json ]; then
      install -m 0644 ${defaultWebAllow} /var/lib/woody-execd/web-allow.json
    fi
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
