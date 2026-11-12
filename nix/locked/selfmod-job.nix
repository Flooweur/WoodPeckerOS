# LOCKED CORE. The root job behind Woody's configuration changes.
#
#   woody-selfmod check          does the admin's checkout match the running system?
#   woody-selfmod apply <dir>    snapshot, build, activate on trial, health
#                                check, then make permanent; roll back on failure
#
# `apply` is started by woody-execd as its own systemd unit, so it keeps
# running if activating the new system restarts the executor or the agent.
# It only ever works on a root-owned candidate directory the executor staged.
{ pkgs, config, settings }:
pkgs.writeShellApplication {
  name = "woody-selfmod";
  runtimeInputs = with pkgs; [
    coreutils findutils gnugrep gawk diffutils gnutar git jq curl util-linux btrfs-progs getent
    config.nix.package config.systemd.package
  ];
  text = ''
    repo=${settings.repoPath}
    admin=${settings.adminUser}
    keep=${toString settings.snapshotsToKeep}
    candidates=/var/lib/woody-execd/selfmod/candidates
    export HOME=/root
    export NIX_CONFIG="experimental-features = nix-command flakes"

    admin_home="$(getent passwd "$admin" | cut -d: -f6)"
    as_admin() {
      setpriv --reuid="$admin" --regid="$(id -g "$admin")" --init-groups \
        env HOME="$admin_home" "$@"
    }

    # The checkout must be clean and identical to what the running system was
    # built from. Otherwise applying a change would drop the human's edits, or
    # their next rebuild would drop Woody's.
    check_repo() {
      if [ ! -d "$repo/.git" ]; then
        echo "no git checkout at $repo" >&2; return 1
      fi
      if [ -n "$(as_admin git --no-optional-locks -C "$repo" status --porcelain --untracked-files=no)" ]; then
        echo "uncommitted changes in $repo" >&2; return 1
      fi
      local tmp
      tmp="$(mktemp -d)"
      as_admin git -C "$repo" archive HEAD | tar -x -C "$tmp"
      if ! diff -rq "$tmp" "$(readlink -f /etc/woodpecker/source)" >/dev/null 2>&1; then
        rm -rf "$tmp"
        echo "$repo differs from the running configuration" >&2; return 1
      fi
      rm -rf "$tmp"
    }

    case "''${1:-}" in
      check) check_repo; exit 0 ;;
      apply) ;;
      *) echo "usage: woody-selfmod check | apply <candidate dir>" >&2; exit 2 ;;
    esac

    dir="$(readlink -f "''${2:-/nonexistent}")"
    case "$dir" in
      "$candidates"/*) ;;
      *) echo "not a candidate directory" >&2; exit 2 ;;
    esac
    if [ ! -f "$dir/meta.json" ] || [ ! -d "$dir/tree" ]; then
      echo "incomplete candidate" >&2; exit 2
    fi

    id="$(basename "$dir")"
    tree="$dir/tree"
    status="$dir/status.json"
    log="$dir/apply.log"
    exec >>"$log" 2>&1
    echo "== $(date -Is) apply $id"

    put() {
      jq -n --arg state "$1" --arg step "$2" --arg message "$3" \
        '{state: $state, step: $step, message: $message, updated_s: (now | floor)}' >"$status.tmp"
      mv "$status.tmp" "$status"
    }
    fail() {
      put failed "$1" "$2 Last output: $(tail -n 12 "$log" | cut -c1-240 | tr '\n' ' ')"
      exit 1
    }
    failed_units() {
      systemctl list-units --failed --no-legend --plain | awk '{print $1}' | sort
    }

    put running check "Checking the repository"
    check_repo || fail check "The repository no longer matches the running system; nothing was changed."

    put running snapshot "Taking a snapshot"
    name="$(date +%Y%m%d-%H%M%S)-woody-$id"
    mkdir -p "/.snapshots/$name"
    if ! btrfs subvolume snapshot -r / "/.snapshots/$name/root" >/dev/null \
      || ! btrfs subvolume snapshot -r /home "/.snapshots/$name/home" >/dev/null; then
      fail snapshot "Could not take a snapshot; nothing was changed."
    fi
    mapfile -t sets < <(find /.snapshots -mindepth 1 -maxdepth 1 -type d | sort)
    excess=$(( ''${#sets[@]} - keep ))
    if [ "$excess" -gt 0 ]; then
      for old in "''${sets[@]:0:excess}"; do
        for sub in root home; do
          if [ -d "$old/$sub" ]; then btrfs subvolume delete "$old/$sub" >/dev/null || true; fi
        done
        rmdir "$old" || true
      done
    fi

    put running build "Building the new system"
    if ! new="$(nix build "path:$tree#nixosConfigurations.woodpecker.config.system.build.toplevel" \
      --no-link --print-out-paths --no-write-lock-file)"; then
      fail build "The build failed; nothing was changed."
    fi

    prev="$(readlink -f /run/current-system)"
    failed_before="$(failed_units)"
    rollback() {
      echo "== rolling back to $prev"
      "$prev/bin/switch-to-configuration" test || true
    }

    # The new system must stay healthy for six checks in a row (12 s), so a
    # service that starts and then crashes is caught.
    healthy() {
      local good=0 ok code restarts last_restarts=""
      for _ in $(seq 1 60); do
        ok=1
        for unit in woody-execd.service woody-hud.service woody-agent.socket woody-agent.service; do
          if ! systemctl is-active --quiet "$unit"; then ok=0; echo "health: $unit is not active"; fi
        done
        restarts="$(systemctl show woody-agent.service woody-execd.service woody-hud.service --property=NRestarts --value | tr '\n' ' ')"
        if [ -n "$last_restarts" ] && [ "$restarts" != "$last_restarts" ]; then
          ok=0; echo "health: a core service restarted"
        fi
        last_restarts="$restarts"
        if ! /run/current-system/sw/bin/woodyctl status >/dev/null 2>&1; then ok=0; echo "health: the executor does not answer"; fi
        code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' http://127.0.0.1:7800/ || true)"
        if [ -z "$code" ] || [ "$code" = "000" ]; then ok=0; echo "health: the HUD does not answer"; fi
        if [ -n "$(comm -13 <(echo "$failed_before") <(failed_units))" ]; then
          ok=0; echo "health: newly failed units: $(comm -13 <(echo "$failed_before") <(failed_units) | tr '\n' ' ')"
        fi
        if [ "$ok" = 1 ]; then good=$(( good + 1 )); else good=0; fi
        if [ "$good" -ge 6 ]; then return 0; fi
        sleep 2
      done
      return 1
    }

    put running activate "Activating the new system on trial"
    if ! "$new/bin/switch-to-configuration" test; then
      rollback
      fail activate "Activation reported errors; the previous system was restored."
    fi

    put running health "Checking that the system is healthy"
    if ! healthy; then
      rollback
      fail health "The new system was not healthy; the previous system was restored."
    fi

    put running commit "Making the change permanent"
    if ! nix-env --profile /nix/var/nix/profiles/system --set "$new" \
      || ! "$new/bin/switch-to-configuration" boot; then
      rollback
      fail commit "Could not make the change permanent; the previous system was restored."
    fi
    generation="$(readlink /nix/var/nix/profiles/system | tr -cd 0-9)"

    # Record the change in the admin's checkout, as a commit by Woody, so the
    # repository keeps matching the running system. Nothing is pushed.
    recorded=1
    printf 'woody: %s\n\nApplied by woody-execd (candidate %s, generation %s).\n' \
      "$(cat "$dir/summary.txt")" "$id" "$generation" >"$dir/commit-message.txt"
    while read -r kind path; do
      case "$kind" in
        M) as_admin install -D -m 0644 "$tree/$path" "$repo/$path" || recorded=0 ;;
        D) as_admin rm -f -- "$repo/$path" || recorded=0 ;;
      esac
      as_admin git -C "$repo" add -A -- "$path" || recorded=0
    done <"$dir/changes.txt"
    as_admin git -C "$repo" -c user.name=Woody -c user.email=woody@woodpecker.local \
      commit -q -F "$dir/commit-message.txt" || recorded=0

    if [ "$recorded" = 1 ]; then
      put applied finished "Applied as generation $generation and committed in $repo."
    else
      put applied finished "Applied as generation $generation, but it could not be committed in $repo. Fix the checkout by hand before the next change."
    fi
  '';
}
