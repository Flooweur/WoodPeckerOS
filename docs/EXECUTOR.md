# The executor (`woody-execd`)

The only root component Woody can talk to. Source in `executor/`, NixOS module in `nix/locked/executor.nix`.

## What it guarantees

- **No arbitrary commands.** It accepts actions from a fixed catalog with validated parameters. There is no "run this" action.
- **Tiers.** Read-only and reversible actions run at once; approval-tier actions wait for a human; forbidden ones are refused.
- **Approvals are out of the agent's reach.** They arrive on a second socket that only the HUD gateway user and root can open. An approval covers one exact action and parameter set, and expires after 10 minutes.
- **Scope.** A target is refused unless an active, unexpired engagement allows it. Loopback, link-local and the permanent deny list (the Windows host and VMware gateways) are refused whatever the engagement says.
- **Audit.** Every request, decision and result goes to `/var/log/woody/audit.jsonl`. Records are hash-chained and the file is append-only; if the log cannot be written, the executor stops.

## Actions (Phase 2)

| Action | Tier | Parameters |
|---|---|---|
| `system.info` | read | none |
| `service.status` | read | `unit` |
| `journal.tail` | read | `unit`, `lines` (1–200) |
| `scope.check` | read | `target` |
| `service.restart` | approval | `unit` (locked-core units are forbidden) |

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

`cargo test` runs in the Nix build (29 tests: scope rules, audit chain, parameter validation). The build fails if any test fails.
