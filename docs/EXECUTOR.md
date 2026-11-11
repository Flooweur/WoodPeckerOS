# The executor (`woody-execd`)

The only root component Woody can talk to. Source in `executor/`, NixOS module in `nix/locked/executor.nix`.

## What it guarantees

- **No arbitrary commands.** It accepts actions from a fixed catalog with validated parameters. There is no "run this" action.
- **Tiers.** Read-only and reversible actions run at once; approval-tier actions wait for a human; forbidden ones are refused.
- **Approvals are out of the agent's reach.** They arrive on a second socket that only the HUD gateway user and root can open. An approval covers one exact action and parameter set, and expires after 10 minutes.
- **Scope.** A target is refused unless an active, unexpired engagement allows it. Loopback, link-local and the permanent deny list (the Windows host and VMware gateways) are refused whatever the engagement says.
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
| `scope.check` | read | `target` |
| `service.start` / `service.stop` / `service.restart` | approval | `unit` (locked-core units are forbidden) |
| `config.propose` | reversible | `summary`, `files` (`path`, `content`), `delete` |
| `config.apply` | approval if the locked core is touched, otherwise reversible | `candidate` |
| `config.status` | read | `candidate` |

**Configuration changes.** See [SELFMOD.md](SELFMOD.md). The audit log records the hash and size of each proposed file, not its content, and the final outcome of each change.

**osquery.** The query must be a single SELECT. Which tables it can read is enforced by osquery itself (`--enable_tables`), set in `nix/locked/executor.nix`. Tables that expose secrets or reach the network (`shadow`, `process_envs`, `curl`, `file`, `shell_history`, `augeas` and others) are not in the list, so they do not exist for a query. Queries are stopped after 20 seconds and results capped at 500 rows.

**Files are not an executor action.** The agent reads world-readable files under `/etc` and `/nix/store` and writes only in its own workspace, using its own unprivileged process (see AGENT.md).

## Protocol

One JSON object per line, on Unix sockets.

**Action socket** `/run/woody/exec.sock` (agent only):

```json
{"op": "action", "action": "service.status", "params": {"unit": "sshd.service"}}
{"op": "wait", "approval_id": "…", "timeout_ms": 60000}
{"op": "catalog"}
{"op": "event", "data": {…}}
```

Replies have `status`: `ok` (with `result`), `error`, `denied` (with `reason`) or `pending` (with `approval_id`).

**Approval socket** `/run/woody/approve.sock` (HUD gateway and root):

```json
{"op": "pending"}
{"op": "decide", "approval_id": "…", "decision": "approve", "action_hash": "…"}
{"op": "audit_tail", "n": 50}
{"op": "scope"}
```

## Setting the engagement

The scope in force is a root-owned file. Only a human creates or edits it.

```bash
sudo install -m 644 ~/WoodPeckerOS/lab/engagement.example.json /var/lib/woody-execd/engagement.json
```

Set an expiry 30 days out (prints the number to put in `expires_ms`):

```bash
date -d "+30 days" +%s000
```

```bash
sudo nano /var/lib/woody-execd/engagement.json
```

With no file, or an expired or inactive one, every target is refused.

## Checking it by hand

As the agent:

```bash
sudo -u woody woodyctl request system.info
```

```bash
sudo -u woody woodyctl request scope.check '{"target":"192.168.222.130"}'
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
sudo woodyctl audit-tail 10
```

```bash
sudo woodyctl audit-verify
```

## Tests

`cargo test` runs in the Nix build (46 tests: scope rules, audit chain, parameter validation, configuration changes). The build fails if any test fails.
