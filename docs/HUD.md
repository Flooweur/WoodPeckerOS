# The HUD: the frame

What you see when the VM boots: a black screen with the lattice in its top right corner. Source in `hud/`, NixOS module in `nix/locked/hud.nix`.

This is the frame of the redesign ([VISION.md](VISION.md)): the small part of the screen that Woody cannot change. The rest of the screen is Woody's canvas, where its things are shown. Ask Woody for something ("show me a clock that runs backwards") and it puts a thing there.

The frame can be used from two places: the VM's own screen, and your browser on the Windows host.

## The screen

- **The lattice,** top right, always there. It shows Woody's state, plays a short moment for each event, and has a few expressions. A red number on its corner counts what needs you.
- **The voice line,** beside the lattice. While Woody is doing something, one sentence says what. What you wrote and what Woody answered appear here as it speaks, stay for a while (longer for a longer answer), then let go. Click them to open the whole conversation. At rest, with nothing said, there is only the lattice.
- **The typing line.** Just start typing, anywhere: a line appears at the bottom with what you typed. Enter sends it, Shift+Enter adds a line, Esc clears it. You can send while Woody is working; it reads the message at its next step.
- **The lattice menu.** Click the lattice. It shows what Woody is doing and the allowance, the **Pause** and **Stop** switches, and the records.
- **A record** opens below the lattice and closes with Esc.
- **The approval prompt** is drawn by the frame above everything else. Keyboard focus starts on **Deny**.

Red is used only for what needs you or was refused. Nothing blurs or glows, because the kiosk is software-rendered.

### The records

Everything the three-column HUD showed is still there, one click or one key away.

| Key | Record | What it holds |
|---|---|---|
| `F1` | Needs you | Approvals, plans to accept, questions, proposals, identity changes |
| `F2` | New goal | The form to give Woody a goal |
| `F3` | Goals | The goals in your order, and the standing duties with their next run and weekly spend |
| `F4` | Conversation | Everything said, on a time spine. Each line carries the mark of its kind: circle for something said, square for a tool, triangle for a wake-up, diamond for a save, cross for a problem |
| `F5` | Memory | What Woody remembers, with where each item came from |
| `F6` | Journal | One entry per wake-up |
| `F7` | Identity | Who Woody is, how much of the first version remains, each change Woody made with its before and after, and every version with a button to put it back |
| `F8` | Settings | The model, the daily brief, the small-goal limit, the expressions |
| `F9` | Machine | Woody's state, next alarm, queue and allowance; how Woody is (energy, ease, curiosity, attention to you, unease) and why; the machine's meters (read by the gateway from `/proc` every two seconds), failed services, and which services answer |
| `F10` | Activity | The latest events |
| | System log | The system journal, filtered by unit and severity |
| | Web list | The sites Woody may read; you can add and remove them |
| | Terminal | A shell, on the VM's own screen only |

`Esc` lets go of one thing at a time: the line being typed, the menu, the open record and, with nothing open, Woody's current work.

Two more records, also in the lattice menu, belong to the canvas: **Things** (every thing, on the canvas or put away: who made it, why, its versions and its source) and **Changes** (every change to the canvas with who made it and why, the attempts that were refused, and undo).

**Its face** (in the lattice menu) shows every design the lattice can play, each as a small live lattice: which ones Woody drew itself, when and why, with a button to put the built-in one or an earlier drawing back. The frame's own signals are listed last with what each one says.

When Woody has changed its identity and you have not looked yet, a notice appears beside the lattice. Clicking it opens the identity record on the change.

**Its own life** (in the lattice menu) is the record of what Woody does when nothing is asked of it:

- whether it is day, evening or night for Woody, and whether it is asleep;
- its own share of the budget: what is free now and what is spent this month;
- how many moments of its own it had today, and why the next one is or is not due;
- how many things it added to the canvas today without being asked, out of the limit;
- its interests, each with where it came from and its notes. You can suggest one and remove one;
- what it did with its own time, from its journal, including the days it did nothing;
- your handles: turn its own time off, set how many things it may add in a day unasked (0 to 20), set the hours of its day.

## The canvas

A thing is a small live program Woody put on the canvas: a clock, a list, a chart. Each one runs sealed in its own frame, with no network and no access to the rest of the screen. It keeps working without Woody.

