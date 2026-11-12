# The agent (`woody-agent`)

The reasoning process: Claude, through the Claude Agent SDK, running as the unprivileged user `woody`. Source in `agent/`, NixOS module in `nix/modules/agent.nix`.

The agent is a loop: it answers when you write, and it also wakes by itself on alarms it set, on system events, and when something it was waiting for finishes. The design and what is built so far are in [MIND.md](MIND.md).

## What it can and cannot do

- Its program is **locked**: a change to anything under `agent/` needs your approval. What Woody changes by itself is data (its methods, its identity, its face, the things on the canvas). See "The agent is locked" in [SELFMOD.md](SELFMOD.md), and [ARCHITECTURE.md](ARCHITECTURE.md) for the files.
- **What a session may do is one table** (`agent/src/core/policy.ts`). Every tool has a kind, and a tool with no kind is refused.
- It has **no built-in tools**: no shell, no direct web access. Its tools (`agent/src/tools.ts`) are typed wrappers around executor actions, plus a few it can safely do itself as an unprivileged process.
- **Observe:** `system_info`, `process_list`, `service_list`, `service_status`, `journal_query`, `osquery`.
- **Operate (approval):** `service_start`, `service_stop`, `service_restart`.
- **Change the system:** `config_propose`, `config_apply`, `config_status`. Free except for the locked core, which needs approval; see [SELFMOD.md](SELFMOD.md).
- **Work:** `run` runs a script in the workbench: real programs, in a place that sees nothing else of the machine, with no network unless asked. A run with the network counts as reading the web. `fs_list`, `fs_read` and `fs_write` also work in the workbench's folder, where you give Woody files and take its results. See [WORKBENCH.md](WORKBENCH.md).
- **Files (local):** `fs_list` and `fs_read` under its workspace, `/etc` and `/nix/store`; `fs_write` only inside its workspace (`/var/lib/woody/workspace`). Symlinks that lead out of those areas are refused.
- **See the screen:** `screenshot` returns a picture of the kiosk display and saves a copy under `screenshots/` in the workspace.
- **The canvas:** `canvas_look`, `thing_source`, `kit_place`, `thing_make`, `thing_change`, `thing_place`, `thing_remove`. The canvas is kept by the HUD gateway, which enforces its rules; see "Making things" below and [HUD.md](HUD.md).
- **Memory:** `remember`, `memory_search`, `memory_history`, `memory_update`, `memory_forget`, `journal_search`, `conversation_search`. These use the agent's own store (`/var/lib/woody/mind.db`), not the executor. See [MIND.md](MIND.md).
- **Alarms:** `alarm_set`, `alarm_list`, `alarm_cancel`.
- **Its own state:** `inner_state` returns how Woody is and the real events behind it. See "The inner state" in [MIND.md](MIND.md).
- **Its interests:** `interest_add`, `interest_list`, `interest_note`, `interest_drop`: what Woody is curious about and where each interest came from. See "A life of its own" in [MIND.md](MIND.md).
- **The web:** `web_search`, `web_fetch`, `web_picture`, `web_blocklist`. Woody may read any public site you have not blocked, and fetch pictures that a reader describes to it (it never sees them; see "Pictures from the web" in [MIND.md](MIND.md)). It only ever gets notes written by a separate reader that cannot act; a session that used them can only observe and take notes afterwards, and can fetch only addresses found in what it was given. See "Open reading" in [MIND.md](MIND.md).
- **Reflection and identity:** `memory_merge`, `identity_change` (only during the daily reflection, one small step a day, no approval; you are shown the change and can restore any version).
- **Studies:** `study_start`, `study_note`, `study_plan`, `study_done`, `study_list`, `study_get`, `study_drop`. A subject learned over reading sessions and explained with a thing; the pages read are recorded by code. See "Studies and explainers" in [MIND.md](MIND.md).
- **Its methods:** `method_change`, `method_remove`, `method_history`. How Woody does its work, as text it rewrites at once; its rules stay locked. See "Methods" in [MIND.md](MIND.md).
- **Its face:** `face_list`, `face_design`, `face_reset` to redraw the lattice's designs and invent expressions, and `express` to show one. See "Identity and face" in [MIND.md](MIND.md).
- **Goals:** `goal_board`, `goal_get`, `goal_review`, `goal_checkpoint`, `goal_propose`. Woody cannot create a goal in your name, accept a plan or raise a budget.
- **HUD:** `hud_notify` raises a notice on the HUD. `clipboard_offer` shows a notice with a Copy button. Woody cannot read the clipboard; paste into the chat instead.
- It runs under systemd hardening with no capabilities and a read-only view of the system. Its only writable place is `/var/lib/woody`.
- It cannot open the approval socket. When a tool needs approval, the call waits until a human decides.
- Tool results are labelled as data, and the system prompt tells the model never to follow instructions found in them.

