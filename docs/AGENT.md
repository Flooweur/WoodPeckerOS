# The agent (`woody-agent`)

The reasoning process: Claude, through the Claude Agent SDK, running as the unprivileged user `woody`. Source in `agent/`, NixOS module in `nix/modules/agent.nix`.

Today the agent answers when you write to it. Phase 4 turns it into an always-present loop with goals and memory; that design is in [MIND.md](MIND.md).

## What it can and cannot do

- It has **no built-in tools**: no shell, no web. Its tools (`agent/src/tools.ts`) are typed wrappers around executor actions, plus a few it can safely do itself as an unprivileged process.
- **Observe:** `system_info`, `process_list`, `service_list`, `service_status`, `journal_query`, `osquery`, `scope_check`.
- **Operate (approval):** `service_start`, `service_stop`, `service_restart`.
- **Change the system:** `config_propose`, `config_apply`, `config_status`. Free except for the locked core, which needs approval; see [SELFMOD.md](SELFMOD.md).
- **Files (local):** `fs_list` and `fs_read` under its workspace, `/etc` and `/nix/store`; `fs_write` only inside its workspace (`/var/lib/woody/workspace`). Symlinks that lead out of those areas are refused.
- **HUD:** `hud_notify` raises a notice on the HUD.
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
| `/new` | Start a new conversation |
| `/stop` | Interrupt the current reply |
| `/quit` | Leave |

When Woody asks for something that needs approval, the client prints the `woodyctl approve …` command to run in another shell.

## Models and cost

| Use | Model | Price per million tokens (in / out) |
|---|---|---|
| Chat default | `claude-sonnet-5-5` | $2 / $10 |
| Chat, selectable | `claude-opus-5-5` | $4 / $20 |
| Chat, selectable | `claude-fable-5-2` | $8 / $40 |
| Triage and quarantined reading (Phase 4) | `claude-haiku-5-5` | $0.10 / $0.50 |

The chosen model is remembered across restarts. Every turn's cost, as reported by the SDK, is appended to `/var/lib/woody/usage.jsonl`. Two limits from `settings.nix` are enforced: `monthlyCapUsd` (new turns are refused once reached) and `perTurnCapUsd` (a single reply is stopped at that cost).

## Chat protocol

WebSocket on `/run/woody-agent/agent.sock`, JSON messages.

Client to agent: `chat {text}`, `set_model {model}`, `new_session`, `interrupt`, `get_state`.

Agent to client: `state`, `user_text`, `turn_start`, `assistant_delta`, `assistant_text`, `tool_use`, `tool_result`, `approval_pending`, `approval_resolved`, `result`, `error`.

## Logs

```bash
journalctl -u woody-agent -n 50 --no-pager
```

The executor's audit log also records each tool call and chat turn the agent reports (`sudo woodyctl audit-tail`).
