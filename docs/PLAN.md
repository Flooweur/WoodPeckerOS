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
| 7 | **The canvas**: the frame, things, the kit, making | Done (7a to 7d), tested in the VM |
| 8 | **Somebody home**: inner state, own life, initiative, identity that evolves | 8a (inner state) done, tested in the VM. 8b (a life of its own) and 8c (identity and face) built; they await the VM test |
| 9 | **Learning and showing**: open reading, studies, explainers, web pictures | Built in three steps (9a open reading, 9b studies and explainers, 9c web pictures); awaits the VM test |
| 10 | **Reshaping itself**: free change of its own program | Planned |
| 11 | **Sound and voice** | Planned |
| 12 | **Programs on the canvas** | Planned |
| 13 | **Universal pipes**: outputs of things wired to inputs of things, the machine, Woody and approved actions | Planned (decided 2026-11-12) |
| 14 | **Triggers on meaning**: alerts on what a change means, on pages, things, files and logs | Planned (decided 2026-11-12) |
| 15 | **Mail as a source**: one read-only folder that triggers can watch | Planned (decided 2026-11-12) |

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

## Phase 7c results (2026-11-12): things

- **The store** (`hud/server/canvas.ts`): things, every version of each, the layout, what is pinned, a thing's own saved state, and an append-only record of every change with its undo. Changed from the design: the gateway keeps it, not the agent. Otherwise Woody could write to the files directly and neither pinning nor the record would hold.
- **The rules, enforced by the gateway:** Woody cannot change, move or remove a pinned thing, and the attempt is recorded; only the operator pins, unpins and undoes; no version is ever deleted; a removed thing is kept and can be put back.
- **Serving:** each thing at `/thing/<key>` (an unguessable name), as a sealed document with the WebRTC interfaces removed. The frame page may frame nothing but things and the terminal.
- **The frame's side** (`hud/web/src/canvas/`): things in sandboxed frames; the bridge (ready, saved state, the machine's readings); a band on each thing's top edge that opens into a strip (move, pin, why, close) and a corner grip; a thing is shown only once it says it runs, and is covered if it never does or tries to leave its frame.
- **Two new records,** Things and Changes, and undo in the lattice menu.
- **By hand:** `woody-hud canvas ...` makes, changes, places and removes things the way Woody will, for trying the canvas before 7d.
- Changed while building: the strip first appeared when the pointer was anywhere on a thing. That relied on the pointer being tracked over a sealed frame and would have covered the thing's top row while using it. It is now a band of the frame's own.
- Not in 7c: files in a thing's own folder (only one saved value per thing for now). A thing telling Woody that something happened came with 7d.
- Tested:
  - the store's rules: 7 tests that run in the build;
  - a scripted browser run with the real gateway and the VM's Chromium build, 36 checks: things appear and start; a broken one is not shown; drag, resize, pin, close and undo work and are kept; Woody's attempts on a pinned thing are refused and recorded; a new version reloads; saved state survives a reload; the records show sources, versions, changes and refusals; everything survives a gateway restart;
  - isolation under the real gateway: a hostile thing tried 15 ways out, all blocked, nothing reached a listener, and it could not write another thing's state.
- Limit of that run: the scripted pointer does not enter a sealed frame, so clicking inside a thing was not exercised by pointer there. It was on the VM's screen during the 7a run.
- Not yet seen in the VM.

## Phase 7d results (2026-11-12): making

- **Woody is connected to the canvas.** The gateway opens a connection to the agent's socket; Woody's requests arrive on it and are held to its rules: no pinning, unpinning or undoing, nothing on a pinned thing, and nothing at all while the operator has paused it (the gateway asks the executor).
- **Seven tools** (`agent/src/canvas.ts`): `canvas_look`, `thing_source`, `kit_place`, `thing_make`, `thing_change`, `thing_place`, `thing_remove`.
- **The kit** (`hud/server/kit.ts`): text, note, list, table, chart, clock, meter, picture, buttons, input. A part is written by the gateway from a few values and becomes an ordinary thing. No model is involved.
- **The maker.** Changed from the plan's "Woody writes the code": Woody writes a brief, and a separate model call writes the thing. This keeps code out of Woody's own context, and lets the model fit the job: Haiku 5.5 for small, Sonnet 5.5 by default, Opus 5.5 for hard, Fable 5.2 only when the operator asks for the strongest.
- **The trial on the screen.** A new or changed thing of Woody's is kept only if the frame reports that it started. Otherwise the gateway takes the change back and says why; the maker gets one more attempt by the next stronger model.
- **While it is made,** the voice line says what is being made. There is no placeholder at the thing's future place: the place is only chosen once the thing exists.
- **Events from things** reach Woody as wake-ups (six a minute per thing, sixty an hour in all). They are not operator messages.
- A session that has read the web cannot change the canvas.
- Found by the scripted check: a form never submits inside a sealed frame. The kit's input uses a button and the Enter key instead, and the maker is told.
- Not done:
  - the maker's cost is added to the monthly total but not to a goal's own budget;
  - the maker runs at the model's default effort, which may be slower than the Phase 7a measurements (those were at low effort);
  - Woody acting on the canvas on its own (Phase 8).
