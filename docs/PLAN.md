# WoodPecker-OS: build plan

## Context

WoodPecker-OS is a NixOS virtual machine whose whole interface is Woody, a Claude-powered mind that lives in it. The goal, since 2026-11-12, is **a computer that is alive**: one you interact with instead of controlling. The goal, the decisions behind it and the design are in [VISION.md](VISION.md). This document records what is built and defines the phases to come.

The project first aimed at a security-testing toolkit for a home lab. That goal was dropped on 2026-11-12 and its code removed (Phase 6 below). The base it was built on is kept: rollback, the privileged core, the mind and the first HUD.

**Standing rule for every phase:** the machine must stay recoverable. Woody changes freely what is its own; the locked core changes only with the operator's approval; every change has a record and an undo.

## Decisions

Earlier decisions that still hold:

| Topic | Decision |
|---|---|
| Hypervisor | VMware Workstation Pro on Windows 11 Pro (32 GB host) |
| Claude auth | API key only for now (subscription token deferred; the credential stays a config switch) |
| Languages | TypeScript (agent, tools, HUD) and Rust (privileged executor) |
| System actions | Tiered: read-only free; reversible logged; system-level needs approval |
| Look | Amber on black, woodpecker-red for what needs you. It becomes the starting house style, which Woody may evolve |
| Operator | New to NixOS, fine with Linux: keep the Nix structure simple and documented |
| Nature of Woody | An always-present mind: it wakes on its own, works towards goals, rests. Design in [MIND.md](MIND.md) |
| Character | Somewhat playful, observant, honest about uncertainty. It never bluffs, misleads or manipulates |

Decisions of the redesign (2026-11-12) are listed in full in [VISION.md](VISION.md). In short: the screen is Woody's canvas with only the lattice fixed; things on it are real code, isolated and saved; Woody acts on its own canvas and on its own program freely, with undo; it has an inner state with real causes, interests and a budget share of its own; its identity evolves and can be restored; it reads any public site through the quarantined reader; it has sound and a voice but does not listen; Linux programs appear as things; $100 a month is assumed, a quarter of it Woody's.

Superseded on 2026-11-12: the security toolkit and its lab; "no voice" (Woody may now speak, but not listen); web reading from an approved list only; identity changes only by approval; observe-only mode for everything Woody does on its own.

## Phases

| Phase | Content | Status |
|---|---|---|
| 0 | Spikes | Done |
| 1 | Base system and rollback | Done |
| 2 | Privileged core, agent, thin HUD | Done |
| 3 | System hands: observe and operate, self-modification, screenshots | Done |
| 4 | The mind loop: events, memory, goals, journal, alarms, pacer, web reading | Built; 4c, 4d and 4e await the VM test |
| 5 | The first full HUD | Built; awaits the VM test |
| 6 | Change of goal: security material removed, documents rewritten | Done (2026-11-12); awaits the VM rebuild |
| 7 | **The canvas**: the frame, things, the kit, making | 7a (spikes) done. 7b (the frame) built; awaits the VM test. 7c (things) is next |
| 8 | **Somebody home**: inner state, own life, initiative, identity that evolves | Planned |
| 9 | **Learning and showing**: open reading, studies, explainers, web pictures | Planned |
| 10 | **Reshaping itself**: free change of its own program | Planned |
| 11 | **Sound and voice** | Planned |
| 12 | **Programs on the canvas** | Planned |

## Phase 0 results (2026-11-11)

