# WoodPecker-OS: how it is built

This document says how the system works today (2026-11-12, after steps A and B of the review). The goal and the design are in [VISION.md](VISION.md); what comes next is in [REVIEW.md](REVIEW.md) and [PLAN.md](PLAN.md); how each part came to be is in [HISTORY.md](HISTORY.md).

## The parts

| Part | What it is | Runs as | Source |
|---|---|---|---|
| The executor (`woody-execd`) | The only root program Woody can talk to. A fixed list of typed actions, approvals, the audit log, Pause, the web fetches, self-modification | root | `executor/` (Rust), `nix/locked/` |
| The agent (`woody-agent`) | Woody's mind: the loop, the model sessions, the mind's store, the tools | `woody`, no privileges | `agent/` (TypeScript) |
| The HUD gateway (`woody-hud`) | Serves the screen, keeps the canvas, carries your approvals to the executor | `woody-hud` | `hud/server/` |
| The frame | The fixed part of the screen: the lattice, its menu, the records, the approval prompt | the kiosk's browser | `hud/web/src/frame/` |
| Things | What Woody puts on the canvas: small programs in sealed frames | the kiosk's browser, sandboxed | kept by the gateway in `/var/lib/woody-hud` |
| The embedding service (`woody-embed`) | A small local model that turns a text into a vector, for recall by meaning. No network | `woody-embed` | `nix/modules/embed.nix` |
| The system | NixOS, built from this repository, with snapshots before every change | | `flake.nix`, `nix/` |

## Who can talk to whom

| Channel | Who may open it | What it carries |
|---|---|---|
| `/run/woody/exec.sock` | The agent's user only | Requests for actions; waiting on approvals |
| `/run/woody/approve.sock` | The HUD gateway's user, and root | Your decisions, Pause, the block list, the audit log |
| `/run/woody-agent/agent.sock` | The HUD gateway's group, and root | Whoever speaks here speaks as you: messages, the records, Stop |
| `/run/woody-embed/embed.sock` | The agent's user (through the service's group) | Texts in, vectors out |
| The kiosk's browser | Loopback only (policy and a firewall rule) | The frame and the things |
| The host door (HTTPS, port 7843) | The Windows host's address only, behind a password | The same HUD in your own browser |
| Web fetches | The user `woody-web`, to public addresses on port 443 only (a firewall rule) | Pages and pictures, fetched by the executor |

The agent cannot open the approval socket, so it cannot approve its own requests. Things have no network at all.

## The agent, file by file

Everything is under `agent/src/`. The whole directory is a locked path: it changes only with your approval.

| File | What it holds |
|---|---|
| `core/main.ts` | The entry point: configuration, the socket, the timers |
| `core/agent.ts` | Puts the agent together: the store, the budget, the tools behind their gates |
| `core/core.ts` | The one shared object the loop's files work on |
| `core/session.ts` | The session in progress: who asked, what it is for, what it has read |
| `core/policy.ts` | **What a session may do: one table.** Every tool, executor action and canvas request has a kind |
| `core/gate.ts`, `core/woody-store.ts` | The gates: the executor, the canvas and the store as tools may use them |
| `core/run-session.ts` | One session, from its event to its journal entry |
| `core/queue-loop.ts` | The queue: what is handled next, and whether Woody may act by itself |
| `core/daily.ts` | The pulse: alarms, what Woody waits for, the system check, the brief, the reflection |
| `core/life-now.ts` | Its inner state, day and night, and whether it takes a moment of its own |
| `core/operator-api.ts`, `core/protocol.ts` | What you can ask of the mind, and the socket's messages |
| `core/store.ts` | The mind's store (SQLite): events, messages, journal, memories, goals, the queue, identity, methods, face, studies |
| `core/budget.ts` | The spend ledger and its two paces |
| `core/rules.ts`, `core/methods.ts`, `core/prompt.ts` | What every session is told: the rules, the methods as shipped, and their order |
| `core/web-tools.ts`, `core/web.ts`, `core/links.ts` | Reading the web: the tools, the quarantined reader, the addresses a session was given |
| `core/embed.ts` | Recall by meaning: the client of the local embedding service, and how the search by words and the search by meaning are merged |
| `core/models.ts`, `core/sdk.ts`, `core/config.ts` | The model names, the one place a model is called from, the settings |
| `tools.ts`, `canvas.ts`, `mind/*.ts` | Woody's tools and what each kind of session is told |
| `core/testing.ts`, `core/loop.test.ts` | A scripted model and the tests that run the whole loop against it |

