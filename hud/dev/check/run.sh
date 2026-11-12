#!/bin/sh
# The canvas check: the real gateway and the VM's own Chromium build, driven
# by drive.cjs. It needs hud/dist (cd hud && npm run build) and hud/node_modules.
#
# From the repository, on the Windows host (Git Bash), with a folder for the
# screenshots mounted on /out:
#
#   MSYS_NO_PATHCONV=1 docker run --rm -v woody-nix:/nix -v "D:GitWoodPeckerOS:/work" #     -v "<a folder>:/out" nixos/nix sh /work/hud/dev/check/run.sh
#
# It prints one line per check and ends with ALL CHECKS PASSED or a count.
export NIX_CONFIG="experimental-features = nix-command flakes"
git config --global --add safe.directory "*"
rm -rf /tmp/base && mkdir /tmp/base && cd /work && git ls-files -z | xargs -0 cp --parents -t /tmp/base 2>/dev/null
P='let f = builtins.getFlake "path:/tmp/base"; p = f.nixosConfigurations.woodpecker.pkgs; in'
b() { nix build --impure --no-link --print-out-paths --expr "$P p.$1" 2>/dev/null | tail -1; }
CHROMIUM=$(b chromium); NODE=$(b nodejs_22)
# The container has no fonts: give the browser the HUD's own, so the screenshots can be read.
export FONTCONFIG_FILE=$(nix build --impure --no-link --print-out-paths --expr "$P p.makeFontsConf { fontDirectories = [ p.jetbrains-mono p.dejavu_fonts ]; }" 2>/dev/null | tail -1)
"$NODE/bin/node" /work/hud/dev/check/drive.cjs "$NODE/bin/node" "$CHROMIUM/bin/chromium"
