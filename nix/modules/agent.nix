# woody-agent: the unprivileged reasoning process (Claude Agent SDK).
#
#   /run/woody-agent/agent.sock   chat protocol (WebSocket). Owned by systemd,
#                                 open to the HUD gateway user and root only.
#   /var/lib/woody                agent state: session id, chosen model, usage ledger
#   /var/lib/woody-secrets/agent.env   root-only file with the API key
#
# The users `woody` and `woody-hud` are defined in ../locked/executor.nix.
{ config, lib, pkgs, settings, ... }:
let
  woody-agent = pkgs.callPackage ../../agent/package.nix { };
in
{
  # The Agent SDK ships a prebuilt native binary; NixOS needs nix-ld to run it.
  programs.nix-ld.enable = true;

  systemd.sockets.woody-agent = {
    description = "Woody agent chat socket";
    wantedBy = [ "sockets.target" ];
    socketConfig = {
      ListenStream = "/run/woody-agent/agent.sock";
      SocketUser = "woody";
      SocketGroup = "woody-hud";
      SocketMode = "0660";
      DirectoryMode = "0755";
    };
  };

  systemd.services.woody-agent = {
    description = "Woody agent (Claude Agent SDK, no root)";
    wantedBy = [ "multi-user.target" ];
    requires = [ "woody-agent.socket" ];
    after = [ "woody-agent.socket" "woody-execd.service" "network-online.target" ];
    wants = [ "woody-execd.service" "network-online.target" ];
    path = [ pkgs.bash pkgs.coreutils pkgs.git ];
    environment = {
      HOME = "/var/lib/woody";
      WOODY_STATE_DIR = "/var/lib/woody";
      WOODY_EXEC_SOCKET = "/run/woody/exec.sock";
      WOODY_MONTHLY_CAP_USD = toString settings.monthlyCapUsd;
      WOODY_TURN_CAP_USD = toString settings.perTurnCapUsd;
      # Woody's own life (Phase 8b): its share of the cap and the hours of its day.
      WOODY_OWN_SHARE = toString settings.ownShare;
      WOODY_DAY_START = settings.dayStart;
      WOODY_NIGHT_START = settings.nightStart;
      NIX_LD_LIBRARY_PATH = lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ];
    };
    serviceConfig = {
      ExecStart = "${woody-agent}/bin/woody-agent";
      User = "woody";
      Group = "woody";
      StateDirectory = "woody";
      StateDirectoryMode = "0700";
      WorkingDirectory = "/var/lib/woody";
      # systemd reads this as root before dropping privileges. The leading
      # "-" lets the service start without it, so it can report the missing key.
      EnvironmentFile = "-/var/lib/woody-secrets/agent.env";
      Restart = "on-failure";
      RestartSec = 3;

      # No root, no way to get it, nothing writable outside its state directory.
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

  # `woody-chat` for the human, until the HUD exists.
  environment.systemPackages = [ woody-agent ];
}
