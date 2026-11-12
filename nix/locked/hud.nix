# LOCKED CORE. The HUD gateway carries the human's approve/deny decisions to
# the executor, so its integrity matters as much as the executor's.
#
#   http://127.0.0.1:7800        the HUD, loopback only
#   /run/woody-hud/boot.html     bootstrap page holding the access token;
#                                readable only by the kiosk group
#   /var/lib/woody-hud/token     the token itself (gateway user only)
#   https://<vm>:7843            the same HUD for the operator's own browser:
#                                only from the Windows host's address, behind
#                                a password (sudo -u woody-hud woody-hud set-password)
#   /run/woody-term/term.sock    the operator's terminal (a login prompt),
#                                relayed to the kiosk only
#
# Why a token on a loopback port: any local process can connect to
# 127.0.0.1, including the agent. Without the token it gets nothing, and the
# token is only handed to the kiosk session through a file the agent's user
# cannot read.
{ config, lib, pkgs, settings, ... }:
let
  woody-hud = pkgs.callPackage ../../hud/package.nix { };

  # A self-signed certificate for the host door, made once. The browser will
  # warn the first time; compare the fingerprint (docs/HUD.md) and accept it.
  prepareTls = pkgs.writeShellScript "woody-hud-tls" ''
    set -eu
    dir=/var/lib/woody-hud/tls
    if [ ! -s "$dir/cert.pem" ] || [ ! -s "$dir/key.pem" ]; then
      ${pkgs.coreutils}/bin/mkdir -p "$dir"
      ${pkgs.coreutils}/bin/chmod 700 "$dir"
      ${lib.getBin pkgs.openssl}/bin/openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
        -nodes -days 3650 -subj "/CN=woodpecker" -addext "subjectAltName=DNS:woodpecker" \
        -keyout "$dir/key.pem" -out "$dir/cert.pem"
      ${pkgs.coreutils}/bin/chmod 600 "$dir/key.pem"
    fi
  '';

  # The operator's terminal: ttyd showing a login prompt for the admin user,
  # on a Unix socket that only the HUD gateway's group can open. It is not a
  # network service, and the agent's user cannot reach it.
  terminal = pkgs.writeShellScript "woody-term" ''
    exec ${lib.getBin pkgs.ttyd}/bin/ttyd \
      --interface /run/woody-term/term.sock \
      --socket-owner root:woody-hud \
      --base-path /term \
      --writable \
      --max-clients 2 \
      --client-option fontSize=14 \
      --client-option 'fontFamily=JetBrains Mono, monospace' \
      --client-option disableLeaveAlert=true \
      --client-option 'theme={"background":"#050403","foreground":"#f2d9a0","cursor":"#ffb000","selectionBackground":"#6b4a05"}' \
      ${lib.getBin pkgs.shadow}/bin/login ${settings.adminUser}
  '';

  waitForBootstrap = pkgs.writeShellScript "woody-hud-wait" ''
    for _ in $(${pkgs.coreutils}/bin/seq 75); do
      [ -e /run/woody-hud/boot.html ] && exit 0
      ${pkgs.coreutils}/bin/sleep 0.2
    done
    echo "woody-hud did not write its bootstrap page" >&2
    exit 1
  '';
in
{
  # Shared by the gateway (which writes the bootstrap page) and the kiosk
  # session (which reads it). The agent's user is not a member.
  users.groups.woody-kiosk = { };
  users.users.kiosk.extraGroups = [ "woody-kiosk" ];

  systemd.services.woody-hud = {
    description = "WoodPecker HUD gateway";
    wantedBy = [ "multi-user.target" ];
    after = [ "woody-execd.service" "woody-agent.socket" ];
    wants = [ "woody-execd.service" "woody-agent.socket" ];
    before = [ "greetd.service" ];
    environment = {
      WOODY_HUD_PORT = "7800";
      WOODY_HUD_BIND = "127.0.0.1";
      WOODY_AGENT_SOCKET = "/run/woody-agent/agent.sock";
      WOODY_APPROVE_SOCKET = "/run/woody/approve.sock";
      WOODY_HUD_STATE_DIR = "/var/lib/woody-hud";
      WOODY_HUD_RUNTIME_DIR = "/run/woody-hud";
      WOODY_HUD_HOST_PORT = toString settings.hudHostPort;
      WOODY_HUD_TLS_DIR = "/var/lib/woody-hud/tls";
      WOODY_TERM_SOCKET = "/run/woody-term/term.sock";
      WOODY_JOURNALCTL = "${config.systemd.package}/bin/journalctl";
      HOME = "/var/lib/woody-hud";
    };
    serviceConfig = {
      ExecStartPre = "${prepareTls}";
      ExecStart = "${woody-hud}/bin/woody-hud";
      # "Started" means the bootstrap page exists, so the kiosk can rely on it.
      ExecStartPost = "${waitForBootstrap}";
      User = "woody-hud";
      # Primary group is the kiosk group so the bootstrap page is created
      # group-readable for the kiosk; woody-hud grants the two sockets.
      Group = "woody-kiosk";
      # woody-hud: the agent's and the executor's sockets, and the terminal's.
      # systemd-journal: the log view reads the journal.
      SupplementaryGroups = [ "woody-hud" "systemd-journal" ];
      UMask = "0027";
      RuntimeDirectory = "woody-hud";
      RuntimeDirectoryMode = "0750";
      StateDirectory = "woody-hud";
      StateDirectoryMode = "0700";
      Restart = "always";
      RestartSec = 2;

      NoNewPrivileges = true;
      ProtectSystem = "strict";
      ProtectHome = true;
      PrivateTmp = true;
      PrivateDevices = true;
      ProtectKernelTunables = true;
      ProtectKernelModules = true;
      ProtectControlGroups = true;
      RestrictSUIDSGID = true;
      LockPersonality = true;
      CapabilityBoundingSet = "";
      RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" ];
    };
  };

  systemd.services.woody-term = {
    description = "Operator terminal for the HUD kiosk (a login prompt on a local socket)";
    wantedBy = [ "multi-user.target" ];
    before = [ "woody-hud.service" ];
    serviceConfig = {
      ExecStart = "${terminal}";
      RuntimeDirectory = "woody-term";
      RuntimeDirectoryMode = "0755";
      # The socket is created 0770 root:woody-hud.
      UMask = "0007";
      Restart = "always";
      RestartSec = 2;
    };
  };

  # The host door: HTTPS, from the Windows host's own address only. The lab's
  # target machines share that network and must not reach the HUD.
  networking.firewall.extraInputRules = ''
    ip saddr ${settings.hostAddress} tcp dport ${toString settings.hudHostPort} accept
  '';

  # For `sudo -u woody-hud woody-hud set-password`.
  environment.systemPackages = [ woody-hud ];

  # The kiosk should come up after the HUD is being served.
  systemd.services.greetd = {
    after = [ "woody-hud.service" ];
    wants = [ "woody-hud.service" ];
  };
}