## One session

1. **An event is queued**: your message, an alarm, something on the machine, a finished job, a decision of yours, a goal, a study, a moment of Woody's own.
2. **The queue hands it out** (`queue-loop.ts`). Your messages come first and are held back only by a missing key or the monthly cap. What Woody does by itself also needs Pause to be off, the model to be reachable, and money in the right ledger.
3. **A session object is made** (`session.ts`). It says who asked and in which mode: "full" when you are asking or accepted the plan, "observe" when Woody acts on its own.
4. **The context is assembled from the store** (`mind/context.ts`): the time, a recap when the model's working context is fresh, relevant memories, the goals board.
5. **The model runs** with Woody's tools and nothing else. Before each tool call the loop asks the policy table; inside the tools, the gates ask it again.
6. **The record is written by the loop**, whatever happened: messages, events, the journal entry, the cost.
7. **The session object is dropped.** Nothing of it reaches the next session.

## What a session may do

`core/policy.ts` gives every action a kind:

| Kind | Examples | After reading the web |
|---|---|---|
| look | The machine, the canvas, its own records | Allowed |
| read-web | Search, fetch, pictures | Allowed, to addresses it was given |
| note | A memory, a note, a checkpoint, a file in its workspace | Allowed, marked as from the web |
| notify, express | A notice, an expression on the lattice | Allowed |
| canvas | Making, changing, moving, removing a thing | Refused |
| plan | Alarms, interests, studies, the review of a goal | Refused |
| self | Identity, methods, face | Refused |
| memory-edit | Correcting, merging, deleting a memory | Refused |
| clipboard | Text offered for you to copy | Refused |
| system | Services, the configuration | Refused |

An action with no kind is refused, and a test checks that every tool is in the table. The review decided that "canvas" and "plan" become allowed after reading; that is one edit in this table (step E).

Apart from the table, two rules hold in "observe" mode: Woody may apply a configuration change only if it goes to you for approval, and what it adds to the canvas counts as uninvited.

## Money

Every model call's cost goes to a ledger (`/var/lib/woody/usage.jsonl`), with the tokens it used.

- **The monthly cap** (`monthlyCapUsd` in `nix/hosts/woodpecker/settings.nix`) bounds everything, your conversations included.
- **Your side** is the cap without Woody's share. It is released day by day; work Woody does for you unasked (goals, wake-ups, studies you asked for) waits when your side is ahead of its pace.
- **Woody's own share** (`ownShare`, a quarter by default) is counted apart and released day by day. Your conversations do not use it up.
- **One session** may cost at most `perTurnCapUsd`, a moment of Woody's own at most 40 cents.

Measured in the VM on 2026-11-12: each new session sends about 27,500 tokens of fixed text before anything else (the rules, the methods and, for about three quarters of it, the descriptions of the 65 tools). That is 7 to 14 cents a session on the everyday model when nothing is cached (two messages measured). The Agent SDK itself adds about 360 tokens.

## What is stored where

| Where | What |
|---|---|
| `/var/lib/woody/mind.db` | The mind's store. One copy a day is kept for 30 days in `backups/` |
| `/var/lib/woody/usage.jsonl` | The spend ledger |
| `/var/lib/woody/workspace/` | Woody's notes, drafts and screenshots |
| `/var/lib/woody-hud/` | The canvas: things with every version, pictures, the record of changes |
| `/var/log/woody/audit.jsonl` | The executor's audit log, hash-chained and append-only |
| `/var/lib/woody-execd/` | The web block list, staged configuration changes |
| `/var/lib/woody-secrets/agent.env` | The API key, readable by root only |
| `/.snapshots/` | Btrfs snapshots taken before each rebuild |

## Tests

| What | Where | How to run |
|---|---|---|
| The agent: the store, the gates, the policy, the loop against a scripted model (107 tests) | `agent/src/**/*.test.ts` | `cd agent && npm run build && npm test` |
| The agent starts and answers | `agent/dev/smoke.cjs` | `node dev/smoke.cjs .` |
| The canvas store and the kit (14 tests) | `hud/server/*.test.ts` | `cd hud && npm run build && npm test` |
| The HUD in a real browser, with a hostile thing (122 checks) | `hud/dev/check/` | See the top of `hud/dev/check/run.sh` |
| The executor (55 tests) | `executor/src/` | `cargo test -- --test-threads=1` |
| All of it on every push | `.github/workflows/ci.yml` | |

No test runs a real model. What a real model does with the rules and the tools is checked in the VM.
