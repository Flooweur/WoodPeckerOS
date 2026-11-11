# `woody-rebuild`: the one command for changing the system.
# Takes read-only Btrfs snapshots of / and /home, then runs nixos-rebuild
# from the repo. Old snapshots are pruned.
{ pkgs, settings, ... }:
let
  woody-rebuild = pkgs.writeShellApplication {
    name = "woody-rebuild";
    # nixos-rebuild itself comes from the running system's PATH.
    runtimeInputs = with pkgs; [ btrfs-progs git coreutils findutils ];
    text = ''
      repo="''${WOODY_REPO:-${settings.repoPath}}"
      keep=${toString settings.snapshotsToKeep}
      action="''${1:-switch}"

      case "$action" in
        switch|test|boot|build|dry-activate) ;;
        *) echo "usage: woody-rebuild [switch|test|boot|build|dry-activate]" >&2; exit 2 ;;
      esac

      if [ "$(id -u)" -ne 0 ]; then
        exec sudo WOODY_REPO="$repo" "$0" "$@"
      fi

      if [ ! -e "$repo/flake.nix" ]; then
        echo "No flake.nix in $repo (set WOODY_REPO or settings.repoPath)" >&2
        exit 1
      fi

      rev="$(git -c safe.directory="$repo" -C "$repo" rev-parse --short HEAD 2>/dev/null || echo nogit)"
      if [ -n "$(git -c safe.directory="$repo" -C "$repo" status --porcelain 2>/dev/null)" ]; then
        rev="$rev-dirty"
      fi

      # Snapshot before anything that changes the running system.
      if [ "$action" != "build" ] && [ "$action" != "dry-activate" ]; then
        name="$(date +%Y%m%d-%H%M%S)-$rev"
        mkdir -p "/.snapshots/$name"
        btrfs subvolume snapshot -r / "/.snapshots/$name/root" >/dev/null
        btrfs subvolume snapshot -r /home "/.snapshots/$name/home" >/dev/null
        echo "snapshot: /.snapshots/$name"

        # Prune: keep the newest $keep snapshot sets.
        mapfile -t sets < <(find /.snapshots -mindepth 1 -maxdepth 1 -type d | sort)
        excess=$(( ''${#sets[@]} - keep ))
        if [ "$excess" -gt 0 ]; then
          for old in "''${sets[@]:0:excess}"; do
            for sub in root home; do
              if [ -d "$old/$sub" ]; then btrfs subvolume delete "$old/$sub" >/dev/null; fi
            done
            rmdir "$old" && echo "pruned:   $old"
          done
        fi
      fi

      echo "rebuild:  $action from $repo ($rev)"
      nixos-rebuild "$action" --flake "$repo#woodpecker"
    '';
  };
in
{
  environment.systemPackages = [ woody-rebuild ];
}
