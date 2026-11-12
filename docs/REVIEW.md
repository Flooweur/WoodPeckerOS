# Review of WoodPecker-OS (2026-11-12)

Status: **a review, with proposals.** Nothing here is built. What was decided with the operator after the review is in the last section.

## Scope and method

- **Read:** the executor (Rust), the agent's loop, gates, tools, prompts and budget, the canvas store and the HUD gateway, every Nix module, and all documents.
- **Run:** 99 agent tests and 14 gateway tests pass on the Windows host. The executor's tests run inside the Nix build and passed at the last build.
- **Not checked:** the running VM (its logs, its real costs and delays, Woody's actual records). No session with a real model was run. Findings about behaviour come from the code.
- **Size:** about 20,000 lines of code and 2,400 lines of documents.

## The verdict in short

1. **The floor is good.** The privileged executor, approvals, the audit log, Pause, snapshots with rollback, the web path and the isolation of things are well designed and well tested. None of it should be loosened.
2. **The mind has almost no hands.** Woody has 65 tools. About 50 of them keep its own records (goals, memory, interests, studies, methods, face). Six look at the machine. Three act on it (start, stop, restart a service), each behind an approval. It cannot run a program, compute anything, or handle a file outside its notes.
3. **The safeguards are stacked on the wrong side.** Many layers guard a mind that can do very little, and the layers themselves now cost more capability than they buy. The worry that there are too many safeguards is justified, but the fix is mostly to **add hands inside the floor**, and only secondly to remove rules.
4. **Manners were written as law.** About fifteen limits that are matters of taste (how often Woody takes a moment of its own, how many expressions it shows) are fixed in locked code.
5. **The code needs one structural pass.** The loop is one file of 2,200 lines with thirteen global session variables, the same rule is enforced in four places from four lists, and the most complex code (the loop) has no tests.
6. **The documents describe the history, not the system.** They are honest, but a reader must dig through superseded sections to learn how things work today.

## 1. What is solid

| Part | Why it holds |
|---|---|
| Executor (`executor/src/server.rs`, `catalog.rs`) | Typed actions with strict validation; two sockets told apart by the caller's user id; the agent cannot reach the approval socket; the executor stops if it cannot write its audit log. |
| Self-modification (`selfmod.rs`, `nix/locked/selfmod-job.nix`, `fingerprint.nix`) | Snapshot, build, trial activation, health check over 12 seconds, automatic rollback. The privilege fingerprint catches an indirect change (a harmless-looking module that opens the firewall). |
| Web path (`executor/src/web.rs`, `nix/locked/executor.nix`) | Public addresses only, checked before the request and again by a firewall rule on the fetching user; redirects re-checked; pictures re-encoded under limits. |
| The canvas store (`hud/server/canvas.ts`) | Pinning, undo and the record of changes are enforced by the gateway, outside Woody. Things run with no network. |
| The mind's store (`agent/src/core/store.ts`) | Every memory carries where it came from. Continuity comes from the store and the journal, never from a model conversation surviving. |
| Dependencies | Three run-time packages in the agent, one in the HUD. |
| Honesty | The documents state known limits instead of hiding them. |

## 2. What limits Woody today

Ordered by how much capability each one costs.

1. **No way to run anything.** The catalog (`executor/src/catalog.rs`) holds observation, three service actions and the NixOS configuration flow. There is no unprivileged place to run a program. Woody can add `ffmpeg` to the system and then cannot start it. Between "JavaScript in a sealed frame" and "a system change" there is nothing.
2. **Things are sealed.** A thing can read exactly one live feed, the machine's meters (`hud/web/src/canvas/Canvas.tsx`). Woody cannot read a thing's saved state, cannot give it data, and a thing can only send Woody a one-way event. A to-do list you fill in on the canvas is invisible to Woody. A "chart of my goals" or "the failed services" cannot be made except as a frozen copy.
3. **Woody never writes a thing's code.** Every thing is written by a separate "maker" model from a brief, and every change, however small, is a full rewrite from a new brief (`agent/src/canvas.ts`). This adds no protection: the brief comes from Woody.
4. **Reading the web freezes the session.** After one page, the session may only take notes: no canvas, no alarm, no interest (`TAINT_BLOCKED` in `agent/src/core/server.ts`). "Look this up and show me" needs two messages. The delay protects little: Woody's reply, which is built from the page, is in the next session's recap anyway. The real protections are the quarantined reader, the rule that a session which read the web follows only links it was given, and the executor's checks.
5. **The whole HUD is locked** (`locked_paths` in `nix/locked/executor.nix`). VISION.md promised that the kit, the canvas code and the records' styling would be Woody's. They are not.
6. **Every service action asks every time.** There is no "always allow this kind".
7. **Manners as law.** At most six moments of its own a day, two to three hours apart, $0.40 each; six expressions a session; twelve interests; four studies; one study of its own. With the default budget Woody can afford about two moments a day. This is the likely reason "nothing happened for 45 minutes" in the 8b test: the gap after the previous moment is two hours, three when curiosity is low.
8. **Your conversation drains Woody's own time.** The pace for unasked work is the month's cap released day by day, minus everything spent, your chats included (`agent/src/core/budget.ts`). A day of heavy testing leaves Woody nothing.
9. **Woody is told the time in UTC only** (`agent/src/mind/context.ts`), while its day and night use local time.
10. **It does not listen, and reaches nothing outside the VM.** Both were decisions. Both conflict with "a man in the earbud".
11. **Memory is found by matching words** (SQLite full-text search). "What did we say about the trip?" finds nothing if the memory says "holiday".

## 3. Every safeguard, judged

The frame used: an agent is dangerous when one session has all three of untrusted input, private data, and a way to send data out or change state (the "lethal trifecta", and Meta's "rule of two"). A safeguard earns its place by removing one of the three, or by making a mistake undoable. It does not earn it by merely making Woody slower.

### Keep as it is (the floor)

| Safeguard | Protects against |
|---|---|
| Typed executor, no "run this command" as root | Woody, or a page speaking through it, becoming root |
| Approval for the locked core and for any change to the privilege fingerprint | A silent change to what guards the machine |
| Audit log, hash-chained, append-only | A record that can be rewritten |
| Pause and Stop outside Woody | A session that will not stop |
| Snapshot, trial, health check, rollback | A change that breaks the machine |
| Web fetch confined to public addresses, by code and by firewall | A page reaching your Windows host or network |
| Quarantined reader | A page instructing Woody directly |
| Links-only rule after reading the web | Your data leaving inside an address |
| Things with no network, in sandboxed frames | Generated code sending data out |
| Pin, undo and the record kept by the gateway | Woody overriding you on the screen |
| Monthly and per-session money caps; the ceiling on sessions per hour | A loop that spends the budget |
| Origins on memories; a web fact is never a preference | A page planting a "preference" |

### Loosen

| Safeguard | Problem | Proposal |
|---|---|---|
| A session that read the web may only observe | Costs "look it up and show me"; delays an attack by one session at most | It may do whatever cannot leave the machine or change the system: the canvas, alarms, interests, notes. It still may not change the system, its identity, its methods, a stored preference, or offer the clipboard |
| Approval each time for each service | Approval fatigue teaches clicking yes | "Allow once" and "always allow this kind", kept by the executor in a root-owned file you can edit |
| The whole `hud/` locked | Woody cannot evolve its own screen | Lock the frame, the bridge and the gateway; open the kit and the styling |
| Things sealed from Woody | The canvas cannot show Woody's work or carry yours to it | Woody reads and writes a thing's state; a thing may ask for named, read-only feeds |
| Only the maker writes things | Slow, lossy, no protection | Woody may write or patch source itself; the maker stays for delegation |
| One pace for you and for Woody | Your testing starves it | Count Woody's own share on its own ledger |

### Move from code to settings (manners)

Own-time gap, moments per day and money per moment; expressions per session; how many interests and studies; study sizes. They stay as defaults. You change them in one record, and Woody may ask you to. The identity limits (one small step a day, a notice, one-button restore, the pause at half the first text) are well judged and stay.

### Same protection, less machinery

| Today | Problem | Proposal |
|---|---|---|
| The wall inside the agent (Phase 10a): a tokenizer that forbids names such as `setTimeout`, `constructor` and `Proxy` in Woody's own code, frozen prototypes, a Node start-up flag | A language-level fence inside one process is a tripwire, as the documents say. It constrains ordinary code and must be kept in step with every JavaScript feature. Its only purpose is unasked changes to agent code (10c) | Let the operating system be the wall. Woody's own tools become programs in the workbench, under another user. The agent program changes only with your approval. Methods, identity, face, things and workbench tools change freely |
| The web rule enforced in four places from four lists (`TAINT_BLOCKED`, `LOOK_ACTIONS`, `CANVAS_LOOKS`, `clean()`) | A new tool must be added to the right lists or the rule silently does not apply | One policy table: kind of action by kind of session, in one file, with a test that every tool appears in it |
| Seven session flags (mode, taint, own, operator, invited, reflecting, study) as global variables | Hard to reason about, reset by hand | One session object stating who asked, what it read and what it is for |

## 4. The workbench (the main proposal)

A place where Woody runs real programs, built so that it is safe in every kind of session.

- **A separate user** (`woody-work`) with no rights: it cannot read Woody's mind store, the API key, or anything of yours.
- **No network at all.** So it cannot send anything out, whatever was read before. Programs come from the system's pinned package set through the Nix daemon, by name (`python3`, `ffmpeg`), without a rebuild.
- **Its own folder**, shared with Woody's workspace, with limits on time, memory, processes and disk.
- **One executor action** (`work.run`), logged like every other.
- **Tools Woody writes for itself** are scripts there. This replaces Phase 10d and most of 10c.
- **Later:** a folder shared with you (in and out), and programs with a window shown on the canvas (Phase 12).

Considered and rejected: the Agent SDK's own sandboxed shell. It would run as Woody's user, next to the mind store and the API key.

Not a proof: a kernel flaw could cross the user boundary. The floor (executor, snapshots, audit) stands behind it.

## 5. Problems in the code

| Where | Problem | Remedy |
|---|---|---|
| `agent/src/core/server.ts` | 2,193 lines: configuration, session runner, queue, pulse, schedule, the operator's 50 operations, the socket protocol and the activity list in one file | Split by those names |
| `server.ts`, session state | Thirteen module-level variables, set at the start of a session and reset by hand at the end; four are not reset | One session object |
| The loop | No test. The 99 tests cover the store, the gates and pure functions | Run the loop against a scripted stand-in for the model |
| `hud/server/gateway.ts` (1,261 lines), `hud/web/src/frame/App.tsx` (1,125) | Same shape of problem | Split |
| Model names | In three files | One file |
| `mindRequest` and `handle` in `server.ts` | Which screens are told after which operation is decided by matching name prefixes | A table |
| `agent/src/tools.ts`, `config_apply` | Detects a waiting approval by searching the reply text for `"waiting_for_approval": true` | Return a typed result |
| `nix/locked/selfmod-job.nix`, `nix/modules/snapshots.nix` | The snapshot and pruning code is written twice | One script |
| Rules text (`agent/src/core/rules.ts`) | 2,700 words, with 81 uses of never, not, cannot, only. It repeats what tool descriptions and session preambles already say | About a third of the length: facts about the machine, the few boundaries, and the reason for each |
| Tools | All 65 are loaded in every session | Load the record-keeping ones on demand, or merge them |

## 6. Defects and loose ends

- **Dead code:** the identity proposal flow that Phase 8c replaced is still there end to end (`proposeIdentity`, `decideIdentity`, `setIdentity` in the store; the operations `identity_decide` and `identity_set`; buttons in `Panels.tsx`; commands in `chat-cli.ts`).
- **`spikes/`:** about 1,500 lines of finished experiments. Git history keeps them.
- **`sops-nix`:** a flake input and a module that nothing uses; the API key is in a root-only file.
- **The agent's socket is owned by Woody's user** (`SocketUser = "woody"` in `nix/modules/agent.nix`). Anything running as that user could connect and speak as the operator. Owning it as root costs nothing.
- **`nix/modules/kiosk.nix` is not locked**, though it holds the browser's network policy. The firewall rule behind it is locked, so this is a second barrier only.
- **Approvals are lost when the executor restarts** (already an open item).
- **The mind's record grows without bound:** events and messages are never pruned.
- **No continuous integration, no formatter, no linter.** Some lines exceed 200 characters.
- **A password in the repository:** `initialPassword = "woodpecker"` in `nix/modules/base.nix`, with password login over SSH (host-only network).
- **Stale comments:** "until the HUD exists" (`nix/modules/agent.nix`), "added in Phase 2" (`nix/modules/secrets.nix`), "enforced from Phase 3 on" (`nix/locked/executor.nix`).

## 7. The documents

- **README.md** says the canvas and the inner state are "designed and not yet built". They are built.
- **VISION.md** opens with "Nothing in this document is built yet". Most of it is. It says $100 a month; the code's fallback is $50 (the VM's settings say 100).
- **MIND.md** is nine layers of history. Section 5 still describes the allow-list that Phase 9 removed; the truth is 200 lines further down.
- **PLAN.md** holds 28 "results" sections before the architecture.
- **AGENT.md** tells the reader to use `woody-chat` "until the HUD exists".

Proposal: one document per subject saying how it is **now** (architecture, the mind, the canvas, safety, operating the machine), and one history file that keeps the phase results.

## 8. Proposed order of work

| Step | What | Size |
|---|---|---|
| A | Housekeeping: dead code, the socket's owner, local time, model names, CI, the documents | Small |
| B | Structure: the session object, the policy table, the loop under test, the large files split | Medium |
| C | The workbench | Large |
| D | The canvas carries data: state in both directions, feeds, Woody writes source | Medium |
| E | The web rule by consequence; standing approvals; manners in settings | Medium |
| F | The HUD split: frame locked, kit and styling open | Medium |
| Then | Sound and voice, programs on the canvas, pipes, triggers, mail | As planned |

## Sources

- [Operating inside the lethal trifecta (Sophos)](https://www.sophos.com/en-us/blog/inside-the-lethal-trifecta-blast-radius-reduction-in-ai-agent-deployments)
- [The lethal trifecta (Tian Pan)](https://tianpan.co/blog/2026-01-25-the-lethal-trifecta-ai-agents)
- [Designing agents to resist prompt injection](https://www.agentpatterns.ai/security/prompt-injection-resistant-agent-design/)
- [You cannot filter your way out of prompt injection](https://hackernoon.com/you-cannot-filter-your-way-out-of-prompt-injection)
- [Secure deployment of the Agent SDK (Anthropic)](https://platform.claude.com/docs/en/agent-sdk/secure-deployment)
- [nix-sandbox-mcp: sandboxed code execution with Nix](https://github.com/SecBear/nix-sandbox-mcp)
- [nixwrap: ad hoc sandboxing on NixOS](https://github.com/rti/nixwrap)

## Decisions after the review

Made with the operator on 2026-11-12, from twenty questions. Where a decision replaces an earlier one, the earlier one is named.

| Topic | Decision |
|---|---|
| Order of work | Structure first, with no change in behaviour; then the workbench on the clean base |
| The workbench | Built. A separate user, its own folder, limits on time, memory and disk |
| Its network | Asked run by run, public addresses only, under the same firewall rule as web fetches. A run with the network counts as reading the web. The workbench sees only its own folder, never Woody's notes |
| After reading the web | The session may do all that stays inside the machine: the canvas, alarms, interests, notes, workbench runs without network. Still refused: system changes, identity, methods, stored preferences, the clipboard, composing an address, the network. Replaces "observe and take notes only" |
| The wall | The operating system is the wall. The in-process checker of Phase 10a (`selfcheck.mjs`, `lockdown.ts`) is removed; the gates stay as plain structure. The agent program changes only with approval. Woody changes freely its methods, identity, face, things and workbench tools. Replaces Phase 10c for agent code, and Phase 10d |
| Manners | Woody's own, like its methods: values it changes by itself, with every version kept, shown to you, and yours to put back. Money caps stay yours |
| Things and data | Woody reads and writes a thing's saved state. Things may ask for named read-only feeds (services, logs, goals, the journal, workbench files). Things still have no network |
| Who writes things | Woody may write and patch a thing's source. The maker stays for jobs Woody hands over |
| The HUD | Split. Locked: the frame, the approval prompt, the bridge, the gateway, the isolation of things. Woody's own: the kit and the house style, through the tested rebuild flow |
| Listening | Unchanged: Woody does not listen |
| Reach | The password-protected door becomes usable from a phone on the home network: conversation, notices, files |
| Files | Both a folder shared with the host and upload and download in the HUD from any browser, the phone included. The HUD way is the main one, since the system will later run on its own machine |
| Budget | Two ledgers under the same $100 cap: Woody's own share is counted apart, whatever the operator's conversations cost |
| Approvals | One trust dial: careful, normal, free. The locked core and any change of privilege ask at every level. At "normal", without asking: start, stop and restart services outside the core; apply system changes that touch neither the locked core nor privileges, on its own initiative; use the workbench's network in its own time. Replaces "observe-only for everything Woody does on its own" |
| The thinking model | Woody chooses per session, within the budget. The operator can still force one |
| Recall | By meaning, with a small embedding model running in the machine. Built with the restructuring |
| The rules text | Rewritten to about a third of its length. The operator reads the before and the after first |
| The machine | Later a PC of its own with a GPU. What is specific to VMware stays in one module; local speech and local models are prepared for, not built |
| Access for the reviewer | An SSH key, and sudo without a password for the admin account |

Still to settle when each part is built:

- **What "careful" and "free" mean** on the trust dial. Proposed: "careful" is today's behaviour; "free" adds nothing that "normal" lacks except fewer notices.
- **The limit on things left for you unasked** (three a day, set by you) is read here as yours, since it is your screen, and not as one of Woody's manners.
- **The rebuild limits of Phase 10** (at most three unasked rebuilds a day, only while nobody is at the screen) are kept for the changes Woody now applies unasked.

### Measured in the VM after the review (2026-11-12)

The review itself did not look at the running machine. With access to it, these were measured:

| What | Value |
|---|---|
| Spent in the first two days | $19.65: $15.67 on 100 messages from the operator, $3.14 on 36 sessions Woody started by itself, $0.16 on 3 moments of its own, $0.69 on small side calls |
| One message to Woody | 11 cents at the median, 16 on average, on the everyday model |
| Fixed text sent with each new session | About 27,500 tokens (the rules, the methods and the descriptions of the 65 tools), which costs 7 to 14 cents each time the cache is cold (two messages measured) |
| The tool descriptions' part of that | Roughly three quarters |
| What the Agent SDK adds by itself | About 360 tokens and one second |
| First words of an answer | After about 3 seconds, for a question needing one tool call |
| One lookup by meaning (bge-m3 on the VM's processor) | About 0.1 second; the model uses 766 MB of memory. A question in French finds a memory written in English |

What follows from it:

- **The fixed text is the cost of a message.** Shortening the rules (the draft in [RULES-DRAFT.md](RULES-DRAFT.md)) saves about a tenth of it. Loading the record-keeping tools only when they are needed would save about half. That belongs to step E.
- **The Agent SDK is not the problem.** There is no reason to replace it.
- **The silence in the 8b test was not the budget.** The pace had about $18 free that day. It was the two to three hours between two moments of Woody's own.
- **Woody's commits in the VM are kept.** The checkout there pulls with rebase, and four commits of Woody's (two packages, a firewall port opened and closed again) sit on top of what comes from GitHub.

### Progress

| Step | State |
|---|---|
| A | Done, tested in the VM (commit `46e03f2`). Not done: one snapshot script instead of two, a formatter and a linter |
| B | Done: the session object, the policy table, the loop under test (9 tests against a scripted model), the loop's file split in eight, the in-process checker removed, two ledgers, the tokens of each session recorded, recall by meaning with a local model (bge-m3). The rules text is drafted for the operator to read ([RULES-DRAFT.md](RULES-DRAFT.md)). Not done: the gateway (1,261 lines) and the frame's main file (1,125 lines) are not split yet |

### The order that follows

| Step | What |
|---|---|
| A | Housekeeping: dead code, `spikes/`, the socket's owner, local time, model names in one file, continuous integration, the documents rewritten as "how it is now" plus one history file |
| B | Structure: one session object, one policy table, the loop under test with a scripted model, the large files split, the in-process checker removed, two ledgers, recall by meaning, the rules text (read by the operator first) |
| C | The workbench, with the shared folder and upload and download in the HUD |
| D | The canvas carries data; Woody writes source |
| E | The web rule by consequence; the trust dial; manners as Woody's own data; Woody chooses its model |
| F | The HUD split; the phone page |
| Then | Sound and voice (speaking only), programs on the canvas, pipes, triggers, mail |
