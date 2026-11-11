# LOCKED CORE. The HUD gateway carries the human's approve/deny decisions to
# the executor, so its integrity matters as much as the executor's.
#
#   http://127.0.0.1:7800        the HUD, loopback only
#   /run/woody-hud/boot.html     bootstrap page holding the access token;
#                                readable only by the kiosk group
#   /var/lib/woody-hud/token     the token itself (gateway user only)
#
# Why a token on a loopback port: any local process can connect to
# 127.0.0.1, including the agent. Without the token it gets nothing, and the
# token is only handed to the kiosk session through a file the agent's user
# cannot read.
{ config, lib, pkgs, ... }:
let
  woody-hud = pkgs.callPackage ../../hud/package.nix { };

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
    };
    serviceConfig = {
      ExecStart = "${woody-hud}/bin/woody-hud";
      # "Started" means the bootstrap page exists, so the kiosk can rely on it.
      ExecStartPost = "${waitForBootstrap}";
      User = "woody-hud";
      # Primary group is the kiosk group so the bootstrap page is created
      # group-readable for the kiosk; woody-hud grants the two sockets.
      Group = "woody-kiosk";
      SupplementaryGroups = [ "woody-hud" ];
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

  # The kiosk should come up after the HUD is being served.
  systemd.services.greetd = {
    after = [ "woody-hud.service" ];
    wants = [ "woody-hud.service" ];
  };
}