- Tested:
  - the gateway's rules: 11 tests in the build (the store, taking back a change that does not start, the kit and its refusals);
  - the agent's side: 8 more tests in the build (43 in all): the link, the choice of model, the second attempt, refusals that are final;
  - the scripted browser check with the real gateway and the VM's Chromium, with the script playing Woody on the link: 61 checks. Every kit part starts on the screen; a thing that does not start is refused and the canvas is as before; a failed change returns to the earlier version; Pause refuses; a pinned thing refuses; a button and a typed line reach Woody; a flood of events is cut at six.
- Not tested: anything with a real model. The first real thing Woody makes will be in the VM.

## Phase 8a results (2026-11-12): inner state

- **Five values** (`agent/src/mind/inner.ts`): energy, ease, curiosity, attention to the operator, unease. Each is a plain function of the record of the last two days (sessions, tool results, messages, wake-ups, canvas changes), the allowance, failed services and when someone was last at the screen. Each keeps the list of its causes. No model is involved and nothing is random.
- **What moves them:**
  - energy: the allowance left, work done in the last six hours, rest, the night;
  - ease: sessions that stopped early, failed tool calls, refusals, a thing that did not start, things you removed or changes you undid (down); thanks, things you pinned, work that went through (up). Trouble fades by half every twelve hours;
  - curiosity: what was learned and read (up), wake-ups with nothing to do (down);
  - attention: how recently you were at the screen. Your absence moves this value only: it never makes Woody uneasy or rattled, which a test fixes;
  - unease: failed services, the model API refusing, the system waking Woody for a problem, things waiting for your decision.
