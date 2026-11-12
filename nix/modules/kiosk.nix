# Kiosk session: greetd -> cage -> Chromium showing one full-screen page.
#
# Settings come from the Phase 0 spike on VMware:
#  * WLR_RENDERER=pixman: Chromium's GPU buffers cannot be imported by the
#    compositor on VMware's vmwgfx driver, so the compositor runs in software.
#  * --app=URL instead of --kiosk: --kiosk left the browser bars visible.
#
# The session opens the bootstrap page written by the HUD gateway
# (nix/locked/hud.nix), which loads the HUD with its access token.
{ lib, pkgs, settings, ... }:
let
  # The login screen shown before the HUD when settings.kioskLogin is on.
  tuigreet = pkgs.tuigreet or pkgs.greetd.tuigreet;
  greeter = lib.concatStringsSep " " [
    "${tuigreet}/bin/tuigreet"
    "--time"
    "--asterisks"
    "--remember"
    "--greeting 'WOODPECKER'"
    "--theme 'border=yellow;text=yellow;prompt=yellow;time=yellow;action=yellow;button=yellow;container=black;input=white'"
    "--cmd ${session}"
  ];

  page = "file:///run/woody-hud/boot.html";

  session = pkgs.writeShellScript "woody-kiosk" ''
    export WLR_NO_HARDWARE_CURSORS=1
    export WLR_RENDERER=pixman
    browser() {
      ${pkgs.systemd}/bin/systemd-cat -t woody-kiosk \
        ${pkgs.cage}/bin/cage -s -- \
        ${pkgs.chromium}/bin/chromium \
          --ozone-platform=wayland \
          --no-first-run \
          --noerrdialogs \
          --disable-infobars \
          --disable-session-crashed-bubble \
          --user-data-dir="$HOME/.chromium-kiosk" \
          "--app=$1"
    }
    # Only the "kiosk" user may read the HUD's start page. Anyone else who
    # signs in here gets a short explanation, then the login screen again.
    if [ ! -r /run/woody-hud/boot.html ]; then
      echo "session for $(${pkgs.coreutils}/bin/id -un) cannot read the HUD start page" \
        | ${pkgs.systemd}/bin/systemd-cat -t woody-kiosk
      browser "data:text/html,<body style='background:%23000;color:%23ffb000;font:28px monospace;padding:12vh 10vw'>THIS ACCOUNT CANNOT OPEN THE HUD.<br><br>Sign in as <b>kiosk</b>.<br><br>If you did, the HUD service is not running: check it over SSH with<br>systemctl status woody-hud<br><br>Back to the login screen in a few seconds.</body>" &
      shown=$!
      ${pkgs.coreutils}/bin/sleep 12
      kill "$shown" 2>/dev/null
      exit 0
    fi
    browser ${page}
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
    settings =
      if settings.kioskLogin then {
        # A login prompt first: sign in as "kiosk" with the password you set
        # for it (sudo passwd kiosk). The HUD then opens as that user.
        default_session = { command = greeter; user = "greeter"; };
      } else {
        # Straight into the HUD.
        initial_session = { command = "${session}"; user = "kiosk"; };
        default_session = { command = "${session}"; user = "kiosk"; };
      };
  };

  fonts.packages = [ pkgs.jetbrains-mono ];
}