- **The band.** Every thing has a thin band along its top edge. Put the pointer on it and it opens into a strip: drag it to move the thing, **pin**, **why** (opens its record), and **×** to take it off the canvas. A corner grip resizes it.
- **Pinning.** A pinned thing has an amber band. Woody cannot change, move or remove it; you still can. Only you pin and unpin.
- **Nothing is lost.** A thing taken off the canvas is kept with all its versions and can be put back from the Things record. Every version of a thing is kept and any of them can be shown again.
- **Undo.** The lattice menu shows the last change and takes it back; again for the one before, and so on. Only you undo.
- **Pretend.** A thing Woody declared as invented content has a dashed edge and a `PRETEND` mark drawn by the frame.
- **A thing that does not work is not shown.** A thing appears once it says it is running. One that never does, or that tries to leave its frame, is covered with the reason.
- The canvas is the same on the VM's screen and in your Windows browser, and survives restarts.

### What Woody adds on its own

- A thing Woody put there without having been asked is marked in its record ("Woody put it there on its own") and in the changes record ("on its own").
- If it is for you, it carries a note saying what it is and why. The frame draws the note under the thing, outside the thing's own frame, until you click "ok". The note stays in the thing's record.
- The gateway counts these additions and refuses the one over the day's limit (three by default). You set the limit in "Its own life", or with `woody-hud canvas limit <n> --as you`. Woody cannot.
- Pinning, removing and undo work on them like on anything else, and Woody is told what you did.

### How Woody makes a thing

- For something a ready part covers, Woody places a part of the **kit** (text, note, list, table, chart, clock, meter, picture, buttons, input). It appears in about a second.
- For anything else it writes a brief and a **maker** writes the thing: about ten seconds with the everyday model, less for something small, more for something intricate. While it is being made, the voice line says so.
- The new thing is **tried on the screen** before it is kept. If it does not start, the canvas stays as it was and Woody tells you.
- While you have **paused** Woody it cannot change the canvas.
- A kit button or input, or a made thing that was asked to, can **tell Woody** that something happened on it. Woody then wakes for that event.

Details are in [AGENT.md](AGENT.md), under "Making things".

### Making a thing by hand

To try a thing yourself, use the command line on the VM. A thing's source is an HTML fragment (markup, a `<style>` and a `<script>`). The samples of the Phase 7a spike are ready to use: `clock`, `backclock`, `list`, `meters` and `note` in `/etc/woodpecker/source/spikes/phase7/canvas/things/` (the system's own copy of the repository).

```bash
sudo -u woody-hud woody-hud canvas make "Backwards clock" /etc/woodpecker/source/spikes/phase7/canvas/things/backclock.html --why "trying the canvas"
```

```bash
sudo -u woody-hud woody-hud canvas list
```

| Command | What it does |
|---|---|
| `canvas make <title> <file> [--why text] [--pretend] [--for woody] [--at x,y,w,h]` | Puts a new thing on the canvas |
| `canvas kit <part> '<values as JSON>' [--title text]` | Puts a kit part on the canvas, for example `canvas kit clock '{"timezone":"Asia/Tokyo"}'` |
| `canvas change <id> <file> [--why text] [--title text]` | A new version of a thing |
| `canvas place <id> <x> <y> [w] [h]` | Moves or resizes it |
| `canvas remove <id>` and `canvas bring_back <id>` | Takes it off the canvas, puts it back |
| `canvas pin <id> [off]` | Pins or unpins it (as you) |
| `canvas undo` | Takes back the last change (as you) |
| `canvas limit [n]` | Shows how many things Woody may add in a day on its own and how many it has today; with a number and `--as you`, sets the limit |
| `--uninvited --note "text"` on `make` and `kit` | Makes the thing as Woody would on its own: it needs the note, and counts against the day's limit |
| `canvas list`, `canvas get <id>`, `canvas history [n]` | What is there, one thing with its source, the latest changes |

These requests are made the way Woody makes them: a pinned thing refuses them, Pause refuses them, and a new thing that does not start is taken back. Add `--as you` to act as yourself. The file must be readable by the `woody-hud` user, which your home directory is not: use the system's copy as above, or copy your own file to `/tmp` first.

### How a thing is kept and served

