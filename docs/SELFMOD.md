# Self-modification

Woody can change the NixOS configuration of its own machine. It is free to do so, except for a **locked core** that only changes with your approval.

Source: `executor/src/selfmod.rs`, `nix/locked/selfmod-job.nix`, `nix/locked/fingerprint.nix`. Settings: the `selfmod` block in `nix/locked/executor.nix`.

## How a change happens

1. **Read.** The configuration the system was built from is readable by Woody at `/etc/woodpecker/source`.
2. **Propose** (`config.propose`). Woody sends the complete content of the files it wants to change. The executor copies the configuration into a root-owned directory, applies the files there, and evaluates the result. Nothing on the running system changes. The reply says what changed and whether approval will be needed. A configuration that does not evaluate is refused with the error.
3. **Apply** (`config.apply`). If the change needs approval, the HUD shows you the diff and the reasons, and nothing runs until you approve. Then a separate root job:
   - takes a Btrfs snapshot of `/` and `/home`;
   - builds the new system (a failed build changes nothing);
   - activates it **on trial**, without making it the boot default;
   - checks for 12 seconds in a row that the executor, the agent and the HUD are up and answering, that none of them is restart-looping, and that no unit has newly failed;
   - if healthy: makes it permanent and commits the change in your checkout as a commit by "Woody";
   - if not: re-activates the previous system by itself.
4. **Follow** (`config.status`). Woody polls the job. The outcome is written to the audit log.

The job runs as its own systemd unit, so it survives when the new configuration restarts the executor or Woody itself.

## What needs your approval

A change needs approval if **either** test says so.

**1. It touches a locked path:**

| Path | Why |
|---|---|
| `nix/locked/`, `executor/` | The executor, its rules, the audit log, this mechanism |
| `agent/` | The agent program, all of it: the loop, the rules, the gates, the tools, and how it is built and tested (see "The agent is locked") |
| `nix/modules/agent.nix` | How the agent is started and confined |
| `nix/modules/kiosk.nix` | The kiosk browser's own network policy |
| `hud/` | The HUD carries your approvals |
| `flake.nix`, `flake.lock` | What the system is built from |
| `nix/hosts/` | Machine settings: host-only subnet, permanent deny list, spending caps, which modules are loaded |
| `nix/modules/base.nix` | Firewall, SSH, your user account |
| `nix/modules/snapshots.nix` | The rollback tool |

**2. It changes the privilege fingerprint.** The executor evaluates a fingerprint of the running system and of the proposed one, and compares them. This catches a change made indirectly, for example a harmless-looking file that overrides the firewall. The fingerprint covers:

- every systemd unit (services, sockets, timers), except the program Woody's own agent runs;
- the agent's sandbox settings and environment;
- users, groups, sudo, setuid programs, polkit and PAM;
- the firewall and SSH;
- activation scripts, temporary-file rules, udev rules, kernel parameters;
- shell start-up code and environment variables;
- Nix settings and package overlays;
- sensitive files under `/etc`.

## The agent is locked

The agent program holds the protections that were added over time: the rule about what a session may do after reading the web, the quarantined reader, the links-only rule, the budget, the limits on Woody's identity, and its rules text. So the whole of `agent/` is a locked path: a change to it is shown to you as a diff and waits for your approval.

Phase 10a tried something else: it split the agent into a locked part and a part Woody could rewrite unasked, kept apart by a check on the code inside one process. The review of 2026-11-12 removed that check. A fence inside one process is a tripwire, it constrained ordinary code, and its only purpose was unasked changes to agent code. The decision instead: the operating system is the wall.

What Woody changes by itself, with no approval and no rebuild, is data:

| What | How | Your way back |
|---|---|---|
| Its methods (how it works) | `method_change`, at once | Put any version back, or remove a section it added |
| Its identity | `identity_change`, one small step a day, during its reflection | Put any version back; freeze it |
| Its face (the lattice's designs) | `face_design` | Put any version back |
| Things on the canvas | `thing_make`, `thing_change` and the rest | Undo, pin, the record of changes |

Programs Woody writes for itself run in its workbench, under another user with no access to the agent's files or to the system: see [WORKBENCH.md](WORKBENCH.md).

Inside the agent, the tools are still handed gated versions of the executor, the canvas and the store (`agent/src/core/gate.ts`, `woody-store.ts`), and one table says what a session may do (`agent/src/core/policy.ts`). That is structure, so that a rule is written once; it is not a security boundary against the agent's own code.

## What Woody can change freely

- `nix/modules/woody.nix`, its own module, for example to install packages.
- Documentation.
- Anything else that passes both tests.

Checked against the real configuration: adding a package and changing the time zone need no approval. Adding a root service, opening a firewall port, joining `wheel`, adding a sudo rule, weakening the agent's sandbox, replacing the executor's program, changing the agent's code and adding shell start-up code are all flagged.

When Woody acts on its own (a wake-up, a duty, its own time), it may apply a change only if that change goes to you for approval. The review decided to replace this by a trust dial (step E).

## Limits you should know

- **The fingerprint is a tripwire, not a proof.** A NixOS configuration is a program, and I cannot rule out every indirect route. The known gap: a package placed on the system path can ship its own D-Bus or polkit files. The agent has no way to call them today (it cannot gain privileges, by systemd setting), but it is a reason to read Woody's commits now and then.
- **The spending caps and Woody's rules are in the agent**, which is locked (see "The agent is locked"). For a limit that depends on nothing here, set one on the API key in the Anthropic console.
- **Your checkout must match the running system.** If you pull or edit without rebuilding, Woody is told to wait until you run `woody-rebuild`. This stops either of you from silently undoing the other's work.
- **Woody's commits are local.** Nothing is pushed. The checkout in the VM pulls with rebase, so Woody's commits are kept on top of what comes from GitHub; if both changed the same lines, git asks you to settle it.
- **One change at a time.** A second apply is refused while one is running.

## Looking at what happened

```bash
git -C ~/WoodPeckerOS log --author=Woody --stat
```

```bash
sudo woodyctl audit-tail 30
```

```bash
journalctl -u 'woody-selfmod-*' -n 80 --no-pager
```

Each candidate keeps its files, its diff and its log under `/var/lib/woody-execd/selfmod/candidates/`.

## If something goes wrong

The job restores the previous system by itself. If it could not, or the machine misbehaves after a change:

```bash
sudo woody-rebuild rollback
```

Older generations are in the boot menu, and the snapshot taken before each change is under `/.snapshots/` (see REBUILD-ROLLBACK.md).

## Tests

- 12 tests in the executor (55 in total): path and parameter validation, locked paths, indirect privilege changes, broken proposals leaving nothing behind, stale candidates, the apply and status life cycle, audit records without file contents.
- The fingerprint was evaluated against the real configuration with harmless and hostile edits.
- The repository check was run against a clean checkout, an uncommitted edit, a committed but not rebuilt edit, and an untracked file.
- **Not tested outside the VM:** the apply job itself (snapshot, trial activation, health check, rollback, commit). It needs systemd and Btrfs.