- **Woody is told** its state at the start of every session, with the causes, and told how to carry it: it shapes tone and how much it takes on, it is not announced unprompted and never used to press you.
- **The true "why":** a tool, `inner_state`, returns the values and causes. Asked how it is, Woody answers from it.
- **You can see it:** the Machine record shows the five values and their causes. The lattice's ongoing state moves quicker when Woody is fresh and slower when it is tired; states that need you never change their look.
- **Woody is told what changes on the canvas,** its own changes and yours (pinned, moved, removed, undone), as a record and never as a wake-up. This feeds ease now and noticing in 8b.
- **Disagreement:** the negotiation rule is in Woody's instructions, with the rule that it never appears to comply while doing something else.
- Not in 8a: the values do not yet change what Woody does on its own (there is no initiative before 8b), and the lattice only changes pace (its states become Woody's to redesign in 8c).
- Tested: 7 tests of the inner state in the build (50 agent tests in all); the scripted browser check now also verifies that Woody is told of each canvas change once and in order (67 checks). The Machine record was looked at in a browser against the mock.
- Tested in the VM by the operator on 2026-11-12.

## Phase 8b results (2026-11-12): a life of its own

- **Time of its own.** When nothing is asked of Woody (no message, no event, no goal to work on), plain code decides whether it takes a moment of its own (`agent/src/mind/life.ts`). The inner state decides with it: tired, it rests; rattled, it waits twice as long; curious, it comes back sooner. Each decision keeps its reason, shown in the record "Its own life".
  - At most six moments a day, about two hours apart, each limited to $0.40. Never while you are talking with it (ten minutes after your last message), never while paused.
  - A moment is a session of its own kind: it is told its interests, its canvas, how you handled the canvas lately and what it may spend, and that doing nothing is allowed. It runs on Sonnet 5.5 whatever model you chose for the conversation.
  - It may look at the machine but not change it. It does not write to you: what it says at the end goes to its journal. If something is for you, it is a thing with a note.
- **Its share of the budget.** The monthly cap is now $100 (`monthlyCapUsd`), and a quarter of it is Woody's own (`ownShare = 0.25`): $25 a month, released day by day like the rest. Its own time spends only from that share, and the maker's calls in that time too. It is a ceiling on what Woody spends for itself, not a reserve: answering you always comes first, and when your work has used the day's pace, Woody's own time waits.
- **Interests.** A list of what Woody is curious about, each with where the curiosity came from (`interest_add`, `interest_list`, `interest_note`, `interest_drop`). At most twelve open. You see the list, can suggest an interest and can remove one. A session that has read the web cannot add or drop an interest; a note it takes is kept, labelled as coming from the web.
- **Things left for you, with a note.** What Woody adds to the canvas without having been asked is marked as such by the gateway. A thing left for you must carry a note saying what it is and why; the frame shows the note under the thing until you have read it, and it stays in the thing's record.
- **The daily limit.** At most three uninvited additions a day (your setting, 0 to 20, in "Its own life"). The gateway counts and refuses; Woody cannot change the setting. A thing that did not start does not count. What you ask for is never limited. Woody asks the canvas before the maker is paid, so a refusal costs nothing.
- **The rhythm.** Woody's day runs from 07:00 to 23:00 by default (`dayStart`, `nightStart`, or from the HUD). In the last two hours of the day, its first moment is the evening tidy of the canvas. At night it sleeps: no time of its own and no standing duties. It stays awake while you were at the screen in the last half hour, and your messages and the goals you accepted are worked on at any hour. The lattice shows it asleep. The daily reflection belongs to the middle of the night (03:00 with the default hours), or to the first moment after it if the machine was off.
- **The day's end.** When the night begins, what Woody did with its own time is written in its journal by plain code. A day on which it took no time, or let every moment pass, is recorded as that, with the reason.
- **Noticing.** The record of how you handled the canvas (what you pinned, moved and where, took away, undid) is given to Woody in its own time and in its reflection. From a pattern it may store a conclusion about your taste, as a fact it inferred, never as your preference. The next brief tells you what it concluded so that you can correct it.
- **The inner state** now reads the night from the rhythm, and curiosity rises with interests followed. Having something it left on its own taken away weighs on ease more than an ordinary removal.
- **The cost of the maker and the web reader** during a goal's session now counts against that goal's budget (an open item since 7d).
- **Known limit.** The gateway learns from the agent whether a request was asked for by you. The agent is not something Woody can change today; before Phase 10 opens the agent's program to free change, that judgement must move to the gateway.
- Tested: 11 tests of the rhythm, the decision, the share, the interests, the digest and the prompts (61 agent tests in all); a test of the daily limit and the note in the gateway (12); the scripted browser check now covers the note on the screen, the limit, and what Woody is told (80 checks). The record "Its own life" was looked at in a browser against the mock.
- Not tested: what a real model does with a moment of its own, and whether three additions a day and two hours between moments feel right. That is for the VM.

## Phase 8c results (2026-11-12): identity and face

Decided with the operator before building: one identity change a day of at most a quarter of the words; a notice by the lattice; a pause once less than half of the first version remains; Woody may redraw designs and invent expressions; it may show an expression when it chooses; a small palette without red; designs as flip books.

- **Identity.** `identity_change` replaces `identity_propose`. It works only during the daily reflection, takes effect without approval, and is bounded by code: the step size, one a day, the pause when far from the first version, three quiet days after you restore or rewrite the text, and never from a session that read the web. You get a notice by the lattice, the before and the after with the changed words marked, the reason, and one button to put the earlier version back. A switch turns Woody's own changes off.
- **Face.** The lattice's designs are versioned data in the mind's store. Woody redraws them with `face_design` as flip books of up to 16 pictures, invents up to 12 expressions, and shows one with `express`. The record "Its face" shows all of them and restores any.
- **The frame's signals stay the frame's.** Waiting, paused, model unreachable, out of allowance, the hour's ceiling, a problem and the web wall are drawn by the frame whatever Woody's data says, and red is refused in a design. The frame checks every design again before drawing it.
- **Schema 8** of the mind's store: the `face` table, and who wrote each identity version.
- **Tests:** 70 agent tests (9 new), 12 gateway tests, and 99 scripted browser checks (19 new) pass in containers; the Nix builds succeed. Both records were looked at in a browser against the mock.
- **Not tested:** what a real model does with its identity and its lattice. Whether a quarter of the words is the right step can only be judged over days in the VM.
- **Not in 8c:** the lattice's colour does not follow the inner state by itself. Woody is told its inner state and chooses colours in its own designs.

## Phase 9a results (2026-11-12): open reading

Decided with the operator before building, for the whole of Phase 9:

| Question | Decision |
|---|---|
| What the block list holds | Your own list, empty at the start. No public malware list |
| What a session may fetch once it has read the web | Only addresses that code found in the pages and search results it was given |
| robots.txt | Not followed. Woody reads under its own name, slowly, with an hourly ceiling |
| Who starts a study | You, and Woody itself from its interests with its own share |
| Size of a study | $1.50 and five reading sessions by default, settable for each study |
| Pictures | A separate model that cannot act describes a picture to Woody; Woody never sees it |
| An explainer's sources | Listed by the frame from the record of pages actually fetched |

Built in 9a (a change to the locked core, which you apply by rebuilding):

- **The block list replaces the allow-list.** `web.fetch` reads any public site that is not on `/var/lib/woody-execd/web-block.json`. Blocking a name blocks everything under it. Only you edit the list: in the HUD ("Blocked sites") or with `woodyctl web-block`. Woody has no action that changes it. The old allow-list file is deleted at the next start of the executor.
- **Redirects are followed** by the executor, three at most, and each hop passes the same checks as the first address: https, a named host, not blocked, a public address, the connection pinned to it.
- **Pacing in the executor:** one second between two requests to the same host, and 120 requests an hour.
- **A firewall rule for the fetch user:** whatever runs as `woody-web` reaches public addresses on port 443 and nothing else. It is the second barrier behind the executor's own address check.
- **Links only after reading.** Once a session has read a page or a search result, `web_fetch` accepts only addresses that code extracted from what it was given. The reader is shown the page's links and may point Woody to up to six of them.
- **Addresses are cleaned from lasting text.** In such a session, an address it was not given is removed from memories, interest notes, goal checkpoints and goal proposals.
- **Tests:** 37 executor tests (block list, redirect targets, pacing), 76 agent tests (6 new), the firewall rules pass the system's build-time check, and the Nix builds succeed.
- **Not tested:** a real fetch through the new firewall rule, and redirects against real sites. Both need the VM.
- **Known limits:**
  - The links-only rule is enforced by the agent, which is Woody's own program. Like the "uninvited" mark, it must move behind the executor before Phase 10 lets Woody change that program.
  - A search query is still written by Woody, so a fooled session could put private data into a query. It goes to the search provider, not to the page's author.
  - Cleaning removes addresses with `http://` or `https://` in front. A session could still note a bare host name in words.

## Phase 9b results (2026-11-12): studies and explainers

- **A study** is a subject Woody learns over several reading sessions and then explains with a thing on the canvas. You start one by asking ("learn about tides and show me") or from the new **Studies** record; Woody may start one of its own from an interest, in its own time and from its own share, one at a time.
- **Sizes:** small ($0.50, 2 reading sessions), medium ($1.50, 5; the default) and large ($4, 10). You can give a study more from its record, or drop it.
- **Sessions are started by plain code**, one after the other: reading sessions, then one session that builds the explainer. Reading stops when Woody says it has read enough, when the sessions are used, or when 70% of the budget is spent. An explainer that cannot be built is given up after two tries; the findings are kept.
- **Reading sessions** search and read under the rules of 9a and write down findings (`study_note`). They say nothing to you. **The explainer session** starts from the findings, has not read the web, and builds the thing; for a study you asked for, it tells you in the conversation when it is done.
- **Sources are the frame's.** Each page fetched in a reading session is recorded by code at the moment of the fetch. When the explainer is made, that list is handed to the canvas with it, and the frame shows "sources · N" on the thing and the full list in its record. Woody does not write the list.
- **Schema 10** of the mind's store: `studies`, `study_notes`, `study_pages`.
- **Tests:** 82 agent tests (6 new), 13 gateway tests (1 new) and 107 scripted browser checks (8 new) pass in containers; the Nix builds succeed.
- **Not tested:** a real study. What a model reads, how good its findings are and whether the explainer teaches can only be seen in the VM.
- **Known limits:**
  - The list of sources is handed over by the agent, which is Woody's own program. As with the other agent-side rules, this must be settled before Phase 10.
  - The explainer contains what Woody understood. The reader and Woody can both be wrong; the sources are there so that you can check.
  - A study you asked for runs at any hour and back to back, bounded by its budget and by the ceiling of twelve sessions an hour.

## Phase 9c results (2026-11-12): pictures from the web

- **`web.picture`** is a new executor action (a change to the locked core). It fetches a picture under the same rules as a page, accepts only JPEG, PNG, GIF and WebP (the server's word and the file's first bytes must agree; SVG is refused, since it is a program), and has it decoded and written out again as WebP: pixels only, no metadata, 1280 pixels a side at most.
- **The converter** is libvips (`vipsthumbnail`), run as the user with no rights (`woody-web`) in a directory of its own, with limits on memory (3 GB of address space), processor time (15 s), output size and wall time (20 s).
- **Woody never sees a picture.** `web_picture` hands it to a reader model that cannot act, which says in words what it shows. Woody gets that description and an id.
- **The canvas keeps the picture** with the address it came from (200 at most; the oldest one no thing shows makes room). The name of a picture is the fingerprint of its bytes, and the canvas checks it.
- **A thing is given pictures by their id** when it is made or changed. It loads them through the bridge (`woody.picture(id)`); the gateway hands a thing only the pictures it was given. Things still load nothing from the network.
- **The frame shows the source.** "sources · N" on a thing now counts its pictures too, and the thing's record lists where each picture came from.
- **The reader may point to pictures** on a page it reads, by what the page says about them. Their addresses count as given, so a reading session can fetch them.
- **Tests:** 39 executor tests (2 new), 84 agent tests (2 new), 14 gateway tests (1 new) and 116 scripted browser checks (9 new) pass in containers. The converter was run in the container with its real limits on a real picture; the Nix builds succeed.
- **Not tested:** a real `web.picture` call from fetch to canvas, the reader's descriptions, and how good Woody's choice of pictures is. All need the VM.
- **Known limits:**
  - The system now includes libvips, which adds to the size of a rebuild.
  - Re-encoding removes what is hidden in a file, not what a picture shows. A misleading or unpleasant picture is still a picture; the reader is asked to say so, and you can remove the thing.
  - Animated pictures become their first frame.
  - Pictures are for showing on your own screen. Nothing here judges whether a picture may be reused elsewhere.
- **Also fixed:** the executor's tests now run one at a time in the build. Run in parallel, one of them failed now and then with "Text file busy".

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
- **Things (from Phase 7).** Small live programs made by Woody, each in a sandboxed frame with no network, kept with their versions by the HUD gateway outside the system image.

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
- **7c. Things.** Built: see "Phase 7c results".
  - A store for things with every version kept, held by the gateway.
  - The sandboxed frame and the bridge: time, machine readings, a thing's own state and files, events to Woody.
  - The layout, saved and shared by both doors.
  - Direct handling: move, resize, pin, close, view source, ask why.
  - The change log with one-step undo. Pinning is enforced by the gateway.
  - Two new records, changes and things, and undo in the lattice menu.
  - The WebRTC interfaces removed from a thing's page (found by the 7a spike).
- **7d. Making.** Built: see "Phase 7d results".
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

Built in three steps:

- **8a. Inner state.** Built: see "Phase 8a results". The five values, what Woody is told, the true "why", the lattice's pace, the negotiation rule, and Woody being told what changes on the canvas.
- **8b. A life of its own.** Built: see "Phase 8b results". The interests list, the budget share (the cap is $100), time of its own, things left for you with a note, a daily limit, the rhythm of day and night, and noticing how you use the canvas.
- **8c. Identity and face.** Built: see "Phase 8c results". The identity that evolves by small steps with versions and restore, and the lattice's states, moments and expressions as data Woody can redraw.

The whole of it:

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

Built in three steps: 9a open reading (built: see "Phase 9a results"), 9b studies and explainers (built: see "Phase 9b results"), 9c web pictures (built: see "Phase 9c results").

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

### Phases 13 to 15: pipes, triggers on meaning, mail

Discussed with the operator on 2026-11-12, after Phase 9. Three ideas were on the table: universal pipes, triggers on meaning, and disposable tools. Disposable tools were dropped by the operator during the discussion. The other two go at the end of the roadmap, pipes first.

**What the two share.** Today a thing can save its own state, read the machine's meters and tell Woody that something happened. It has no inputs and no outputs. Both ideas need **ports**: named inputs and outputs, carried by the frame. A pipe is an output wired to an input. A trigger is a source, a stage where a model judges what a change means, and "tell the operator" as the end.

**Where the rules must live.** These phases come after Phase 10, when Woody can change its own program. So nothing in them may be enforced by the agent: routing, limits and the pinned rule belong to the gateway, standing approvals to the executor.

Decisions:

| Question | Decision |
|---|---|
| What may be at the ends of a pipe | Things, the machine's feeds (meters, logs, service states, the clock), files, Woody (a pipe that wakes it), the operator (a notice), and actions on the system |
| A model inside a pipe | Allowed where code alone cannot make two ends fit. Marked on the canvas, runs only when the value changes, with its own budget |
| Piping a pinned thing | The operator's own drag is permission for that one change, recorded and undoable. The thing stays pinned otherwise |
| How pipes are shown | Faint lines, always, drawn by the frame; brighter for a moment when a value passes |
| A port the thing does not have yet | The pipe appears at once as a dashed line with the words typed; it becomes solid when both ends work, or says why it cannot be done |
| Woody's own pipes | Anywhere on the canvas except pinned things, counted against its daily limit of unasked changes. An action pipe always needs the operator |
| How an action pipe may act | Approved once, as a standing rule, on the approval channel. The approval shows the action with all its values and the most runs a day |
| What may feed an action pipe | Only the machine's own readings (meters, service states, the clock) or a thing the operator made, through plain code. Nothing that came from the web, from a file or from mail, and nothing that passed through a model stage. Such content can still reach a thing or raise an alert |
| What the pipe decides | Only when the action runs. The action and all its values are fixed when the pipe is approved |
| Which actions a pipe may run | Starting, stopping and restarting services under the standing approval. A configuration change raised by a pipe waits for a yes each time. The locked core and the services that can never be touched stay out of reach |
| Sources a trigger can watch | Web pages, things and files, the machine's logs and state, mail |
| When a trigger is unsure | It goes in the daily brief, not in an alert. Every check is kept in a record |
| When a trigger fires | The operator is told, with what changed, the passage that decided it and why it matters. They can answer "worth it" or "not worth it" |
| Woody's own triggers | Allowed, paid from its own share. They wake Woody in its own time, and may alert the operator when Woody judges they would want to know, counted like things it leaves unasked |
| Running cost | Each trigger and each model stage has its own monthly budget (50 cents by default), shown. When it is used up it stops until the next month and says so |
| Reaching the operator when away | The alert waits on the screen and in the daily brief. A phone notification is not part of these phases |
| How much mail Woody may read | One folder or label the operator chooses, read-only. Never the rest of the mailbox; never send, delete or mark |

Action pipes keep principle 7 ("untrusted content can inform, never instruct") whole. During the discussion the operator first chose to let web content feed an approved action pipe and supply its values, then took the recommendation back up the same day: what a stranger wrote never reaches an action. The gateway knows where each value in a pipe came from, and refuses to connect an action to anything that is not the machine's own reading or the operator's own thing.

#### Phase 13: universal pipes

The largest phase since the canvas. Four steps.

- **13a. Ports and plain pipes.**
  - A thing declares its outputs and inputs when it is made: a name, a kind (number, text, list, record, picture, event) and a sentence. The bridge gains `woody.output(name, value)` and `woody.input(name, fn)`.
  - The gateway carries values, keeps the last one for each pipe, and limits size and rate. A loop of pipes is refused or slowed.
  - The kit's parts get ports. The machine's feeds become sources.
  - The frame draws the lines. A **Pipes** record lists each pipe with its ends, when a value last passed, a switch and undo.
- **13b. Making a pipe by hand, and in words.**
  - Drag from a thing, choose or type what comes out, drop on another thing, choose or type what it feeds.
  - Each thing offers suggestions. A typed port that does not exist yet makes Woody have the thing changed to provide it, and write a small adapter when the two kinds differ. The adapter is code in a sandbox, written once.
  - Woody gets tools to make and remove pipes.
- **13c. Meaning in a pipe.** A model stage with no tools, for what code cannot do ("the mood of this text" into a colour). It runs on change only, within its budget, and is drawn differently.
- **13d. Action pipes.** Standing approvals in the executor (a change to the locked core): the approval names the action, all its values and the daily cap. The gateway marks every value with where it came from, and an action accepts only the machine's own readings and the operator's own things.
- **Spikes first:**
  - Whether a reader model can locate a region of a picture well enough ("the face of the dog"). Woody never sees pictures, so a pipe like the operator's example rests on this.
  - How many lines the software-rendered screen draws without slowing things down.
- **Risks:**
  - "Anything into anything" will sometimes be impossible or wrong. A pipe that cannot be made must say so plainly, and a pipe that works must be testable by looking at the value that passes.
  - A model stage makes a pipe slower, costlier and not repeatable. Hence code by default.
  - An action pipe is an automation that runs with nobody watching. Hence the one-time approval, the fixed values, the daily cap and the switch.
- **Done when:**
  - the dog's face becomes the clock's background by one drag and two typed phrases, or Woody says why it cannot;
  - a pipe between two kit parts works with no model call at all;
  - a pipe to a pinned thing changed it once, with an undo;
  - a model stage stopped when its budget was used and said so;
  - an approved action pipe restarted a service within its cap, each run is in the audit log, and switching it off stopped it;
  - a pipe fed by web content, by a file or through a model stage could not be connected to an action at all;
  - a configuration change raised by a pipe waited for a yes.

#### Phase 14: triggers on meaning

Ordinary watchers react to bytes. A trigger reacts to what a change means for the operator. Three steps.

- **How one check goes:**
  1. Look at the source.
  2. Compare with what was seen last time, by plain code. No change means no model call.
  3. A judge model with no tools reads the change, the operator's sentence and what Woody knows of them that is relevant. It answers: clearly yes, clearly no, or unsure, with the passage that decided it.
  4. Yes raises a notice by the lattice. Unsure goes in the daily brief. No is only recorded.
- **Auditing the silence.** No tool of this kind publishes how many changes it wrongly keeps quiet about, and that rate cannot be known in advance here either. So each trigger keeps its record (looked 212 times, changed 14, alerted 2), and every change it stayed silent about can be read there. The operator's "worth it" and "not worth it" are kept with the trigger as examples, in their words.
- **14a. Pages.** Fetched on a schedule under the rules of Phase 9a.
- **14b. Things and files,** through the ports of Phase 13.
- **14c. Logs and the machine's state,** including "like last Tuesday": the operator or Woody marks a stretch of time as an episode, and it is kept as a reference to compare against. This needs a spike: a judge reading a summary of the episode, or a small local model that measures likeness.
- **Safety:**
  - What a trigger reads is untrusted, and the judge cannot act.
  - An alert shows the source's words as quotations, and addresses follow the links rule of Phase 9a.
  - A trigger that fires never starts a session that can act.
- **Done when:**
  - a page changed five times in ways that do not matter and once in a way that does, and the operator got one alert with the passage;
  - an unsure case appeared in the daily brief and nowhere else;
  - the record showed every check and every silence;
  - a "not worth it" changed what the trigger alerted on afterwards;
  - a trigger stopped when its budget was used and said so;
  - Woody set a trigger of its own from its share, and one alert of its own counted against its daily limit.

#### Phase 15: mail as a source

"When the contractor's reply sounds like a delay." A phase of its own, because mail is private and is written by strangers.

- **Reading:** the executor reads one folder or label over an encrypted connection, as a user with no rights. The credential sits in a root-only file. There is no action that sends, deletes or marks.
- **Quarantine:** a message is read by the judge model with no tools, like a web page. Woody gets the verdict and a short quotation, not the mail.
- **Open questions, to settle when the phase starts:**
  - which mail provider, and how Woody signs in (an application password or the provider's own sign-in);
  - whether attachments are read (not at first);
  - how long anything from a message is kept (the verdict and the quotation only).
- **To know:** what the judge reads is sent to the model provider.
- **Done when:** a reply in the chosen folder that announces a delay in polite words raised an alert, a reply that confirms the date did not, and nothing outside that folder was ever read.

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