## Making things

Woody puts things on the canvas through the HUD gateway, over a connection the gateway opens to the agent's socket. The gateway refuses what Woody may not do (a pinned thing, anything while you have paused it), tries each new thing on the screen, and records every change.

- **The kit** (`kit_place`): ten ready parts (text, note, list, table, chart, clock, meter, picture, buttons, input). Placing one involves no model: it is on the screen in about a second.
- **The maker** (`thing_make`, `thing_change`): Woody writes a brief, and a separate model call writes the thing's code from it. The maker is given the rules of the frame and the brief, nothing else. Woody chooses the effort, which chooses the model:

| Effort | Model | Measured in Phase 7a |
|---|---|---|
| small | Haiku 5.5 | about 5 s, a fraction of a cent |
| normal (the default) | Sonnet 5.5 | about 10 s, 1 to 2 cents |
| hard | Opus 5.5 | about 18 s, about 5 cents |
| best (only when you ask for the strongest) | Fable 5.2 | up to a minute, up to 26 cents |

- **The trial.** The gateway shows the new thing on the screen and waits for it to say it runs. If it does not, the change is taken back and Woody is told why. The maker then gets one more attempt, by the next stronger model, with the error and what it wrote. After two failures Woody is told and says so.
- **What it costs** is added to the monthly total. During a goal's session it counts against that goal's budget; in Woody's own time it comes out of Woody's share, where the strongest maker is not available.
- **Events from things.** A thing can tell Woody that something happened on it (a button of the kit, or `woody.emit` in a made thing). Woody is woken with an event that names the thing; it is not treated as a message from you. At most six a minute from one thing and sixty an hour in all.
- **A session that has read the web cannot change the canvas,** like every other action.
- **On its own.** In its own time Woody may add to the canvas without being asked. Such a thing is marked as uninvited, needs a note when it is for you (`note` on `thing_make` and `kit_place`), and counts against the daily limit you set. The gateway enforces all three; see [HUD.md](HUD.md).

## Giving it the API key

The key lives in a root-only file outside the repo and outside the Nix store.

```bash
sudo install -d -m 700 /var/lib/woody-secrets && sudo install -m 600 /dev/null /var/lib/woody-secrets/agent.env
```

```bash
sudo nano /var/lib/woody-secrets/agent.env
```

Put one line in it:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Then restart the agent:

```bash
sudo systemctl restart woody-agent
```

The key is never in the repository or in the Nix store.

## Talking to it

You talk to Woody on the screen (see [HUD.md](HUD.md)). Over SSH there is also a terminal client, which works whatever the HUD is doing:

```bash
sudo woody-chat
```

