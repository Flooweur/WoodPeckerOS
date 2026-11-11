# Rebuild and rollback

## How changes work

NixOS never edits the running system in place. Each rebuild creates a new **generation**: a complete system you can boot. Old generations stay in the boot menu, so going back is always possible.

There are three safety nets, from fastest to heaviest:

| Net | Covers | How to use |
|---|---|---|
| NixOS generations | System configuration, packages, services | `sudo nixos-rebuild switch --rollback`, or pick an older entry in the boot menu |
| Btrfs snapshots | Files in `/` and `/home` (not the Nix store, not `/var/log`) | Copy files back from `/.snapshots/<name>/` |
| VMware snapshots | The entire VM | VM → Snapshot → Revert |

## Changing the system

1. Edit the config in `~/WoodPeckerOS` (or `git pull`).
2. Apply it:

```bash
woody-rebuild
```

`woody-rebuild` snapshots `/` and `/home`, then runs `nixos-rebuild switch` from the repo. Other modes:

| Command | Effect |
|---|---|
| `woody-rebuild build` | Build only. Nothing changes; no snapshot. Use it to check a change compiles. |
| `woody-rebuild test` | Activate now, but the next reboot returns to the previous generation. Good for risky changes. |
| `woody-rebuild boot` | Make it the default for the next boot without touching the running system. |

Each generation in the boot menu carries the git commit it was built from (`-dirty` means uncommitted changes).

## Looking around

```bash
nixos-rebuild list-generations
```

```bash
ls /.snapshots
```

## Rolling back

**The new system runs but is wrong:**

```bash
sudo nixos-rebuild switch --rollback
```

**The new system does not boot or the screen is unusable:** reboot, and in the boot menu choose *NixOS - All configurations*, then the previous generation. Once in, run the rollback command above to make it the default again.

**A file was deleted or damaged:** snapshots are plain read-only folders.

```bash
sudo cp -a /.snapshots/<name>/home/flooweur/some-file ~/some-file
```

**Everything is broken:** revert to a VMware snapshot.

## The recovery drill (do this once)

The point is to have recovered on purpose before you need to do it by accident.

1. **Baseline.** Run `woody-rebuild` and note the newest generation number.

2. **Break the build.** Add a line with a deliberate error to `nix/modules/base.nix`, for example `this is not nix`, then:

```bash
woody-rebuild
```

   Expected: an evaluation error, and the running system is untouched. Remove the line.

3. **Break the running system.** In `nix/modules/kiosk.nix`, change `${pkgs.cage}/bin/cage` to `${pkgs.cage}/bin/cage-broken`, then:

```bash
woody-rebuild
```

   Expected: the kiosk goes black. On **Ctrl+Alt+F2**:

```bash
sudo nixos-rebuild switch --rollback
```

   Expected: the kiosk page returns. Undo the edit with `git checkout nix/modules/kiosk.nix`.

4. **Boot an old generation.** Repeat step 3 but do not roll back; reboot instead, choose the previous generation in the boot menu, confirm the kiosk works, then run the rollback command and undo the edit.

5. **Restore a file.** Create a file, snapshot, delete, restore:

```bash
echo "keep me" > ~/drill.txt && woody-rebuild && rm ~/drill.txt
```

```bash
cp /.snapshots/$(ls /.snapshots | tail -1)/home/flooweur/drill.txt ~/drill.txt && cat ~/drill.txt
```

6. **VMware snapshot.** Take one, create a file, revert, confirm the file is gone.

Record what happened at each step. Anything that did not behave as described here is a bug in this document or in the config.
