# Kiosk session: greetd -> cage -> Chromium showing one full-screen page.
#
# Settings come from the Phase 0 spike on VMware:
#  * WLR_RENDERER=pixman: Chromium's GPU buffers cannot be imported by the
#    compositor on VMware's vmwgfx driver, so the compositor runs in software.
#  * --app=URL instead of --kiosk: --kiosk left the browser bars visible.
#
# The session opens the bootstrap page written by the HUD gateway
# (nix/locked/hud.nix), which loads the HUD with its access token.
{ lib, pkgs, ... }:
let
  page = "file:///run/woody-hud/boot.html";

  session = pkgs.writeShellScript "woody-kiosk" ''
    export WLR_NO_HARDWARE_CURSORS=1
    export WLR_RENDERER=pixman
    exec ${pkgs.systemd}/bin/systemd-cat -t woody-kiosk \
      ${pkgs.cage}/bin/cage -s -- \
      ${pkgs.chromium}/bin/chromium \
        --ozone-platform=wayland \
        --no-first-run \
        --noerrdialogs \
        --disable-infobars \
        --disable-session-crashed-bubble \
        --user-data-dir=/home/kiosk/.chromium-kiosk \
        --app=${page}
  '';
in
{
  users.users.kiosk = {
    isNormalUser = true;
    description = "HUD kiosk session";
    extraGroups = [ "video" "input" ];
  };

  services.greetd = {
    enable = true;
    settings = {
      # Auto-login into the kiosk. A real greeter comes in Phase 5.
      initial_session = { command = "${session}"; user = "kiosk"; };
      default_session = { command = "${session}"; user = "kiosk"; };
    };
  };

  fonts.packages = [ pkgs.jetbrains-mono ];
}