| Command | Effect |
|---|---|
| `/model` | List the selectable models |
| `/model claude-opus-5-5` | Use that model from the next message on |
| `/new` | Clear Woody's working context. The conversation, journal and memory are kept, and the next reply starts from a recap |
| `/memories [words]` | List memories, or search them |
| `/memory 12` | Show memory 12 with its earlier versions |
| `/remember text` | Add a memory yourself (recorded as said by you) |
| `/correct 12 text` | Replace memory 12; the old version is kept as replaced |
| `/pin 12`, `/unpin 12` | Keep a memory always in Woody's context, or stop doing so |
| `/forget 12` | Delete memory 12 and all its versions |
| `/journal [n]` | Show the last n journal entries |
| `/mind` | Counts of events, messages, journal entries and memories |
| `/alarms`, `/unalarm 3` | List Woody's alarms; cancel one |
| `/pulse` | Run a pulse now instead of waiting for the next minute |
| `/goals`, `/inbox` | The goals board; what needs you |
| `/goal 3` | Goal 3 in full, with its thread |
| `/goal-add title \| details` | Add a goal |
| `/accept 3`, `/drop 3` | Accept a proposal or a plan (or let a stopped goal continue); drop a goal |
| `/say 3 text` | Write to Woody in goal 3's thread |
| `/identity` | Who Woody is. Its versions, and the button to put one back, are in the HUD |
| `/brief`, `/brief 07:30`, `/brief off`, `/brief now` | Show or set the daily brief time, turn it off, or ask for one now |
| `/reflect` | Run the daily reflection now |
| `/stop` | Interrupt the current reply |
| `/quit` | Leave |

When Woody asks for something that needs approval, the client prints the `woodyctl approve …` command to run in another shell. You can write to Woody while it is working; it reads the message at its next step. To stop everything it does on its own, use `sudo woodyctl pause` (and `resume`).

## Models and cost

| Use | Model | Price per million tokens (in / out) |
|---|---|---|
| Chat default | `claude-sonnet-5-5` | $2 / $10 |
| Chat, selectable | `claude-opus-5-5` | $4 / $20 |
| Chat, selectable | `claude-fable-5-2` | $8 / $40 |
| Triage, journal summaries and quarantined reading | `claude-haiku-5-5` | $0.10 / $0.50 |
| Woody's own time | `claude-sonnet-5-5` | $2 / $10 |

The chosen model is remembered across restarts. Every turn's cost, as reported by the SDK, is appended to `/var/lib/woody/usage.jsonl`. After each turn a short journal summary is written with `claude-haiku-5-5`; its cost is recorded there too, as "background". Two limits from `settings.nix` are enforced: `monthlyCapUsd` ($100; new turns are refused once reached) and `perTurnCapUsd` (a single reply is stopped at that cost). `ownShare` (0.25) is the part of the cap that Woody may spend in its own time. What Woody does on its own is paced further: the cap is released day by day, with a reserve kept for answering you (see MIND.md).

## Chat protocol

WebSocket on `/run/woody-agent/agent.sock`, JSON messages.

Client to agent: `chat {text}`, `set_model {model}`, `new_session`, `interrupt`, `get_state`, `get_history`, `pulse`, `presence`, `mind {op, ...}` (ops: `memories`, `memory`, `add`, `correct`, `pin`, `unpin`, `forget`, `journal`, `alarms`, `alarm_cancel`, `identity`, `stats`, and for the board `goals`, `goal`, `inbox`, `goal_add`, `goal_edit`, `goal_accept`, `goal_drop`, `goal_move`, `goal_message`, `standing`, `small_goal_limit`; and `identity`, `identity_decide`, `identity_set`, `identity_restore`, `identity_seen`, `identity_continue`, `identity_freeze`, `face`, `face_restore`, `studies`, `study_add`, `study_drop`, `study_size`, `methods`, `method_restore`, `brief`, `reflect_now`).

Agent to client: `state` (now with `mind_state`: what Woody is doing, the queue, the next alarm), `note` (a wake-up), `goals_changed`, `history` (the stored conversation, sent on connect), `mind_result`, `user_text`, `turn_start`, `assistant_delta`, `assistant_text`, `tool_use`, `tool_result`, `approval_pending`, `approval_resolved`, `result`, `error`.

Messages about a session carry a `thread` number. The main conversation has one thread; each goal has its own.

## Logs

```bash
journalctl -u woody-agent -n 50 --no-pager
```

The executor's audit log also records each tool call and chat turn the agent reports (`sudo woodyctl audit-tail`).
