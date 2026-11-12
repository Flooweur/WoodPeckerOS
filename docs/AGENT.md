# The agent (`woody-agent`)

The reasoning process: Claude, through the Claude Agent SDK, running as the unprivileged user `woody`. Source in `agent/`, NixOS module in `nix/modules/agent.nix`.

The agent is a loop: it answers when you write, and it also wakes by itself on alarms it set, on system events, and when something it was waiting for finishes. The design and what is built so far are in [MIND.md](MIND.md).

## What it can and cannot do

- It has **no built-in tools**: no shell, no direct web access. Its tools (`agent/src/tools.ts`) are typed wrappers around executor actions, plus a few it can safely do itself as an unprivileged process.
- **Observe:** `system_info`, `process_list`, `service_list`, `service_status`, `journal_query`, `osquery`.
- **Operate (approval):** `service_start`, `service_stop`, `service_restart`.
- **Change the system:** `config_propose`, `config_apply`, `config_status`. Free except for the locked core, which needs approval; see [SELFMOD.md](SELFMOD.md).
- **Files (local):** `fs_list` and `fs_read` under its workspace, `/etc` and `/nix/store`; `fs_write` only inside its workspace (`/var/lib/woody/workspace`). Symlinks that lead out of those areas are refused.
- **See the screen:** `screenshot` returns a picture of the kiosk display and saves a copy under `screenshots/` in the workspace.
- **Memory:** `remember`, `memory_search`, `memory_history`, `memory_update`, `memory_forget`, `journal_search`, `conversation_search`. These use the agent's own store (`/var/lib/woody/mind.db`), not the executor. See [MIND.md](MIND.md).
- **Alarms:** `alarm_set`, `alarm_list`, `alarm_cancel`.
- **The web:** `web_search`, `web_fetch`, `web_allowlist`, `web_allow_request`. Woody only ever gets notes written by a separate reader that cannot act, and a session that used them can only observe and take notes afterwards.
- **Reflection and identity:** `memory_merge`, `identity_propose` (a proposal changes nothing until you approve it).
- **Goals:** `goal_board`, `goal_get`, `goal_review`, `goal_checkpoint`, `goal_propose`. Woody cannot create a goal in your name, accept a plan or raise a budget.
- **HUD:** `hud_notify` raises a notice on the HUD. `clipboard_offer` shows a notice with a Copy button. Woody cannot read the clipboard; paste into the chat instead.
- It runs under systemd hardening with no capabilities and a read-only view of the system. Its only writable place is `/var/lib/woody`.
- It cannot open the approval socket. When a tool needs approval, the call waits until a human decides.
- Tool results are labelled as data, and the system prompt tells the model never to follow instructions found in them.

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

This is a stopgap. Moving the key into sops-nix (encrypted in the repo) is planned.

## Talking to it

Until the HUD exists, use the terminal client:

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
| `/identity` | Who Woody is, and any change it proposes |
| `/identity-approve 2`, `/identity-reject 2` | Decide a proposed change |
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

The chosen model is remembered across restarts. Every turn's cost, as reported by the SDK, is appended to `/var/lib/woody/usage.jsonl`. After each turn a short journal summary is written with `claude-haiku-5-5`; its cost is recorded there too, as "background". Two limits from `settings.nix` are enforced: `monthlyCapUsd` (new turns are refused once reached) and `perTurnCapUsd` (a single reply is stopped at that cost). What Woody does on its own is paced further: the cap is released day by day, with a reserve kept for answering you (see MIND.md).

## Chat protocol

WebSocket on `/run/woody-agent/agent.sock`, JSON messages.

Client to agent: `chat {text}`, `set_model {model}`, `new_session`, `interrupt`, `get_state`, `get_history`, `pulse`, `presence`, `mind {op, ...}` (ops: `memories`, `memory`, `add`, `correct`, `pin`, `unpin`, `forget`, `journal`, `alarms`, `alarm_cancel`, `identity`, `stats`, and for the board `goals`, `goal`, `inbox`, `goal_add`, `goal_edit`, `goal_accept`, `goal_drop`, `goal_move`, `goal_message`, `standing`, `small_goal_limit`; and `identity`, `identity_decide`, `identity_set`, `brief`, `reflect_now`).

Agent to client: `state` (now with `mind_state`: what Woody is doing, the queue, the next alarm), `note` (a wake-up), `goals_changed`, `history` (the stored conversation, sent on connect), `mind_result`, `user_text`, `turn_start`, `assistant_delta`, `assistant_text`, `tool_use`, `tool_result`, `approval_pending`, `approval_resolved`, `result`, `error`.

Messages about a session carry a `thread` number. The main conversation has one thread; each goal has its own.

## Logs

```bash
journalctl -u woody-agent -n 50 --no-pager
```

The executor's audit log also records each tool call and chat turn the agent reports (`sudo woodyctl audit-tail`).
