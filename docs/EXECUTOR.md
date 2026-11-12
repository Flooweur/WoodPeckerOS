# The executor (`woody-execd`)

The only root component Woody can talk to. Source in `executor/`, NixOS module in `nix/locked/executor.nix`.

## What it guarantees

- **No arbitrary commands.** It accepts actions from a fixed catalog with validated parameters. There is no "run this" action.
- **Tiers.** Read-only and reversible actions run at once; approval-tier actions wait for a human; forbidden ones are refused.
- **Approvals are out of the agent's reach.** They arrive on a second socket that only the HUD gateway user and root can open. An approval covers one exact action and parameter set, and waits a week for your decision.
- **Pause.** One switch, on the same human-only socket, stops everything that is not read-only, and approving as well, until you resume. It is a file (`/var/lib/woody-execd/paused`), so it survives a restart.
- **Audit.** Every request, decision and result goes to `/var/log/woody/audit.jsonl`. Records are hash-chained and the file is append-only; if the log cannot be written, the executor stops.

## Actions

| Action | Tier | Parameters |
|---|---|---|
| `system.info` | read | none |
| `process.list` | read | `sort` (memory, cpu), `limit` (1–100) |
| `service.list` | read | `state` (running, failed, active, inactive, exited) |
| `service.status` | read | `unit` |
| `journal.tail` | read | `unit`, `lines` (1–200) |
| `journal.query` | read | `unit`, `priority` (0–7), `since` (-15m, -2h, -1d), `grep` (plain phrase), `lines` |
| `osquery.query` | read | `sql`: one SELECT over an allow-listed set of tables |
| `screen.capture` | read | `scale` (0.25–1, default 0.5) |
| `web.fetch` | read | `url` (https, port 443, a host on the allow-list) |
| `web.allowlist` | read | none |
| `web.allow_add` | approval | `domain`, `reason` |
| `service.start` / `service.stop` / `service.restart` | approval | `unit` (locked-core units are forbidden) |
| `config.propose` | reversible | `summary`, `files` (`path`, `content`), `delete` |
| `config.apply` | approval if the locked core is touched, otherwise reversible | `candidate` |
| `config.status` | read | `candidate` |

**Configuration changes.** See [SELFMOD.md](SELFMOD.md). The audit log records the hash and size of each proposed file, not its content, and the final outcome of each change.

**osquery.** The query must be a single SELECT. Which tables it can read is enforced by osquery itself (`--enable_tables`), set in `nix/locked/executor.nix`. Tables that expose secrets or reach the network (`shadow`, `process_envs`, `curl`, `file`, `shell_history`, `augeas` and others) are not in the list, so they do not exist for a query. Queries are stopped after 20 seconds and results capped at 500 rows.

**Web.** `web.fetch` reads one page from an allow-listed host: it resolves the name itself, refuses non-public addresses and the permanent deny list (the Windows host and VMware's gateways, `permanentDeny` in `settings.nix`), pins the connection, does not follow redirects, and runs `curl` as the unprivileged user `woody-web`. The allow-list is `/var/lib/woody-execd/web-allow.json`, root-owned; edit it as root, or approve Woody's requests. See MIND.md for how the agent handles what comes back.

**Web list by hand.** `sudo woodyctl web-list`, `web-add <domain>` and `web-remove <domain>` read and edit the allow-list; the HUD's WEB LIST view does the same. Each change is audited.

**Screenshots.** While the operator's terminal is open in the HUD, `screen.capture` is refused. `screen.capture` runs `grim` as the kiosk user against that user's display and returns a JPEG. The audit log records its size and hash, not the picture.

**Files are not an executor action.** The agent reads world-readable files under `/etc` and `/nix/store` and writes only in its own workspace, using its own unprivileged process (see AGENT.md).

## Protocol

One JSON object per line, on Unix sockets.

**Action socket** `/run/woody/exec.sock` (agent only):

```json
{"op": "action", "action": "service.status", "params": {"unit": "sshd.service"}}
{"op": "wait", "approval_id": "…", "timeout_ms": 60000}
{"op": "catalog"}
{"op": "status"}
{"op": "event", "data": {…}}
```

Replies have `status`: `ok` (with `result`), `error`, `denied` (with `reason`) or `pending` (with `approval_id`).

**Approval socket** `/run/woody/approve.sock` (HUD gateway and root):

```json
{"op": "pending"}
{"op": "decide", "approval_id": "…", "decision": "approve", "action_hash": "…"}
{"op": "audit_tail", "n": 50}
{"op": "pause", "on": true}
{"op": "status"}
```

## Checking it by hand

As the agent:

```bash
sudo -u woody woodyctl request system.info
```

```bash
sudo -u woody woodyctl request service.restart '{"unit":"greetd.service"}'
```

As the human:

```bash
sudo woodyctl pending
```

```bash
sudo woodyctl approve APPROVAL_ID
```

```bash
sudo woodyctl pause
```

```bash
sudo woodyctl resume
```

```bash
sudo woodyctl audit-tail 10
```

```bash
sudo woodyctl audit-verify
```

## Tests

`cargo test` runs in the Nix build (35 tests: audit chain, parameter validation, web fetch rules, configuration changes). The build fails if any test fails.
