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
| `agent/src/core/`, `agent/selfcheck.mjs` | The locked part of the agent: its protections, and the check on Woody's own code (see "The two parts of the agent") |
| `agent/package.json`, `agent/package-lock.json`, `agent/package.nix`, `agent/tsconfig.json` | How the agent is built and tested, including that check |
| `nix/modules/agent.nix` | How the agent is started and confined |
| `hud/` | The HUD carries your approvals |
| `flake.nix`, `flake.lock` | What the system is built from |
| `nix/hosts/` | Machine settings: host-only subnet, permanent deny list, spending caps, which modules are loaded |
| `nix/modules/base.nix` | Firewall, SSH, your user account |
| `nix/modules/secrets.nix`, `nix/modules/snapshots.nix` | Secrets and the rollback tool |

**2. It changes the privilege fingerprint.** The executor evaluates a fingerprint of the running system and of the proposed one, and compares them. This catches a change made indirectly, for example a harmless-looking file that overrides the firewall. The fingerprint covers:

- every systemd unit (services, sockets, timers), except the program Woody's own agent runs;
- the agent's sandbox settings and environment;
- users, groups, sudo, setuid programs, polkit and PAM;
- the firewall and SSH;
- activation scripts, temporary-file rules, udev rules, kernel parameters;
- shell start-up code and environment variables;
- Nix settings and package overlays;
- sensitive files under `/etc`.

## The two parts of the agent

Until Phase 10 all of `agent/` was Woody's to change, and the protections that were added over time lived in that same code: the rule that a session which read the web cannot act, the quarantined reader, the links-only rule, the budget, the limits on its identity, its safety instructions. Phase 10 lets Woody change its program unasked. So the agent now has two parts.

| Part | Where | Who changes it |
|---|---|---|
| Locked | `agent/src/core/` | Only with your approval |
| Woody's own | Everything else under `agent/src/` | Woody, by itself |

What is in the locked part:

- the loop that runs every session, and the safety instructions it puts in front of each one;
- the web tools, the quarantined reader and the links-only rule;
- the budget and every money limit;
- the mind's store, with the limits on Woody's identity;
- the connections to the executor and to the canvas.

What is Woody's own: how its prompts are put together, its memory, goal, interest, study and canvas tools, its system tools, its inner state, the rhythm of its day, and the rules its maker follows.

Both parts run in one process. Three things keep Woody's code within its part:

1. **It is handed gated things, never the real ones.**
   - The executor it gets refuses anything but looking once the session has read the web, and refuses an unasked change that would not go to you for approval.
   - The canvas it gets writes "asked for or not" and the sources of an explainer itself, whatever the caller says.
   - The store it gets has no operation that is yours (setting or restoring the identity, accepting a goal) or the loop's (the queue, the record of who said what, what a session cost). Whatever is written through it is written as Woody.
2. **A check runs with every build** (`agent/selfcheck.mjs`). Woody's code may import only its own files, a short list of constants from the locked part, and two libraries. It may not name anything that reaches the system or outlives a session (the process, the network, timers), load code at run time, or touch prototypes. A build that fails the check changes nothing.
3. **The agent refuses to start** unless node runs with code generation from strings switched off, so that code which is in no file cannot exist.

The tests of the locked part are locked too, and the build runs them.

This is a tripwire, not a proof. The check reads what is written; a property name hidden in a computed string would pass it. What does not depend on any of this stands outside the agent's process: the executor and its approvals, Pause, the firewall, the canvas's own rules in the HUD, and a spending limit you set on the API key.

## What Woody can change freely

- Its own part of the agent: everything under `agent/src/` except `core/`.
- `nix/modules/woody.nix`, its own module, for example to install packages.
- Documentation.
- Anything else that passes both tests.

Checked against the real configuration: adding a package, editing the agent's own part and changing the time zone need no approval. Adding a root service, opening a firewall port, joining `wheel`, adding a sudo rule, weakening the agent's sandbox, replacing the executor's program and adding shell start-up code are all flagged.

## Limits you should know

- **The fingerprint is a tripwire, not a proof.** A NixOS configuration is a program, and I cannot rule out every indirect route. The known gap: a package placed on the system path can ship its own D-Bus or polkit files. The agent has no way to call them today (it cannot gain privileges, by systemd setting), but it is a reason to read Woody's commits now and then.
- **The spending caps and Woody's instructions are in the locked part of the agent** since Phase 10 (see "The two parts of the agent"). That wall is a tripwire inside one process. For a limit that depends on nothing here, set one on the API key in the Anthropic console.
- **Your checkout must match the running system.** If you pull or edit without rebuilding, Woody is told to wait until you run `woody-rebuild`. This stops either of you from silently undoing the other's work.
- **Woody's commits are local.** Nothing is pushed. When you later `git pull`, git may ask you to merge.
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
