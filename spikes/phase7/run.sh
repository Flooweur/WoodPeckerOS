#!/usr/bin/env bash
# Phase 7a spike, in the VM. Run it from the repository, over SSH, as your
# admin user (it asks for sudo where it needs it).
#
#   ./spikes/phase7/run.sh bench     ask each model to make things (spends about $1)
#   ./spikes/phase7/run.sh screen    run the canvas test on the VM's own screen
#
# Run "bench" first: "screen" then also loads what the models made.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
out="$here/out"
mkdir -p "$out"

# Node from the same nixpkgs the system is built from: nothing new to trust.
with_node() { nix shell --inputs-from "$repo" nixpkgs#nodejs_22 --command "$@"; }

case "${1:-}" in
  bench)
    shift
    # The key is read by root and handed to the benchmark only. It is never printed.
    key=$(sudo sed -n 's/^ANTHROPIC_API_KEY=//p' /var/lib/woody-secrets/agent.env | tr -d "\"' \r")
    if [ -z "$key" ]; then
      echo "No ANTHROPIC_API_KEY line in /var/lib/woody-secrets/agent.env" >&2
      exit 1
    fi
    (cd "$here/bench" && with_node npm install --no-audit --no-fund --silent)
    ANTHROPIC_API_KEY="$key" with_node node "$here/bench/bench.mjs" --out "$out" "$@"
    ;;

  screen)
    rm -f "$out/results.json"
    with_node node "$here/serve.mjs" --port 7811 --out "$out" &
    server=$!
    restore() {
      sudo rm -f /run/woody-kiosk-page
      kill "$server" 2>/dev/null || true
      sudo systemctl restart greetd
      echo "The HUD is back: sign in as kiosk on the VM's screen."
    }
    trap restore EXIT
    sleep 2
    echo "http://127.0.0.1:7811/" | sudo tee /run/woody-kiosk-page > /dev/null
    sudo systemctl restart greetd
    echo
    echo ">>> Sign in as kiosk on the VM's screen now."
    echo ">>> The test runs by itself for about three minutes. Leave the VM's window visible."
    echo ">>> The results will be printed here."
    echo
    until [ -f "$out/results.json" ]; do
      kill -0 "$server" 2>/dev/null || { echo "The spike server stopped." >&2; exit 1; }
      sleep 2
    done
    sleep 1
    echo
    echo ">>> The VM's screen now shows the things each model made."
    echo ">>> Look at them, then press Enter here to bring the HUD back."
    read -r _
    ;;

  *)
    sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
