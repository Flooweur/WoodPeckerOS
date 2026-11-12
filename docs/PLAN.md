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
| 10 | **Reshaping itself**: free change of its own program | 10a (the wall around the protections) and 10b (methods as data) done, tested in the VM. 10c and 10d are replaced by the decisions of the review: see [REVIEW.md](REVIEW.md) |
| R | **The review** of 2026-11-12: restructuring, the workbench, the canvas carrying data, the web rule by consequence, the trust dial, the HUD split | Steps A and B done. Next: the rules text (drafted, to be read), then step C, the workbench. See [REVIEW.md](REVIEW.md) |
| 11 | **Sound and voice** | Planned |
| 12 | **Programs on the canvas** | Planned |
| 13 | **Universal pipes**: outputs of things wired to inputs of things, the machine, Woody and approved actions | Planned (decided 2026-11-12) |
| 14 | **Triggers on meaning**: alerts on what a change means, on pages, things, files and logs | Planned (decided 2026-11-12) |
| 15 | **Mail as a source**: one read-only folder that triggers can watch | Planned (decided 2026-11-12) |

The results of each phase, as it was finished, are in [HISTORY.md](HISTORY.md).

## Architecture

How the system is built today, file by file, is in [ARCHITECTURE.md](ARCHITECTURE.md). What follows is the overview.

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

The review of 2026-11-12 ([REVIEW.md](REVIEW.md)) changed the order and several earlier decisions. Its steps A to F come before Phase 11, and where this section disagrees with the review's decisions, the review holds.

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

Decided with the operator on 2026-11-12:

| Question | Decision |
|---|---|
| The wall between Woody's own code and the protections | Locked files plus checks: a tripwire inside one process, backed by what stands outside it |
| An update from GitHub and a change of Woody's touch the same file | The update wins. Woody's change is set aside, kept in the record, and Woody redoes it if it still makes sense |
| Unasked rebuilds | At most three a day, only while nobody has been at the screen for 30 minutes and nothing of the operator's is in progress |
| The limits Woody was given | Its rhythm (how often and when it takes time of its own) is Woody's to change. Money and identity limits are locked |
| Being told of a self-change | A notice by the lattice with what changed, the reason and one button that puts the previous program back |
| After an undo | Woody is told and does not make that change again; other changes may follow |
| Changes to its methods | Kept in the record with before, after and undo, and said in the daily brief. No notice |
| What a tool of Woody's own may do | Compute, and use a workspace folder of its own. No network, no system, no secrets, no access to its memory |

Built in four steps:

- **10a. The wall.** Built: see "Phase 10a results". The protections move into a locked part of the agent, and Woody's own code is handed only gated things.
- **10b. Methods as data.** Built: see "Phase 10b results". How Woody works, in words, becomes versioned text it rewrites at once, with no rebuild. Its rules stay locked.
- **10c. Unasked self-change.** Woody changes its own part of the program on its own initiative through the existing snapshot, build, trial, health check and rollback, within the limits above; the notice, the undo, and what happens when an update meets a change of Woody's.
- **10d. Its own tools.** Small programs Woody writes for itself, run in a separate process with no rights.
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

- The API key sits in a root-only file outside the repository. Encrypting it in the repository (sops-nix) was planned and dropped as unneeded; the unused input was removed.
- Approval requests are held in the executor's memory and are lost if it restarts.
- Whether the subscription token can replace the API key for a long-running service.
- Recall by meaning covers memories only; the journal and the conversation are still searched by words.
- Helper workers running in parallel under the mind.
- A phone notification that carries no content.
- An Xorg-based kiosk as the route to real graphics acceleration. The canvas makes this more valuable: animation is limited by software rendering today.
- Which speech engine and which program-relay method to use: decided by the spikes of Phases 11 and 12.
