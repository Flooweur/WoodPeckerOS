# Phase 0 — Spikes

Throwaway experiments that answer two questions before the real build starts:

1. **Kiosk graphics:** does greetd → cage → Chromium render an animated HUD smoothly on VMware's virtual GPU?
2. **Agent as a daemon:** does the Claude Agent SDK run as a hardened systemd service on NixOS, with a subscription token and with an API key?

Nothing here is kept; Phase 1 replaces it with a proper flake. This spike has not been run yet, so expect to fix small things as you go and note them in the results table at the bottom.

## 1. Create the VM (Windows host)

1. Install **VMware Workstation Pro** (free; download from Broadcom's support portal, requires a Broadcom account).
2. Download the **NixOS 26.05 graphical ISO** (64-bit Intel/AMD) from <https://nixos.org/download/>.
3. New Virtual Machine → Custom:
   - Guest OS: Linux → "Other Linux 6.x kernel 64-bit"
   - Firmware: **UEFI**
   - 4 processors, **8 GB** memory, **80 GB** disk (single file)
   - Network: **NAT**
4. Before first boot, VM Settings → Display:
   - tick **Accelerate 3D graphics**
   - Graphics memory: **2 GB** (too little gives a black screen)
5. Take a VMware snapshot named `empty` (optional, but cheap).

## 2. Install NixOS

1. Boot the ISO, run the graphical installer.
2. Desktop: choose **No desktop**.
3. Create your own user (this is the human admin account) and let the installer erase the disk.
4. Reboot, log in on the console.

## 3. Get this repo into the VM

```bash
nix-shell -p git --run "git clone https://github.com/Flooweur/WoodPeckerOS.git ~/WoodPeckerOS"
```

If the repo is private, git asks for your GitHub username and a personal access token.

## 4. Apply the spike

Edit the system config:

```bash
sudo nano /etc/nixos/configuration.nix
```

Add the spike to the `imports` list (replace `YOURUSER`):

```nix
imports = [
  ./hardware-configuration.nix
  /home/YOURUSER/WoodPeckerOS/spikes/phase0/spike.nix
];
```

Rebuild and reboot:

```bash
sudo nixos-rebuild switch
```

```bash
sudo reboot
```

If the rebuild fails, nothing changes on the system; read the error, fix, rerun. If the new system boots badly, pick the previous generation in the boot menu.

## 5. Test A — kiosk graphics

After reboot the VM should go straight to a full-screen amber test page.

Record from the on-screen panel:

- **fps avg / 1% low** after about 60 seconds
- **webgl renderer**: `SVGA3D` means VMware 3D is in use; `llvmpipe` or `SwiftShader` means software rendering
- the verdict line (PASS / MARGINAL / FAIL)

Also try: resizing the VMware window, full screen, and leaving it running for 10 minutes.

Escape hatches: **Ctrl+Alt+F2** for a text console, or SSH from Windows (`ip a` in the console shows the VM address).

### Findings so far (VMware Workstation, NixOS 26.05)

| Variant | Result |
|---|---|
| cage (GPU) + Chromium Wayland (GPU) | Chromium crashes: `importing the supplied dmabufs failed` on vmwgfx |
| cage (GPU) + Chromium via X11 layer | Did not work |
| cage `WLR_RENDERER=pixman` + Chromium Wayland | **Works.** 28 fps avg / 18 fps 1% low at 3238×1193, WebGL unavailable, verdict MARGINAL |

`spike.nix` now boots the third variant. Everything is software-rendered, so frame rate scales with resolution: a smaller VM window should be noticeably faster. Still to try if we want real GPU acceleration: an Xorg-based kiosk instead of Wayland.

## 6. Test B — Agent SDK as a service

Create the credential file (root-only). Put **exactly one** line in it.

```bash
sudo mkdir -p /etc/woody-spike && sudo install -m 600 /dev/null /etc/woody-spike/agent.env
```

```bash
sudo nano /etc/woody-spike/agent.env
```

- Run 1 (API key): `ANTHROPIC_API_KEY=...` from the Claude Console.
- Run 2 (subscription): `CLAUDE_CODE_OAUTH_TOKEN=...` produced by `claude setup-token` on a machine where Claude Code is logged in to your plan.

Run it and read the output:

```bash
sudo systemctl start woody-spike-agent; journalctl -u woody-spike-agent -n 40 --no-pager
```

Success is a `result` line with `"ok":true` and text `WOODY ONLINE`. The first run also does `npm install`, so it takes a minute.

Swap the line in `agent.env` and run again for the other credential. Delete the file when finished:

```bash
sudo rm -rf /etc/woody-spike
```

If it fails, the usual suspects in order:

1. **Native binary won't start** (`No such file or directory`, missing `.so`): a nix-ld library is missing; note the name.
2. **Hardening** (`EROFS`, `EACCES`, `Operation not permitted`): comment out hardening lines in `spike.nix` one group at a time to find which one.
3. **Auth** (401/403): credential problem, not a NixOS problem.

## 7. Record the results

| Question | Result |
|---|---|
| WebGL renderer string | |
| FPS avg / 1% low, GPU on | |
| FPS avg / 1% low, GPU off | |
| Resize / full screen behave? | |
| SDK runs with API key? | |
| SDK runs with subscription token? | |
| Extra nix-ld libraries needed | |
| Hardening options that had to be relaxed | |

Decisions these feed:

- GPU PASS → animated HUD as planned. MARGINAL/FAIL → HUD ships with a low-effects mode as default.
- Subscription token works as a service → dual-credential design stays. Otherwise → API key only, and the budget needs revisiting.
