# WoodPecker-OS — Phase 0 spike (throwaway).
#
# Answers two questions before we build anything real:
#   1. Does a Wayland kiosk (greetd -> cage -> Chromium) render smoothly
#      on VMware's virtual GPU (vmwgfx)?
#   2. Does the Claude Agent SDK run as a hardened systemd service on NixOS,
#      with a subscription token and with an API key?
#
# Usage: add this file to the `imports` list of /etc/nixos/configuration.nix
# (see README.md next to this file), then `sudo nixos-rebuild switch`.
{ config, lib, pkgs, ... }:

let
  testPage = "file://${./kiosk-test}/index.html";

  # Wrapper: software cursor (hardware cursor planes are a known trouble spot
  # for wlroots on vmwgfx) and all compositor/browser output to the journal
  # instead of the console. Read it with:  journalctl -t woody-kiosk -b
  kioskCommand = "${pkgs.writeShellScript "woody-kiosk" ''
    export WLR_NO_HARDWARE_CURSORS=1
    # Phase 0 finding: Chromium's GPU buffers (dmabuf) cannot be imported by
    # the compositor on vmwgfx and Chromium crashes. With the compositor in
    # software mode Chromium falls back to shared-memory buffers and works.
    export WLR_RENDERER=pixman
    exec ${pkgs.systemd}/bin/systemd-cat -t woody-kiosk ${kioskArgs}
  ''}";

  kioskArgs = lib.concatStringsSep " " ([
    "${pkgs.cage}/bin/cage" "-s" "--"
    "${pkgs.chromium}/bin/chromium"
    "--kiosk"
    "--ozone-platform=wayland"
    "--no-first-run"
    "--noerrdialogs"
    "--disable-infobars"
    "--disable-session-crashed-bubble"
    "--user-data-dir=/home/kiosk/.chromium-spike"
    # --kiosk alone left the tab and address bars visible here; app mode
    # opens the page in a chromeless window, which cage then fills the screen with.
    "--app=${testPage}"
  ]);

  agentSrc = ./agent-hello;
in
{
  ##### VMware guest + graphics ############################################
  virtualisation.vmware.guest.enable = true;
  hardware.graphics.enable = true;

  ##### Kiosk session ######################################################
  users.users.kiosk = {
    isNormalUser = true;
    description = "HUD kiosk session";
    extraGroups = [ "video" "input" ];
  };

  services.greetd = {
    enable = true;
    settings = {
      # Auto-login straight into the kiosk for the spike. The real greeter
      # comes in Phase 4.
      initial_session = { command = kioskCommand; user = "kiosk"; };
      default_session = { command = kioskCommand; user = "kiosk"; };
    };
  };

  fonts.packages = [ pkgs.jetbrains-mono ];

  ##### Escape hatches #####################################################
  # Ctrl+Alt+F2 gives a text console; SSH works from the Windows host.
  services.openssh.enable = true;

  environment.systemPackages = with pkgs; [
    git
    mesa-demos   # glxinfo / eglinfo to inspect the renderer
    nodejs_22
  ];

  ##### Agent SDK daemon spike #############################################
  # The SDK ships a prebuilt native binary; NixOS cannot run those without
  # nix-ld. Whether this is enough is one of the things the spike tests.
  programs.nix-ld.enable = true;

  users.users.woody = {
    isSystemUser = true;
    group = "woody";
    home = "/var/lib/woody-spike";
  };
  users.groups.woody = { };

  systemd.services.woody-spike-agent = {
    description = "WoodPecker Phase 0: Agent SDK hello as a hardened service";
    # Not started at boot. Run it by hand:  sudo systemctl start woody-spike-agent
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
    path = [ pkgs.nodejs_22 pkgs.bash pkgs.coreutils pkgs.git ];
    environment = {
      HOME = "/var/lib/woody-spike";
      NIX_LD_LIBRARY_PATH = lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ];
    };
    preStart = ''
      cp -f ${agentSrc}/package.json ${agentSrc}/hello.mjs /var/lib/woody-spike/
      chmod u+w /var/lib/woody-spike/package.json /var/lib/woody-spike/hello.mjs
      if [ ! -d /var/lib/woody-spike/node_modules ]; then
        npm install --no-audit --no-fund
      fi
    '';
    serviceConfig = {
      Type = "oneshot";
      User = "woody";
      Group = "woody";
      StateDirectory = "woody-spike";
      WorkingDirectory = "/var/lib/woody-spike";
      # Created by hand, root-only, holds exactly one credential line.
      EnvironmentFile = "/etc/woody-spike/agent.env";
      ExecStart = "${pkgs.nodejs_22}/bin/node hello.mjs";
      TimeoutStartSec = "5min";

      # The hardening we intend to use for the real agent. If the SDK
      # breaks under any of these, the spike should tell us which.
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
    };
  };
}
