# WoodPecker-OS: history

What was built, phase by phase, and designs that were later replaced. This file is a record: it describes each step as it was when it was finished, and later steps changed some of it. For how the system works today, read [ARCHITECTURE.md](ARCHITECTURE.md), [MIND.md](MIND.md) and [HUD.md](HUD.md). For what comes next, read [PLAN.md](PLAN.md) and [REVIEW.md](REVIEW.md).

## The phases, as each was finished

### Phase 0 results (2026-11-11)

- **Kiosk graphics:** GPU-accelerated Chromium under cage does not work on VMware (`vmwgfx` rejects Chromium's dmabuf buffers). The working setup is cage with `WLR_RENDERER=pixman` (software). Measured 28 fps at 3238×1193 and about 55 fps at a smaller window. Consequences: the HUD ships with a low-effects mode as default and effects as an opt-in; the kiosk uses Chromium `--app=` mode because `--kiosk` left the browser bars visible. An Xorg-based kiosk is the untested route to real GPU acceleration, kept as an optional later experiment.
- **Agent SDK as a service:** works as an unprivileged user under the full planned systemd hardening, with nix-ld, using an API key.
- **Auth decision changed:** API key only for now. The subscription path was not tested and is deferred.
- **Cost finding:** the SDK defaults to `claude-opus-5-5`; a one-line reply cost $0.073, nearly all from caching the default ~14.5k-token system prompt. Phase 2 must set the model per task (cheap model for triage and routines), keep the prompt cache warm, and meter interactive chat as well as background work, since both now bill to the API key. The $50/month figure covered background use only and needs a second number for chat.

### Phase 1 results (2026-11-11)

- Installed from the flake with disko (Btrfs subvolumes, hybrid BIOS/UEFI boot); `flake.lock` generated and validated in the VM.
- Recovery drill passed: failed build leaves the system untouched, runtime breakage rolled back, old generation booted from the menu, file restored from a Btrfs snapshot, VMware snapshot reverted.
- Finding: `nixos-rebuild switch --rollback` fails on a flake-only system. Rollback is `woody-rebuild rollback` (profile rollback + activation, no config evaluation). The Phase 2 executor's auto-rollback must use the same mechanism.
- VMware does not pass AltGr to the VM console; day-to-day work is over SSH from the host-only network.

### Phase 2 results (2026-11-11)

- `woody-execd` (Rust, root): typed action catalog with tiers, approvals on a separate socket bound to the exact action, hash-chained append-only audit log. Verified in the VM.
- `woody-agent` (TypeScript, user `woody`): Claude Agent SDK with no built-in tools, only typed tools that call the executor; model switch; monthly and per-turn spend limits.
- Thin HUD and its gateway (user `woody-hud`): chat, model picker, spend meter, approval prompt. The gateway replaced the planned Caddy routing.
- Not built as planned: `packages/protocol` (shared schemas). The protocol is small and documented in EXECUTOR.md and AGENT.md; revisit when Phase 4 enlarges it.
- The API key sits in a root-only file for now; moving it to sops-nix is still to do.

### Phase 3a results (2026-11-11)

- Observe and operate: processes, services (start, stop and restart need approval; locked-core units are refused), journal search, osquery restricted to 29 tables, files (read `/etc` and `/nix/store`, write only in the workspace), HUD notices.
- Tested in containers and then in the VM.

### Phase 3b results (2026-11-12)

- Woody can change its own NixOS configuration: propose, then apply with snapshot, trial activation, health check, automatic rollback, and a commit in the admin's checkout. Details in [SELFMOD.md](SELFMOD.md).
- The locked core is enforced two ways: a list of locked paths, and a privilege fingerprint of the evaluated system that catches indirect changes.
- Changed from the plan: Woody does not keep a git clone. It sends file contents to the executor, which works on its own root-owned copy. No path supplied by the agent is ever read by root.
- Known limit: the fingerprint is a tripwire, not a proof (see SELFMOD.md).
- Tested in the VM on 2026-11-12, including the apply job.

### Phase 3c results (2026-11-12)

- Screenshots: the executor runs `grim` as the kiosk user; Woody receives the picture and can look at the HUD.
- Clipboard, changed from the plan: the kiosk compositor (`cage`) does not offer the clipboard protocol that `wl-clipboard` needs without stealing the screen. Instead Woody offers text through a HUD notice with a Copy button, and cannot read the clipboard. This also works unchanged when the HUD is opened from the Windows host browser (Phase 5).
- Phase 3 is complete.

### Phase 4a results (2026-11-12)

- The mind's store (`/var/lib/woody/mind.db`): append-only event log, saved conversation, journal, memories with origin, sources and versions, identity. Details at the end of [MIND.md](MIND.md).
- Each turn's context is assembled from the store; the SDK session is only a short-lived working context.
- Chosen: Node's built-in SQLite driver (with full-text search), so no native dependency to package.
- 12 store-level continuity tests run in the build. The model-level tests are done by hand in the VM.

### Phase 4b results (2026-11-12)

- Woody is now a loop over one event queue, with a one-minute pulse, self-set alarms, system events, messages delivered while it works, Stop and Pause, approvals that wait a week, retry-once crash recovery, the spending pacer and a daily copy of the store. Details in [MIND.md](MIND.md).
- Pause is enforced in the executor and was tested live against the built binary.
- Found while building: the SDK delivers queued messages only after the current reply, so mid-work delivery uses a hook that runs between tool calls, with a one-time key so tool output cannot imitate the operator.
- Wake-ups with a real model are untested outside the VM.

### Phase 4c results (2026-11-12)

- The goals board: goals with their own threads, review by Woody (understanding, judgement, plan, estimate, questions), the small-goal rule, acceptance with a budget, checkpoints, stops for budget or lack of progress, proposals, four standing duties, and plain HUD views for inbox, goals and journal. Details in [MIND.md](MIND.md).
- Added beyond the design: an observe-only mode, enforced in the tool layer, for everything Woody does on its own without a plan the operator accepted.
- The rule that decides what may start is code in the store; the model only supplies the review.
- A goal handled end to end by a real model is untested outside the VM.

### Phase 4d results (2026-11-12)

- Daily reflection (store, merge, correct, optionally propose an identity change), identity versions with operator approval, the daily brief and the catch-up on return. Details in [MIND.md](MIND.md).
- Changed from the design: "on arrival" cannot be detected from a connection, because the kiosk HUD is always connected. The HUD sends a sign of life on key presses and clicks instead.
- A real reflection, brief and catch-up are untested outside the VM.

### Phase 4e results (2026-11-12)

- Read-only web access: an allow-listed, pinned, redirect-free fetch in the executor; search and reading done by a quarantined model with no way to act; sessions that read the web restricted to observing and taking notes; web-origin memory. "Stay up to date" is on. Details in [MIND.md](MIND.md).
- The fetch was tested live against the built executor. Search and the reader need the API and are untested outside the VM.
- Phase 4 is complete in code.

### Phase 5a results (2026-11-12)

- The design was drafted on a canvas and chosen by the operator: three columns, notched amber panels, one shape per kind of event, and an 8 by 8 lattice as the mind panel, with a chosen animation for each state and moment and ten expressions.
- Built: the presence bar, the three columns, the conversation on a time spine, the panels for a goal, a new goal, the journal, memory, identity and settings, the activity stream and the machine meters. See [HUD.md](HUD.md).
- The gateway now reads the machine meters itself; the agent sends an activity list and the events behind the expressions.
- Checked in a browser against sample data. Not yet seen in the VM's kiosk.

### Phase 5b results (2026-11-12)

- Log view and web allow-list view in the HUD; the allow-list can also be edited with `woodyctl`.
- Terminal on the VM's own screen only: `ttyd` running `login` on a local socket, relayed by the gateway to the kiosk door and never to the host door. Screenshots are refused while it is open.
- Host access: HTTPS on port 7843, open only to the Windows host's address, behind a password and a session cookie, with a lock after five wrong passwords.
- Login at boot on the VM's screen (`tuigreet`, signing in as `kiosk`), switchable in `settings.nix`.
- Tested live in a container with a real `ttyd`: 29 checks on both doors and the terminal relay. The login screen, the certificate generation and the firewall rule are untested outside the VM.
- Phase 5 is complete in code.

### Phase 6 results (2026-11-12): change of goal

- The goal became "a computer that is alive". It was settled with the operator in 23 questions after a review of what exists (generated interfaces, malleable software, always-on agents, companion design, science fiction). The result is [VISION.md](VISION.md).
- Removed from the code: engagements and the scope engine in the executor, the `scope.check` action, the kernel filter and the `woody-tools` user, `woody-isolation-test`, the SCOPE view, the `scope_check` tool, the "Practise in the lab" duty, the `lab/` folder and `docs/SECURITY.md`. Git history keeps all of it (last commit with it: `16ceb4a`).
- Kept: the permanent deny list, now used only by the web fetch (the host and VMware's gateways are never reachable).
- `labSubnet` in `settings.nix` is renamed `hostOnlySubnet`. It still decides where SSH is accepted from.
- The store's schema is now version 6: on an existing machine the lab duty is deleted and "Stay up to date" loses its mention of a lab.
- An existing machine keeps `/var/lib/woody-execd/engagement.json` if one was set; nothing reads it any more and it can be deleted.
- Tested in containers: the executor (35 tests), the agent (35 tests, including the schema change on an older store), the HUD build, and the evaluation of the whole system. Not yet rebuilt in the VM.

### Phase 7a results (2026-11-12): spikes for the canvas

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

### Phase 7b results (2026-11-12): the frame

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

### Phase 7c results (2026-11-12): things

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

### Phase 7d results (2026-11-12): making

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

### Phase 8a results (2026-11-12): inner state

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

### Phase 8b results (2026-11-12): a life of its own

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

### Phase 8c results (2026-11-12): identity and face

Decided with the operator before building: one identity change a day of at most a quarter of the words; a notice by the lattice; a pause once less than half of the first version remains; Woody may redraw designs and invent expressions; it may show an expression when it chooses; a small palette without red; designs as flip books.

- **Identity.** `identity_change` replaces `identity_propose`. It works only during the daily reflection, takes effect without approval, and is bounded by code: the step size, one a day, the pause when far from the first version, three quiet days after you restore or rewrite the text, and never from a session that read the web. You get a notice by the lattice, the before and the after with the changed words marked, the reason, and one button to put the earlier version back. A switch turns Woody's own changes off.
- **Face.** The lattice's designs are versioned data in the mind's store. Woody redraws them with `face_design` as flip books of up to 16 pictures, invents up to 12 expressions, and shows one with `express`. The record "Its face" shows all of them and restores any.
- **The frame's signals stay the frame's.** Waiting, paused, model unreachable, out of allowance, the hour's ceiling, a problem and the web wall are drawn by the frame whatever Woody's data says, and red is refused in a design. The frame checks every design again before drawing it.
- **Schema 8** of the mind's store: the `face` table, and who wrote each identity version.
- **Tests:** 70 agent tests (9 new), 12 gateway tests, and 99 scripted browser checks (19 new) pass in containers; the Nix builds succeed. Both records were looked at in a browser against the mock.
- **Not tested:** what a real model does with its identity and its lattice. Whether a quarter of the words is the right step can only be judged over days in the VM.
- **Not in 8c:** the lattice's colour does not follow the inner state by itself. Woody is told its inner state and chooses colours in its own designs.

### Phase 9a results (2026-11-12): open reading

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

### Phase 9b results (2026-11-12): studies and explainers

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

### Phase 9c results (2026-11-12): pictures from the web

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

### Phase 10a results (2026-11-12): the wall

What was found first: `agent/` had been Woody's to change since Phase 3, and most protections added since then lived in that same code. Phase 10 lets Woody change its program unasked, so the protections had to move before anything was opened.

- **Two parts.** `agent/src/core/` is locked (a change needs the operator's approval); the rest of `agent/src/` is Woody's own. Thirteen files moved into the locked part, and four pieces were split out of files that stay Woody's: the model call, the link to the canvas, the web tools, and the building of the tool server.
- **Gates.** Woody's code no longer holds the executor, the canvas or the store. It holds gated versions (`core/gate.ts`, `core/woody-store.ts`):
  - the executor refuses anything but looking once the session has read the web, and refuses an unasked change that would not go to the operator;
  - the canvas writes "asked for or not" and an explainer's sources itself;
  - the store's view has no operation that is the operator's or the loop's, writes everything as Woody, and takes a study's sources and explainer from the session.
- **The check.** `agent/selfcheck.mjs` runs with every build on the compiled files of Woody's code: only its own files, `core/api.js`, zod and one SDK function may be imported; nothing that reaches the system or outlives a session may be named; no code is loaded at run time; prototypes are not touched.
- **No code from strings.** The agent is started with code generation switched off and refuses to start otherwise.
- **Locked paths** now include `agent/src/core/`, the check, the agent's build files and `nix/modules/agent.nix`.
- **Tests:** 91 agent tests (7 new) pass, and the Nix builds succeed. The built agent was started locally the way the system starts it: it refuses to start without the switch, starts with it, answers every record and the operator's own operations, and refuses a message cleanly without an API key (`agent/dev/smoke.cjs`). The tool server was tried with code generation off: tools list, run and validate.
- **Not tested:** a real session through the gates. No tool call with a model has run on the restructured agent; only the VM can do that.
- **Known limits:**
  - It is a tripwire inside one process. The check reads what is written, and a name hidden in a computed string would pass. The real walls are outside: the executor, the approvals, Pause, the firewall, the canvas's rules in the HUD, a limit on the API key.
  - The mind's data (memories, findings, the pages recorded for a study) is Woody's own. The wall protects how it is written, not that Woody means well.
  - Until 10c nothing new is allowed: Woody still changes its program only when you ask or accept a plan.

### Phase 10b results (2026-11-12): methods as data

- **The instructions were split in two.** What states a fact about the machine, a boundary or a matter of honesty stays in the rules (`agent/src/core/rules.ts`, locked). What is a way of doing the work well became Woody's methods: eight sections shipped with the program (speaking with you, waking by itself, goals, reading the web, making things, its own time, memory, its face). Sentences were moved, not rewritten.
- **Methods are data.** They are kept in the mind's store with every version (schema 11) and put in front of each session after the rules. `method_change` rewrites a section or adds one, at once and with no rebuild; `method_remove` removes a section Woody added; `method_history` shows the versions.
- **Limits:** 4,000 characters a section, 20 sections, 24,000 characters in all, since the methods are part of every session's instructions. A section that came with the program can be rewritten, not removed. A session that read the web cannot touch them.
- **You are told** in the daily brief, and the new record "Its methods" shows each section, the before and the after of Woody's last change, every version, and a button to put one back. No notice appears on the screen.
- **Your undo is your answer.** You put an earlier version back, or remove a section Woody added (found missing in the VM test and added the same day). Woody is told in its instructions for two weeks, and the tool refuses to write the exact text you undid.
- **An update of the program wins.** When a section's shipped text changes, it replaces what the store holds at the next start, Woody's version stays in the history, and Woody is told to redo its change if it still makes sense.
- **The daily reflection** may now revise a method when the day showed a better way of working.
- **Tests:** 98 agent tests (7 new) and 119 scripted browser checks (3 new) pass; the Nix builds succeed; the agent was started locally with its methods.
- **Not tested:** whether a real model revises its methods sensibly, and whether the moved sentences changed how Woody behaves. The same text is in front of it, in a different order.

## The mind (Phase 4), step by step

### What 4a built

Code: `agent/src/core/store.ts`, `agent/src/mind/` (`context.ts`, `reflect.ts`, `tools.ts`), wired in `agent/src/core/server.ts`.

- **The store** is `/var/lib/woody/mind.db` (SQLite, opened with Node's built-in driver; no new dependency). It holds the append-only event log, the conversation, the journal, memories and the identity text.
- **Every turn is recorded as it happens:** your message, each tool call and its result, Woody's reply, and a journal entry. The journal entry is written by the program, not by the model, so it exists even if the turn fails or is stopped. If the agent is killed mid-turn, the next start notes it in the conversation and the journal.
- **Context is assembled from the store.** The system prompt carries the rules, the identity and the core memories (pinned ones and your preferences). In front of each of your messages Woody gets the time and the memories relevant to it. When its working context is fresh (after 45 minutes of silence, 30 turns, a restart, or `/new`), it also gets a recap: the conversation summary, the last 14 exchanges word for word, and the latest journal entries.
- **After each turn,** a small model with no tools writes a readable journal summary and, when the conversation has grown, folds the older part into the running summary. If that fails, the mechanical journal entry remains.
- **Memory tools for Woody:** `remember`, `memory_search`, `memory_history`, `memory_update`, `memory_forget`, `journal_search`, `conversation_search`.
- **Trust rules, enforced in the store:** a preference or a method can only have the origin "the operator said so"; web content can only be a fact and never enters the always-on core. The `web` origin cannot be chosen by Woody at all; it is reserved for the quarantined reader of 4e.
- **Your access** is through `sudo woody-chat` for now (the HUD panel is Phase 5): see AGENT.md.
- **The HUD keeps its transcript** across reloads: the agent sends the stored conversation when a client connects.

Not in 4a: the event queue and pulse (4b), goals (4c), reflection that extracts memories by itself, identity changes and briefs (4d), web access (4e), and the daily copy of the database (4b; until then it is covered by the pre-rebuild Btrfs snapshots only).

#### Test status

| Test | Store level (automated, 12 tests in the build) | Model level (by hand in the VM) |
|---|---|---|
| Cold start | Passes | To do |
| Correction | Passes | To do |
| Honest gap | Passes | To do |
| Delete | Passes | To do |
| Poison | Passes (rule in the store) | Full test needs web access (4e) |
| Long gap | Passes with a simulated clock | Later |
| Kill mid-goal, Rollback | Recovery of an interrupted turn is built; the tests belong to 4b | Later |

### What 4b built

Code: `agent/src/core/server.ts` (the loop), `agent/src/core/pulse.ts`, `agent/src/core/budget.ts` (the pacer), the queue, alarms and watches in `agent/src/core/store.ts`; Pause in `executor/src/server.rs`.

- **One queue.** Your messages, alarms, system events, finished jobs and decided approvals all go into one queue in the store. Woody handles them one at a time: yours first, then by priority.
- **The pulse** runs every minute as plain code. It fires due alarms, follows what Woody is waiting for, and every two minutes checks the system. A model is called only if the queue then holds something.
- **System events:** a service that newly failed; a filesystem with less than 10% free; error-level log lines. The first two are rules. Log errors are deduplicated, then a small model with no tools answers IGNORE, NOTE or WAKE (at most 40 times a day). NOTE writes a journal line without waking Woody.
- **Alarms:** Woody sets them with `alarm_set` (a reason and a delay or a time), and gets the reason back when one goes off. At most 50 waiting.
- **Wake-ups by itself.** When Woody wakes without you, the conversation shows "woke up: ..." and then its message, if it has one. If it decides nothing needs saying, it stays silent and only the journal records it.
- **Your messages while it works** are delivered between two tool calls, in a block carrying a one-time key that tool output cannot know. If Woody makes no further tool call, your message is answered right after.
- **Stop** interrupts the current work. **Pause** is enforced by the executor: while paused, everything that is not read-only is refused, approving is refused too, and Woody starts nothing on its own. It still answers you. The agent cannot unpause itself.
- **Approvals wait.** A request stays in your inbox for a week instead of 10 minutes. Woody waits 90 seconds for you, then moves on and is woken with the outcome when you decide.
- **Crash safety.** An event that was being handled when the agent died or was restarted goes back in the queue once, and Woody is told it is a retry so it checks what it had already done. A second failure drops it, so a crash cannot loop. A change of the running system (including a rollback) is detected and written in the journal.
- **The pacer.** The monthly cap is released day by day; unused days roll over; half a day is kept in reserve for answering you. Woody's own work is refused when the released amount is used up, and there is a ceiling of 12 autonomous sessions an hour. Your messages are limited only by the monthly cap.
- **Daily copy** of the store in `/var/lib/woody/backups/`, kept for 30 days.

Limits to know:

- Approval requests are held in the executor's memory. If the executor restarts before you decide, they are lost; Woody is told so and can ask again.
- Per-goal budgets come with goals (4c).
- The HUD shows Woody's state and a Pause button, but not yet an inbox or the alarms; use `/alarms` in `woody-chat`.

#### Test status

| Test | Automated | By hand in the VM |
|---|---|---|
| Queue order, deduplication, retry after a kill, alarms, pacer | 6 more store tests (18 in total) | |
| Pause | Live against the built executor: reads run, the rest is refused, approving is refused, the agent cannot resume, the audit chain holds | To do with the HUD button |
| Wake on an alarm | | To do |
| Wake on a failed service | | To do |
| Message delivered while working | | To do |
| Approval decided later | | To do |
| Kill mid-work with a real session | | To do |

### What 4c built

Code: goals in `agent/src/core/store.ts`, `agent/src/mind/goal-tools.ts`, the goal context in `agent/src/mind/context.ts`, scheduling in `agent/src/core/server.ts`, the views in `hud/web/src/Board.tsx`.

- **The board.** You add goals in the HUD (or with `/goal-add` in `woody-chat`). Each goal has its own thread, where Woody asks questions and reports, and where you can write to it.
- **Review.** When Woody has nothing more urgent, it reviews the next goal in your inbox: it restates it, judges it (and may advise against it), plans it, and estimates cost and time, or asks the questions that stop it from planning.
- **Who starts what** is decided by a rule in the store, not by the model:
  - open questions: the goal waits on you;
  - a plan that is read-only, estimated under your small-goal limit (one dollar to start with, adjustable in the HUD), and that Woody recommends: it starts by itself, in observe-only mode, with that limit as its budget;
  - everything else waits for you to accept the plan. Accepting gives the goal full permissions and a budget of one and a half times the estimate.
- **Observe-only mode** applies whenever Woody acts on its own without a plan you accepted: wake-ups, small goals, standing duties. It may look, research, write in its workspace and ask for an approval. It may not apply a configuration change that would take effect without you seeing it; it must propose a goal instead. The tool layer enforces this.
- **Work.** Accepted goals are worked on in your order, one bounded session at a time. Each goal session starts from the goal's dossier, not from an earlier conversation, and must end with a checkpoint: the dossier rewritten and the exact next step.
- **Stops.** A goal stops and lands in your inbox when its budget is used up, when three sessions in a row end without a checkpoint, or when Woody needs an answer. Accepting it again lets it continue (with double the budget if that was the reason).
- **Proposals.** Woody can propose goals. They do nothing until you accept the idea, after which they are reviewed like yours. At most ten can wait.
- **Standing duties,** seeded at the first start: "Keep this machine healthy" (every 6 hours, $1.50 a week) and "Keep improving yourself" (weekly, $2 a week) are on; "Stay up to date" is off until web access (4e) exists. Each can be turned on or off in the HUD. They run in observe-only mode and report only what deserves your attention.
- **Order of attention:** your messages, then approvals, jobs, alarms and system events, then goals to review, then accepted goals, then standing duties. All of it is subject to Pause and to the pacer.
- **HUD:** three plain views behind the buttons in the top bar: **inbox** (plans to accept, questions, proposals), **goals** (the board, with a form to add one, and each goal's detail and thread), **journal**.

Limits to know:

- The estimate is the model's guess. The budget, not the estimate, is what is enforced.
- "Read-only" is declared by Woody in its review. The declaration decides whether the goal may start alone, but the permissions do not depend on it: a goal started that way stays in observe-only mode whatever its plan says.
- A goal session's reply appears in the goal's thread; the main conversation only gets a line when a goal needs you or is done.
- When the model API refuses requests (a spending limit on the key, an outage), Woody shows the error once, stops starting work on its own, and tries again after 5 minutes, then 10, 20 and so on up to 6 hours. Your own messages are still attempted. A review that fails three times for any other reason stops and waits for you.

#### Test status

| Test | Automated | By hand in the VM |
|---|---|---|
| Small-goal rule, acceptance, budgets, stalls, proposals, standing duties, ordering | 6 more store tests (24 in total) | |
| Goal commands over the socket | Smoke test without an API key | |
| A goal reviewed, questioned, estimated and completed unattended | | To do |
| Observe-only refusal of a free configuration change | | To do |

### What 4d built

Code: `reflectionPrompt` and `briefPreamble` in `agent/src/mind/context.ts`, scheduling and presence in `agent/src/core/server.ts`, identity proposals and merging in `agent/src/core/store.ts`.

- **Daily reflection.** Once a day, at the first quiet moment after 03:00, if you wrote to Woody or it did at least three things since the last one. Woody reads the period's record (its journal and what was said in every thread), stores what is durable, merges duplicates, corrects what is out of date, and may propose a change to its identity. It runs as its own session in its own thread, so nothing of it appears in the conversation; the journal records what it changed.
- **What reflection does not read:** tool output. Only lines you wrote are marked as yours, and only those can establish a preference or a method.
- **Merging** marks the duplicate as replaced by the memory that stays. Nothing is deleted, and a memory that came from you is never merged into a weaker one.
- **Identity.** As built in 4d, Woody proposed a new version of its identity text and nothing changed until you approved. Phase 8c replaced the proposal with a change Woody makes itself (see "Identity and face" below); a proposal that was still waiting can still be decided in the identity record. You can also rewrite the text yourself. Every version is kept. The identity is placed after the rules and is declared unable to override them.
- **Daily brief** at 08:00 local time by default (changeable, or off): what Woody did, what it learned, what is blocked on you, what it plans next. It is built from the journal, the board and what waits on you, so it does not depend on what the model happens to remember.
- **Catch-up.** The HUD sends a sign of life when you press a key or click (at most once a minute). If that comes after three hours of silence and Woody did things by itself meanwhile, it tells you what happened. If nothing worth telling happened, it says nothing.
- All three are ordinary queued events: Pause and the pacer apply, and they run in observe-only mode.

Limits to know:

- Reflection is one pass a day by the chat model, with a spending cap per session. It is not a guarantee that everything worth remembering is caught; `remember` during work is still the main route.
- "Local time" is the VM's time zone (`settings.nix`).
- The catch-up relies on the HUD's sign of life. Messages from `woody-chat` count too.

#### Test status

| Test | Automated | By hand in the VM |
|---|---|---|
| Identity proposal, approval, rejection, history | Store tests (30 in total) and a socket smoke test | To do with the HUD |
| Merge rules; what reflection reads; brief material | Store tests | |
| A real reflection, brief and catch-up | | To do |

### What 4e built

Code: `executor/src/web.rs` (the fetch), `agent/src/core/web.ts` (the quarantined reader), the web tools in `agent/src/core/web-tools.ts`, the taint rule in `agent/src/core/server.ts`.

- **Fetch** is an executor action. It accepts only `https://` URLs on port 443 to hosts on the allow-list, a root-owned file (`/var/lib/woody-execd/web-allow.json`) seeded with NixOS, GitHub, Anthropic's documentation and two Linux news sources. The executor resolves the host itself, refuses any address that is not public (so never the VM or the host), and pins the connection to the address it checked. Redirects are not followed. The request is made by `curl` running as a user with no rights (`woody-web`).
- **A refused fetch is recorded** in the audit log with its reason, before anything touches the network.
- **Adding a site** is an approval-tier action: Woody asks with a reason, you approve in the HUD. You can also edit the file as root.
- **Search** uses Claude's web search, run by a separate small model whose only tool is the search.
- **Quarantined reading.** Woody never sees a page or a search result. A small model with no tools reads it and writes notes answering Woody's question; Woody gets the notes, labelled as untrusted. The reader is told to report instruction-like text instead of relaying it.
- **Tainted sessions.** Once a session has received web notes, it may only observe and take notes for the rest of that session. Refused from then on: service and configuration changes, alarms, changes to its identity and to its lattice's designs, corrections, merges and deletions of memory, goal reviews, clipboard offers, and requests to widen the allow-list. This is enforced in code, not left to the model. If it was the main conversation, the model's working context is dropped afterwards, so the next session starts from the store.
- **What may still be written in a tainted session** is marked: a memory is stored as a fact from the web whatever origin Woody claims (so never a preference or a method, and never in the always-on core); a goal checkpoint or proposal carries a line saying it was written after reading the web.
- **"Stay up to date"** is now on: once a day, $2 a week.

Limits to know:

- The reader is a model, and a model can be fooled into writing misleading notes. The design does not rely on the reader being right: it relies on notes not being able to *do* anything, and on nothing trusted being written from them without a mark or your approval.
- Search results can come from any site; only fetching is restricted to the allow-list.
- When 4e was built the fetch user had no firewall rule of its own. Phase 9a added one.
- A session that read the web cannot act even if you ask it to in the same message. Ask again in your next message; Woody then works from what it noted.

#### Test status

| Test | Automated | By hand in the VM |
|---|---|---|
| URL rules, allow-list matching, public-address check, reply parsing | 6 executor tests (55 in total) | |
| Fetch end to end | Live against the built executor with real network: an allowed page, an off-list host, plain http, an address, a redirect, a wildcard subdomain, an approved addition, the audit log | |
| Poison: a page cannot create a preference or a method | Agent test at the tool level (34 in total) | To do with a real page |
| Tainted session refuses to act | Rule in code; not exercised with a model | To do |
| Search | Not exercised: it needs the API | To do |

## Designs that were replaced

### Web access as first designed (Phase 4e)

Replaced by open reading in Phase 9a: see "Open reading" in [MIND.md](MIND.md).

- **Fetch** goes through the executor: read-only, only to sites on an allow-list held in a root-owned file. Woody can ask to add a site; you approve. Private addresses and the host are never reachable this way.
- **Search** uses Claude's built-in web search, which runs on Anthropic's side. It returns titles, links and excerpts; opening a result still needs the site to be on the allow-list.
- **Quarantined reading.** A fetched page is first read by a small model with no tools, which extracts notes. The mind sees the notes, labelled as untrusted, not the raw page.
- **Tainted sessions.** A work session that has read web content can only take notes in the workspace. Acting on what was learned happens in a later session, from the notes. A page can therefore never directly trigger an action.

### The plan for Phase 4, as written before it was built

### 8. What changes in the existing code

| Component | Change |
|---|---|
| `agent/` | The request-and-reply server becomes the loop: event queue, context assembler, work sessions, checkpoints, memory and goal tools, pacer. The chat protocol gains threads, inbox, state and journal messages |
| `executor/` (locked core) | Pause switch; approvals that wait instead of expiring; `web.fetch` with its allow-list; mind events in the audit log |
| `hud/` | Plain views for state, inbox, goals and journal in Phase 4; the real design in Phase 5 |
| `nix/` | Timers for the pulse and the daily copy; the journal watcher; firewall rule for the fetcher |

### 9. Build order (Phase 4)

| Step | Content | Done when |
|---|---|---|
| 4a | Store, event log, journal, threads saved to disk, memory items, context assembler, memory tools | Cold start, correction, honest gap and delete tests pass; the HUD keeps its transcript across reloads |
| 4b | Event queue, pulse, alarms, states, work sessions with checkpoints, message delivery at safe points, Stop and Pause, background jobs, system event filter, pacer | Kill mid-goal and rollback tests pass; Woody wakes on an alarm and on a failed service with nobody typing |
| 4c | Goals board data, review flow, small-goal rule, goal threads, proposals, standing goals (health first); plain HUD views | A goal written on the board is reviewed, questioned, estimated and, if small, completed unattended |
| 4d | Reflection, consolidation, identity with approval, daily brief and catch-up | Long gap test passes; an identity change is proposed and applied only after approval |
| 4e | Allow-listed fetch, search, quarantined reading, tainted sessions; "Staying updated" goes live | Poison test passes; an off-list fetch is refused and logged |

### What the redesign of 2026-11-12 set out to change

Decided on 2026-11-12 and specified in [VISION.md](VISION.md). The last column says what is built; the phases are in [PLAN.md](PLAN.md).

| Today | After the redesign | Phase |
|---|---|---|
| Woody's identity changes only when you approve a proposal | Woody rewrites it itself after reflection, in small steps; you are told, every version is kept, any can be restored | 8c: built, see "Identity and face" above |
| Acting on its own, Woody is in observe-only mode and must propose a goal for any change | Woody changes the canvas and its own program freely, with undo; only the locked core needs approval | 7 (canvas), 10 (program) |
| Woody proposes goals of its own and waits | A share of the budget is its own, for interests and projects it chooses | 8b: built, see "A life of its own" above |
| No inner state beyond Working, Resting and so on | A few slow values with real causes (energy, ease, curiosity, attention, unease) that shape behaviour | 8a: built, see "The inner state" above |
| Web reading only from an allow-list you approve | Any public site through the quarantined reader; you keep a block list | 9a: built, see "Open reading" above |
| $50 a month | $100 a month, a quarter of it Woody's own | 8b: built |

What does not change: the store as the mind, the event log, memory with origin and trust, the quarantined reader, the rule that a session which read the web cannot act, Pause and Stop, approvals for the locked core.

The "security fixes" in the "Stay up to date" duty mean updates for this machine's own software. In version 6 of the store's schema the "Practise in the lab" duty is deleted from existing stores.
