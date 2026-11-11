# Installing WoodPecker-OS

The whole system is defined by the flake in this repo. Installing means: boot the NixOS installer, let `disko` partition the disk from `nix/hosts/woodpecker/disko.nix`, and install the `woodpecker` configuration.

**This wipes the VM's disk.**

## 0. Before you wipe: validate in the existing VM

Do this in the Phase 0 spike VM. It checks the configuration builds, and produces the lock file that pins every dependency.

1. Check your keyboard, time zone and locale against `nix/hosts/woodpecker/settings.nix`:

```bash
grep -E "keyMap|timeZone|defaultLocale|layout" /etc/nixos/configuration.nix
```

2. Pull the repo and create the lock file:

```bash
cd ~/WoodPeckerOS && git pull && nix --extra-experimental-features "nix-command flakes" flake lock
```

3. Build the system without installing it (downloads a lot the first time):

```bash
nix --extra-experimental-features "nix-command flakes" build .#nixosConfigurations.woodpecker.config.system.build.toplevel
```

4. Copy the lock file to Windows so it can be committed (run this on Windows, with the VM's IP):

```bash
scp flooweur@VM_IP:WoodPeckerOS/flake.lock D:\Git\WoodPeckerOS\flake.lock
```

If step 2 or 3 prints an error, stop and fix it before going further.

## 1. Prepare the VM (VMware, VM powered off)

1. **Snapshot:** VM → Snapshot → Take Snapshot, name it `phase0-spike`. This is the way back if the install goes wrong.
2. **Second network card:** VM → Settings → Add → Network Adapter → **Host-only**. Keep the first one on NAT.
3. **Boot the installer:** VM → Settings → CD/DVD → tick *Connect at power on* and select the NixOS ISO. Power on, and if it boots the old system instead, use VM → Power → Power On to Firmware and choose the CD.

## 2. Install (in the live installer)

Close the graphical installer window and open a terminal.

1. Confirm the disk name is `sda` (about 80 GB). If not, change `disk` in `settings.nix` first.

```bash
lsblk
```

2. Get the repo:

```bash
nix-shell -p git --run "git clone https://github.com/Flooweur/WoodPeckerOS.git" && cd WoodPeckerOS
```

3. Partition, format and mount the disk. It asks for confirmation before destroying data.

```bash
sudo nix --experimental-features "nix-command flakes" run github:nix-community/disko/latest -- --mode destroy,format,mount --flake .#woodpecker
```

4. Install:

```bash
sudo nixos-install --flake .#woodpecker --no-root-passwd
```

5. Shut down, disconnect the ISO (VM → Settings → CD/DVD → untick *Connect at power on*), and power on.

```bash
sudo poweroff
```

## 3. First boot

The VM boots into the kiosk page. Press **Ctrl+Alt+F2** for a console.

1. Log in as your admin user with the initial password `woodpecker`, then change it immediately:

```bash
passwd
```

2. Clone the repo to the path in `settings.nix`:

```bash
git clone https://github.com/Flooweur/WoodPeckerOS.git ~/WoodPeckerOS
```

3. Find the host-only address (the `192.168.222.x` one) for SSH from Windows:

```bash
ip -4 a
```

4. From Windows: `ssh flooweur@192.168.222.x`. SSH is refused on the NAT address by design.

5. Take a VMware snapshot named `phase1-clean`.

From here on, change the system with `woody-rebuild` (see [REBUILD-ROLLBACK.md](REBUILD-ROLLBACK.md)).