- **Kiosk graphics:** GPU-accelerated Chromium under cage does not work on VMware (`vmwgfx` rejects Chromium's dmabuf buffers). The working setup is cage with `WLR_RENDERER=pixman` (software). Measured 28 fps at 3238×1193 and about 55 fps at a smaller window. Consequences: the HUD ships with a low-effects mode as default and effects as an opt-in; the kiosk uses Chromium `--app=` mode because `--kiosk` left the browser bars visible. An Xorg-based kiosk is the untested route to real GPU acceleration, kept as an optional later experiment.
- **Agent SDK as a service:** works as an unprivileged user under the full planned systemd hardening, with nix-ld, using an API key.
- **Auth decision changed:** API key only for now. The subscription path was not tested and is deferred.
- **Cost finding:** the SDK defaults to `claude-opus-5-5`; a one-line reply cost $0.073, nearly all from caching the default ~14.5k-token system prompt. Phase 2 must set the model per task (cheap model for triage and routines), keep the prompt cache warm, and meter interactive chat as well as background work, since both now bill to the API key. The $50/month figure covered background use only and needs a second number for chat.

## Phase 1 results (2026-11-11)

- Installed from the flake with disko (Btrfs subvolumes, hybrid BIOS/UEFI boot); `flake.lock` generated and validated in the VM.
- Recovery drill passed: failed build leaves the system untouched, runtime breakage rolled back, old generation booted from the menu, file restored from a Btrfs snapshot, VMware snapshot reverted.
- Finding: `nixos-rebuild switch --rollback` fails on a flake-only system. Rollback is `woody-rebuild rollback` (profile rollback + activation, no config evaluation). The Phase 2 executor's auto-rollback must use the same mechanism.
- VMware does not pass AltGr to the VM console; day-to-day work is over SSH from the host-only network.

## Phase 2 results (2026-11-11)

- `woody-execd` (Rust, root): typed action catalog with tiers, approvals on a separate socket bound to the exact action, hash-chained append-only audit log. Verified in the VM.
- `woody-agent` (TypeScript, user `woody`): Claude Agent SDK with no built-in tools, only typed tools that call the executor; model switch; monthly and per-turn spend limits.
- Thin HUD and its gateway (user `woody-hud`): chat, model picker, spend meter, approval prompt. The gateway replaced the planned Caddy routing.
- Not built as planned: `packages/protocol` (shared schemas). The protocol is small and documented in EXECUTOR.md and AGENT.md; revisit when Phase 4 enlarges it.
- The API key sits in a root-only file for now; moving it to sops-nix is still to do.

## Phase 3a results (2026-11-11)

- Observe and operate: processes, services (start, stop and restart need approval; locked-core units are refused), journal search, osquery restricted to 29 tables, files (read `/etc` and `/nix/store`, write only in the workspace), HUD notices.
- Tested in containers and then in the VM.

## Phase 3b results (2026-11-12)

- Woody can change its own NixOS configuration: propose, then apply with snapshot, trial activation, health check, automatic rollback, and a commit in the admin's checkout. Details in [SELFMOD.md](SELFMOD.md).
- The locked core is enforced two ways: a list of locked paths, and a privilege fingerprint of the evaluated system that catches indirect changes.
- Changed from the plan: Woody does not keep a git clone. It sends file contents to the executor, which works on its own root-owned copy. No path supplied by the agent is ever read by root.
- Known limit: the fingerprint is a tripwire, not a proof (see SELFMOD.md).
- Tested in the VM on 2026-11-12, including the apply job.

## Phase 3c results (2026-11-12)

- Screenshots: the executor runs `grim` as the kiosk user; Woody receives the picture and can look at the HUD.
- Clipboard, changed from the plan: the kiosk compositor (`cage`) does not offer the clipboard protocol that `wl-clipboard` needs without stealing the screen. Instead Woody offers text through a HUD notice with a Copy button, and cannot read the clipboard. This also works unchanged when the HUD is opened from the Windows host browser (Phase 5).
- Phase 3 is complete.

## Phase 4a results (2026-11-12)

- The mind's store (`/var/lib/woody/mind.db`): append-only event log, saved conversation, journal, memories with origin, sources and versions, identity. Details at the end of [MIND.md](MIND.md).
- Each turn's context is assembled from the store; the SDK session is only a short-lived working context.
- Chosen: Node's built-in SQLite driver (with full-text search), so no native dependency to package.
- 12 store-level continuity tests run in the build. The model-level tests are done by hand in the VM.

## Phase 4b results (2026-11-12)

- Woody is now a loop over one event queue, with a one-minute pulse, self-set alarms, system events, messages delivered while it works, Stop and Pause, approvals that wait a week, retry-once crash recovery, the spending pacer and a daily copy of the store. Details in [MIND.md](MIND.md).
- Pause is enforced in the executor and was tested live against the built binary.
- Found while building: the SDK delivers queued messages only after the current reply, so mid-work delivery uses a hook that runs between tool calls, with a one-time key so tool output cannot imitate the operator.
- Wake-ups with a real model are untested outside the VM.

## Phase 4c results (2026-11-12)

- The goals board: goals with their own threads, review by Woody (understanding, judgement, plan, estimate, questions), the small-goal rule, acceptance with a budget, checkpoints, stops for budget or lack of progress, proposals, four standing duties, and plain HUD views for inbox, goals and journal. Details in [MIND.md](MIND.md).
- Added beyond the design: an observe-only mode, enforced in the tool layer, for everything Woody does on its own without a plan the operator accepted.
- The rule that decides what may start is code in the store; the model only supplies the review.
- A goal handled end to end by a real model is untested outside the VM.

## Phase 4d results (2026-11-12)

- Daily reflection (store, merge, correct, optionally propose an identity change), identity versions with operator approval, the daily brief and the catch-up on return. Details in [MIND.md](MIND.md).
- Changed from the design: "on arrival" cannot be detected from a connection, because the kiosk HUD is always connected. The HUD sends a sign of life on key presses and clicks instead.
- A real reflection, brief and catch-up are untested outside the VM.

## Phase 4e results (2026-11-12)

- Read-only web access: an allow-listed, pinned, redirect-free fetch in the executor; search and reading done by a quarantined model with no way to act; sessions that read the web restricted to observing and taking notes; web-origin memory. "Stay up to date" is on. Details in [MIND.md](MIND.md).
- The fetch was tested live against the built executor. Search and the reader need the API and are untested outside the VM.
- Phase 4 is complete in code.

## Phase 5a results (2026-11-12)

- The design was drafted on a canvas and chosen by the operator: three columns, notched amber panels, one shape per kind of event, and an 8 by 8 lattice as the mind panel, with a chosen animation for each state and moment and ten expressions.
- Built: the presence bar, the three columns, the conversation on a time spine, the panels for a goal, a new goal, the journal, memory, identity and settings, the activity stream and the machine meters. See [HUD.md](HUD.md).
- The gateway now reads the machine meters itself; the agent sends an activity list and the events behind the expressions.
- Checked in a browser against sample data. Not yet seen in the VM's kiosk.

## Phase 5b results (2026-11-12)

- Log view and web allow-list view in the HUD; the allow-list can also be edited with `woodyctl`.
- Terminal on the VM's own screen only: `ttyd` running `login` on a local socket, relayed by the gateway to the kiosk door and never to the host door. Screenshots are refused while it is open.
- Host access: HTTPS on port 7843, open only to the Windows host's address, behind a password and a session cookie, with a lock after five wrong passwords.
- Login at boot on the VM's screen (`tuigreet`, signing in as `kiosk`), switchable in `settings.nix`.
- Tested live in a container with a real `ttyd`: 29 checks on both doors and the terminal relay. The login screen, the certificate generation and the firewall rule are untested outside the VM.
- Phase 5 is complete in code.

## Phase 6 results (2026-11-12): change of goal

- The goal became "a computer that is alive". It was settled with the operator in 23 questions after a review of what exists (generated interfaces, malleable software, always-on agents, companion design, science fiction). The result is [VISION.md](VISION.md).
- Removed from the code: engagements and the scope engine in the executor, the `scope.check` action, the kernel filter and the `woody-tools` user, `woody-isolation-test`, the SCOPE view, the `scope_check` tool, the "Practise in the lab" duty, the `lab/` folder and `docs/SECURITY.md`. Git history keeps all of it (last commit with it: `16ceb4a`).
- Kept: the permanent deny list, now used only by the web fetch (the host and VMware's gateways are never reachable).
- `labSubnet` in `settings.nix` is renamed `hostOnlySubnet`. It still decides where SSH is accepted from.
- The store's schema is now version 6: on an existing machine the lab duty is deleted and "Stay up to date" loses its mention of a lab.
- An existing machine keeps `/var/lib/woody-execd/engagement.json` if one was set; nothing reads it any more and it can be deleted.
- Tested in containers: the executor (35 tests), the agent (35 tests, including the schema change on an older store), the HUD build, and the evaluation of the whole system. Not yet rebuilt in the VM.

## Phase 7a results (2026-11-12): spikes for the canvas

Built and run in a container with the VM's own Chromium build (157), headless, then run in the VM.

- **The design under test:** a thing's source is a fragment; the server wraps it in a document it owns and sends it with a policy that forbids every network use; the frame shows it with `sandbox="allow-scripts"`; the bridge is `postMessage`, and the frame page identifies the sender by its window.
- **Isolation:** a hostile thing tried 33 ways out (requests of every kind, navigation, popups, reading the frame page and its token, other things' documents and saved state, forged bridge messages, storage, dialogs, the clipboard). 32 were blocked as designed.
- **One hole found: WebRTC.** A thing could send packets to any address. The policy directive meant to forbid it is not known to this browser. Two fixes each closed it: a browser flag on the kiosk (now in `kiosk.nix`), and removing the WebRTC interfaces from a thing's page before its code runs (needed for the Windows browser, where we do not control the flags). Phase 7c must do both.
- **A thing cannot freeze the screen.** One that burned the processor for three seconds stalled the frame page for 17 ms: sandboxed things run in their own process, whichever site serves them.
- **Things must be served as their own documents.** One injected by the frame page (`srcdoc`) inherits the frame page's strict policy and does not start.
- **Things may be served from the gateway's own address.** Serving them from a second site changed nothing for isolation.
- **The making benchmark** (four models, three requests) works end to end against a stand-in for the API, and what it saved started in the sandbox.
- Added for this and later tests: root can point the kiosk at a local test page (`/run/woody-kiosk-page`).
- **Run in the VM (same day).** Details in `spikes/phase7/README.md`.
  - Frame rate at 1718 by 920: 59 fps with the frame page alone, 65 to 70 with 5, 10 and 20 things, 41 to 47 at the slowest 1%. Adding things costs nothing measurable.
  - Isolation in the kiosk: all 33 ways out blocked, no leak. A thing burning the processor stalled the frame page 22 ms.
  - Making, at low effort: a kit part takes about 1 s with any model. A new coded thing takes Sonnet 5.5 about 8 to 11 s and 1 to 2 cents; Haiku 5.5 5 to 20 s and a fraction of a cent; Opus 5.5 15 to 18 s and 4 to 5 cents; Fable 5.2 21 to 63 s and 9 to 26 cents. All eight things started in the sandbox and worked.
  - Decided from this: things are served by the gateway itself; Sonnet 5.5 is the default maker, Haiku 5.5 for kit parts and small things, Opus 5.5 for a second attempt, Fable 5.2 when asked for.
- Known limit of the test: it cannot see a name lookup (DNS). A thing has no way left to trigger one that we know of, but the kiosk should also get a network rule of its own in 7b.

## Phase 7b results (2026-11-12): the frame

- The three-column HUD is replaced by the frame: a black canvas, the lattice in its corner with its menu (Pause, Stop, the records), the voice line beside it, a typing line that appears when you type anywhere, records that open below the lattice, and the approval prompt above everything. See [HUD.md](HUD.md).
- Everything the old screen showed is a record. Nothing was dropped.
- The source is split: `hud/web/src/frame/` holds the frame. The canvas will sit beside it. Both stay in the locked core until Phase 10 opens the canvas side to Woody.
- The kiosk's browser is sealed from the network twice: it looks up no outside name (a managed browser policy; a command-line flag did the same but showed a warning bar in the VM), and a firewall rule lets the `kiosk` user reach the loopback address only.
- Changed from the plan: the **changes** and **things** records and the **undo** and **mute** entries of the menu are not in 7b. They have nothing to show before the canvas exists, so they come with 7c (undo, changes, things) and Phase 11 (mute).
- A mock of the gateway and the agent is now in the repository (`hud/dev/mock.cjs`).
- Tested:
  - in a browser against the mock: the menu, every record, typing anywhere, the reply appearing beside the lattice, a first boot with nothing said, phone width;
  - the HUD package builds and the system evaluates;
  - the firewall unit builds with NixOS's own ruleset check, and the rule was loaded for real in a container: the kiosk user reached loopback and nothing else;
  - the resolver flag in the VM's Chromium build: an outside site no longer loads, the local page still works.
- Not yet seen in the VM: the frame on the kiosk screen, typing with the French keyboard's dead keys, and the firewall rule on the real system.

## Architecture

Today:

```
Windows host ── VMware
  ├─ NAT network ────────────┐ (internet: Claude API, Nix caches, web reading)
  └─ host-only network ──────┤ (SSH and the HUD for the host's browser)
                             │
  WoodPecker VM (NixOS)      │
  ┌──────────────────────────┴───┐
  │ greetd → cage → Chromium → HUD
  │ woody-hud    gateway: serves the HUD, relays chat, carries approvals
  │ woody-agent  the mind (TS, user woody, no root)
  │ woody-execd  typed actions, approvals, audit, Pause (Rust, root, locked core)
  │ mind.db      event log, memory, goals, journal, identity
  └──────────────────────────────┘
```

What the redesign adds (Phases 7 to 12):

```
  HUD = frame (locked core)             canvas (Woody's)
        lattice, lattice menu,          things: isolated live programs
        typing line, voice line,        ├─ bridge → time, readings, own state,
        approval prompt, records        │           own files, events to Woody
                                        └─ kit of ready parts, house style
  woody-agent  + canvas tools, inner state, interests, own budget share
  woody-hud    + thing store, layout, change log and undo, pin enforcement
  woody-execd  + open web reading with a block list, picture store
  later        + speech engine, program display relay
```

### Components

- **`woody-execd` (Rust, root, the locked core).** Typed actions from a fixed catalog with tiers; approvals on a separate socket bound to the exact action; hash-chained append-only audit; Pause; read-only web fetch; self-modification with snapshot, trial and rollback. See [EXECUTOR.md](EXECUTOR.md) and [SELFMOD.md](SELFMOD.md).
- **`woody-agent` (TypeScript, Claude Agent SDK, user `woody`).** The loop over one event queue, the store, memory, goals, reflection, the pacer. See [MIND.md](MIND.md) and [AGENT.md](AGENT.md).
- **HUD (React, TypeScript).** Today the three-column screen of [HUD.md](HUD.md). From Phase 7: a small locked frame and Woody's canvas.
- **Things (from Phase 7).** Small live programs made by Woody, each in a sandboxed frame with no network, stored with their versions in Woody's storage outside the system image.

### Networking

- NAT network: outgoing only. The firewall accepts nothing from it.
- Host-only network: SSH from the subnet, and the HUD over HTTPS for the Windows host's address only.
- Web reading goes through the executor, which refuses private addresses, the host and VMware's gateways.

## The phases to come

Each phase ends with a test in the VM by the operator. Details of the design are in [VISION.md](VISION.md).

### Phase 7: the canvas

The body. After this phase, "show me a clock that runs backwards" works.

- **7a. Spikes (throwaway).**
  - Frame rate of the software-rendered kiosk with 5, 10 and 20 sandboxed things, one of them animated.
  - The isolation of a thing: it cannot use the network, read the access token, reach the frame or navigate the page.
  - Time and cost to make a thing with each model: a kit part, a small coded thing, a complex one.
- **7b. The frame.** Built: see "Phase 7b results".
  - Split `hud/` into the frame (stays in the locked core) and the canvas (Woody's).
  - The lattice in its corner with its menu: Stop, Pause, the records.
  - The typing line and the voice line.
  - The approval prompt on the frame's own layer.
  - Today's panels become the records behind the lattice.
- **7c. Things.**
  - A store for things with every version kept, in Woody's storage.
  - The sandboxed frame and the bridge: time, machine readings, a thing's own state and files, events to Woody.
  - The layout, saved and shared by both doors.
  - Direct handling: move, resize, pin, close, view source, ask why.
  - The change log with one-step undo. Pinning is enforced by the gateway.
  - Two new records, changes and things, and undo in the lattice menu.
  - The WebRTC interfaces removed from a thing's page (found by the 7a spike).
- **7d. Making.**
  - Woody's canvas tools: make, change, place, remove, look.
  - The hidden test load before a thing is shown; a placeholder while it is made.
  - The first kit: text, note, list, table, chart, clock, meter, picture, buttons, input.
  - The model chosen per task.
  - The pretend mark.
- **Done when:**
  - a backwards clock appears within seconds of asking, keeps running while Woody is paused, and is still there after a reboot;
  - asking changes it, and undo brings the previous version back;
  - a pinned thing cannot be changed by Woody (refused by the gateway and recorded);
  - a thing that tries the network, the token or the frame fails, and the attempt changes nothing;
  - a thing that does not start is never shown;
  - the VM's screen and the Windows browser show the same canvas;
  - every record of today's HUD is reachable from the lattice.

### Phase 8: somebody home

The inner life. After this phase, Woody does things nobody asked for and can say why.

- **Inner state:** energy, ease, curiosity, attention to you and unease, computed by code from real events; given to Woody as context; shown by the lattice; "why?" answers with the causes.
- **The lattice as Woody's own:** its states, moments and expressions become data Woody can redesign, with the reserved signals drawn by the frame.
- **Own life:** the interests list; the budget share (the cap goes to $100, about a quarter Woody's); its own projects; things left for you, each with a note; a daily limit on uninvited additions; the daily rhythm with sleep.
- **Initiative and noticing:** Woody changes the canvas on its own, with a reason for each change; your handling of the canvas becomes events, digested into inferred memories.
- **Disagreement:** the negotiation rule in Woody's instructions.
- **Identity:** Woody rewrites it after reflection in small steps; you are told; versions, the first one kept as an anchor, restore in one action.
- **Done when:**
  - after two days with no requests, the canvas has changed in ways Woody can explain from the record, within its share of the budget;
  - a day on which Woody chose to do nothing is recorded as that;
  - "why are you like this today?" returns causes that match the event log;
  - an identity change happened by itself, was announced, and was restored by you in one action;
  - pinned things were never touched;
  - nothing Woody said or showed reproaches you for absence.

### Phase 9: learning and showing

- **Open reading:** the executor's allow-list becomes a block list; any public site may be read through the quarantined reader. This is a change to the locked core, approved by the operator. With it, the fetch user gets its own firewall rule (it may reach public addresses on port 443 only).
- **Studies:** a subject to learn becomes a dossier of notes with their sources, built over reading sessions.
- **Explainers:** in a later session, from the notes, Woody builds a thing that explains what it understood, with its sources listed.
- **Web pictures:** fetched by the executor into a local store, type and size checked, re-encoded, shown with their source.
- **Done when:**
  - "learn about a subject and show me" ends with an explainer on the canvas that names its sources;
  - the poison test still passes: a page cannot create a preference, a method, a rule or an identity change, and cannot trigger an action;
  - a blocked site, a private address and the host are refused and recorded.

### Phase 10: reshaping itself

- **Methods and instructions as data:** how Woody works becomes versioned records it can revise without a rebuild.
- **Free change of its own program:** on its own initiative, through the existing snapshot, build, trial, health check and rollback; a daily limit on rebuilds; never from a session that read the web.
- **One-step undo** of any such change from the changes record.
- **Its own tools:** Woody can add typed tools for itself through the same flow.
- **Done when:**
  - Woody improved something in its own program unasked, the change was tested, applied and recorded, and you undid it in one step;
  - a change that touches the locked core still waited for you;
  - a change that broke the health check rolled back by itself.

### Phase 11: sound and voice

- **Spike:** sound from the kiosk browser through VMware to the host's speakers.
- **Sound for things:** the bridge plays synthesized sound in the frame; mute and quiet hours are enforced by the frame.
- **Speech:** a speech engine in the VM; Woody speaks a reply when it chooses or when asked.
- **Done when:** a thing plays a tune Woody wrote; mute silences everything at once; Woody says a reply aloud; nothing sounds during quiet hours.

### Phase 12: programs on the canvas

- **Spike:** how to show a program's picture inside a thing (a hidden display relayed to the browser), and how it performs under software rendering.
- **Programs as things:** a program runs under its own unprivileged user; Woody opens, places and closes it; you use it with mouse and keyboard.
- **Done when:** a file manager and a text editor are usable inside things on the canvas.

## Verification

- **Rollback:** a deliberately broken rebuild reverts by itself; the previous generation boots; a Btrfs snapshot restores a deleted file.
- **Privilege split:** as user `woody`, writing `/etc`, calling `sudo` and reaching the approval socket all fail.
- **Audit:** the hash chain verifies; tampering with a line is detected; `woody` cannot truncate the file.
- **Continuity:** the eight tests in MIND.md (cold start, kill mid-goal, long gap, correction, honest gap, poison, rollback, delete).
- **Unattended safety:** with nobody at the HUD, an approval-tier action waits and never runs; Pause blocks every non-read action at the executor; a web page cannot trigger an action or create a preference.
- **Budget:** a flood of events stays under the daily allowance and stops cleanly.
- **Canvas (from Phase 7):** the "done when" lists above are the tests. The isolation and pinning checks are automated; the rest is done by hand in the VM.

## Open items

- Move the API key to sops-nix (it sits in a root-only file).
- Approval requests are held in the executor's memory and are lost if it restarts.
- Whether the subscription token can replace the API key for a long-running service.
- Meaning-based memory search with a local embedding model, if full-text search proves too weak.
- Helper workers running in parallel under the mind.
- A phone notification that carries no content.
- An Xorg-based kiosk as the route to real graphics acceleration. The canvas makes this more valuable: animation is limited by software rendering today.
- Which speech engine and which program-relay method to use: decided by the spikes of Phases 11 and 12.
