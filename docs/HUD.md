# The HUD

What you see when the VM boots: a full-screen page for talking to Woody and approving what it asks to do. Source in `hud/`, NixOS module in `nix/locked/hud.nix`.

The design was drafted and chosen on a canvas (proposal B, with the lattice mind panel). The HUD can be used from two places: the VM's own screen, and your browser on the Windows host.

## The screen

- **Top bar.** One sentence saying what Woody is doing, with a mark whose shape is different for each state. Then four readouts: the next alarm, the queue, the allowance, and the **Pause** and **Stop** switches.
- **Left: Woody's mind in records.** "Needs you" (approvals, plans to accept, questions, proposals, identity changes), the goals in your order, the standing duties with their next run and weekly spend, and four doors: memory, journal, identity, settings.
- **Centre: the conversation,** on a time spine. Each line carries the mark of its kind: circle for something said, square for a tool, triangle for a wake-up, diamond for a save, cross for a problem. Opening a goal or one of the four doors replaces the conversation until you close it.
- **Right: the mind and the machine.** The lattice shows Woody's state, plays a short moment for each event, and has a few expressions. Under it: the activity stream, the machine's meters (read by the gateway from `/proc` every two seconds), failed services, and the engagement scope.

Under the right column are three more views: **LOGS** (the system journal, filtered by unit and severity), **WEB LIST** (the sites Woody may read; you can add and remove them) and, on the VM's own screen only, **TERMINAL**.

Keys: `F2` new goal, `F5` memory, `F6` journal, `F7` identity, `F8` settings, `Esc` closes a panel or, with none open, stops Woody.

Red is used only for what needs you or was refused. Nothing blurs or glows, because the kiosk is software-rendered.

### The lattice

| It shows | How |
|---|---|
| Answering you | Rings spreading from the centre |
| Working | Cells firing here and there |
| Resting | Four centre cells breathing |
| Waiting on you | The left edge blinking red |
| Pacing itself | A full gauge |
| Out of allowance | One red ember |
| Paused | Two red bars, still |
| Model refused, or no key | A red cross |
| Reading the web | Activity behind a wall with one gap |
| Reflecting | Two halves breathing in turn |

Moments play once over the state: woke up, your message arrived, a tool call, something saved, a goal done, a problem. Expressions are tied to real events: a smile when you come back after hours, a wink when a goal finishes within budget, a yawn after a long rest, three taps when it starts work on a goal, a tilted head when it asks you something, a worried face when it woke for a problem, a sparkle when you accept its proposal, a heart when you thank it, eyes towards the conversation while you type, and closed eyes when resting at night. They never cover a state that needs you, and Settings can turn them off.

## Before you rebuild: two passwords to set

The VM's screen now asks for a password before the HUD opens, and your Windows browser needs one too. Set both first, over SSH.

1. The password for the VM's own screen (you sign in there as `kiosk`):

```bash
sudo passwd kiosk
```

2. Rebuild, then set the password for your Windows browser (at least 10 characters):

```bash
sudo -u woody-hud woody-hud set-password
```

VMware does not pass AltGr to the VM's console, so choose a `kiosk` password you can type without it.

To go back to opening the HUD without a login on the VM's screen, set `kioskLogin = false` in `nix/hosts/woodpecker/settings.nix`.

## From your Windows browser

Open `https://<the VM's host-only address>:7843/`. The VM's address is the one you use for SSH.

- The certificate is self-signed, so the browser warns the first time. Check that it is the VM's before accepting. On the VM:

```bash
sudo openssl x509 -in /var/lib/woody-hud/tls/cert.pem -noout -fingerprint -sha256
```

  If `openssl` is not installed, use `nix-shell -p openssl` first. Compare the fingerprint with the one the browser shows for the certificate.
- Sign in with the password you set. A session lasts 12 hours, or until the HUD service restarts.
- Five wrong passwords in ten minutes close the door for ten minutes.
- The port is open only to the Windows host's address (`hostAddress` in `settings.nix`), not to the lab's target machines, which share that network.
- Everything works there except the terminal.

## The terminal

On the VM's own screen, **TERMINAL** opens a real shell.

- It shows a login prompt for your admin user: type your own password.
- It is served by a separate service (`woody-term`) on a local socket that only the HUD gateway can open. It is not a network service, and Woody's user cannot reach it.
- It is never relayed to the Windows browser. Use SSH there.
- While it is open, the executor refuses Woody's screenshots, so what you type and see there stays yours.
- Change your admin password if it is still the initial one from the installation: it is written in the repository.

## Parts

- **Gateway** (`hud/server/gateway.ts`, service `woody-hud`, user `woody-hud`): serves the page on `127.0.0.1:7800`, relays chat to the agent's socket, and sends your approve/deny decisions to the executor's approval socket.
- **Web app** (`hud/web/`, React): the page itself.
- **Kiosk** (`nix/modules/kiosk.nix`): Chromium in app mode under `cage`, opening the gateway's bootstrap page.

- **Terminal** (`woody-term`, in `nix/locked/hud.nix`): `ttyd` running `login`, on `/run/woody-term/term.sock`.

## How access is controlled

Any local process can connect to a loopback port, including the agent. So the gateway requires a secret token for everything except static files:

1. The gateway keeps a token in `/var/lib/woody-hud/token` (its own user only).
2. At start it writes `/run/woody-hud/boot.html`, readable only by the `woody-kiosk` group. The agent's user is not in that group.
3. The kiosk opens that file, which loads the HUD with the token in the URL fragment. The page stores it for the session and removes it from the address.
4. The WebSocket is refused without the token or from a foreign origin.

The host door does not use the token: it uses the password and a session cookie (HttpOnly, Secure, SameSite=Strict), and it checks the request's origin.

Each approval click carries the hash of the exact action shown in the prompt; the executor rejects it if the pending action differs.

## Using it

- Type in the box at the bottom. Enter sends, Shift+Enter adds a line. You can send while Woody is working; it reads the message at its next step.
- Add a goal with **+ NEW** or `F2`. Click a goal to see Woody's review, accept the plan, drop it, or write to Woody about it.
- Tool calls appear as collapsed lines; click one to see what came back.
- When Woody requests an approval-tier action, a red prompt appears. Keyboard focus starts on **Deny**.
- **Pause** stops everything Woody does on its own until you resume. **Stop** interrupts what it is doing now.
- The model, the daily brief, the small-goal limit and the expressions are under Settings.

## If the screen is blank or stuck

```bash
systemctl status woody-hud woody-agent woody-execd --no-pager | grep -E "●|Active"
```

```bash
journalctl -u woody-hud -n 30 --no-pager
```

```bash
journalctl -t woody-kiosk -b --no-pager | tail -30
```

Restart the kiosk session:

```bash
sudo systemctl restart greetd
```

`sudo woody-chat` and `sudo woodyctl` keep working from SSH whatever the HUD is doing.

## Known limits

- VMware does not pass AltGr to the VM, so characters like `#` or `@` are hard to type on the VM's own screen, including in the terminal. Use the HUD from your Windows browser, or SSH, when you need them.
- A phone notification is not built.