- The gateway keeps the things under `/var/lib/woody-hud/canvas/`: each version's source, each thing's saved state, the layout, and `changes.jsonl`, the append-only record of changes. Woody's user cannot write there.
- A thing is served at `/thing/<key>`, where the key is an unguessable name for that one thing. The page is sent with a policy that allows inline code only and forbids every network use, and the frame shows it with `sandbox="allow-scripts"`. The WebRTC interfaces are removed before the thing's code runs.
- The frame page may only show frames from `/thing/` and `/term/`, so a thing cannot take its frame anywhere else.
- A thing talks to the frame through the bridge (`window.woody`): `ready()`, `state.get()` and `state.set(value)` for its own saved state, `subscribe("meters", fn)` for the machine's readings, and `emit(name, data)` to tell Woody that something happened. The frame knows which thing is speaking from the window the message came from.

### The lattice

The ongoing state moves quicker when Woody is fresh and slower when it is tired. A state that needs you never changes its look.

The table gives the built-in designs. Since Phase 8c Woody may redraw the ones that are its own (answering, working, resting, asleep, reflecting, the moments except "problem", and the expressions) and invent expressions; its drawings are flip books of up to 16 pictures in one of five colours. The rows in red, pacing and the web wall are the frame's: they are drawn as below whatever Woody has drawn. See "A face of its own" in [MIND.md](MIND.md).

| It shows | How |
|---|---|
| Answering you | Rings spreading from the centre |
| Working | Cells firing here and there |
| Resting | Four centre cells breathing |
| Asleep | Closed eyes and two Zs; one low line breathing slowly when expressions are off |
| Waiting on you | The left edge blinking red |
| Pacing itself | A full gauge |
| Out of allowance | One red ember |
| Paused | Two red bars, still |
| Model refused, or no key | A red cross |
| Reading the web | Activity behind a wall with one gap |
| Reflecting | Two halves breathing in turn |

Moments play once over the state: woke up, your message arrived, a tool call, something saved, a goal done, a problem. Expressions are tied to real events: a smile when you come back after hours, a wink when a goal finishes within budget, a yawn after a long rest, three taps when it starts work on a goal, a tilted head when it asks you something, a worried face when it woke for a problem, a sparkle when you accept its proposal, a heart when you thank it, eyes towards the conversation while you type, and closed eyes while it is asleep (its night, with nobody at the screen). Woody may also show an expression when it chooses, a few times in a session. They never cover a state that needs you, and Settings can turn them off.

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
- The port is open only to the Windows host's address (`hostAddress` in `settings.nix`), not to any other machine on that network.
- Everything works there except the terminal.

## The terminal

On the VM's own screen, **Terminal** in the lattice menu opens a real shell.

- It shows a login prompt for your admin user: type your own password.
- It is served by a separate service (`woody-term`) on a local socket that only the HUD gateway can open. It is not a network service, and Woody's user cannot reach it.
- It is never relayed to the Windows browser. Use SSH there.
- While it is open, the executor refuses Woody's screenshots, so what you type and see there stays yours.
- Change your admin password if it is still the initial one from the installation: it is written in the repository.

## What the kiosk's browser can reach

Nothing but this machine. The browser on the VM's screen is set by policy to look up no outside name and to keep WebRTC off the network, and a firewall rule lets the `kiosk` user reach the loopback address only. This matters because the screen runs code written by Woody.

## Parts

- **Gateway** (`hud/server/gateway.ts`, service `woody-hud`, user `woody-hud`): serves the page on `127.0.0.1:7800`, relays chat to the agent's socket, sends your approve/deny decisions to the executor's approval socket, and keeps the canvas (`hud/server/canvas.ts`).
- **Web app** (`hud/web/`, React): the page itself. `hud/web/src/frame/` is the frame; `hud/web/src/canvas/` shows the things.
- **Mock** (`hud/dev/mock.cjs`): a stand-in for the gateway and the agent with sample data, to look at the frame in a browser without the VM.
- **Canvas check** (`hud/dev/check/`): the real gateway and the VM's Chromium build driven by a script that acts like an operator and checks the canvas's promises, including a hostile thing (`hud/dev/probe.html`).
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

- Type anywhere to write to Woody.
- Add a goal with `F2`, or from the goals record (`F3`). Click a goal to see Woody's review, accept the plan, drop it, or write to Woody about it.
- In the conversation record, tool calls appear as collapsed lines; click one to see what came back.
- When Woody requests an approval-tier action, a red prompt appears. Keyboard focus starts on **Deny**.
- **Pause** (in the lattice menu) stops everything Woody does on its own until you resume. **Stop** (in the menu, or `Esc` with nothing open) interrupts what it is doing now.
- The model, the daily brief, the small-goal limit and the expressions are under Settings (`F8`).

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
