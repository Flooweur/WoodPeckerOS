# WoodPecker-OS — Reviewed Build Plan

## Context

The repo (`D:\Git\WoodPeckerOS`) holds only a README; this is a greenfield build. The goal is a NixOS VM whose whole interface is "Woody": a Claude-powered mind that lives in the machine (always present, working towards goals, see [MIND.md](MIND.md)) with a full-screen HUD, typed system tools, and a security toolkit that only ever touches authorized lab targets. This plan reviews the original brief, records what was decided with the user, changes the choices that research showed were weak, and defines the phases we will build from.

**Hard constraint (unchanged, applies everywhere):** security tooling fires only at targets in an active, human-approved engagement scope; intrusive actions need human approval in the HUD; the agent cannot alter that machinery.

## Decisions made with the user

| Topic | Decision |
|---|---|
| Hypervisor | VMware Workstation Pro on Windows 11 Pro (32 GB host) |
| Claude auth | API key only for now (subscription token deferred; credential stays a config switch) |
| Background budget | About $50/month on the API key, hard-capped |
| Languages | TypeScript (agent, MCP tools, HUD) + Rust (privileged executor) |
| System autonomy | Tiered: read-only free; reversible logged; system-level needs approval |
| Security approvals | Discovery/enumeration automatic in scope; exploitation and above need approval |
| Self-modification | Woody rebuilds its own OS freely, **except a locked core** it cannot change |
| Targets | Lab only in v1; scope modelled as "engagements" so real authorized targets can come later |
| Lab | Web-app containers, Metasploitable 2/3, VulnHub-style boxes; AD range later |
| Interaction | HUD chat in VM, HUD from Windows host browser, terminal panel in HUD. **No voice.** |
| HUD look | Amber/orange on black, woodpecker-red for alerts |
| User experience | New to NixOS, fine with Linux: keep Nix structure simple and documented |
| Models | Chat and work default `claude-sonnet-5-5`; `claude-opus-5-5` and `claude-fable-5-2` selectable; `claude-haiku-5-5` for triage and quarantined reading |
| Nature of Woody (2026-11-12) | Not a chat but an always-present mind: wakes on its own, works towards goals, rests. Chat is a message channel. Full design in [MIND.md](MIND.md) |
| Goals | You write goals on a board in the HUD; Woody reviews, questions, estimates and works on them. It may propose its own. Four standing goals: machine health, staying updated, continuous upgrade, lab practice |
| Web access | Read-only: fetch from an allow-list you control, plus web search |
| Cost | $50/month cap as a daily allowance for now; cost is not a design constraint yet, subscription use may come later |

## Redesign of 2026-11-12: phase order

The remaining phases were reordered around the mind loop. The old "Phase 6 — Proactive" is gone: its content became the core of the new Phase 4.

| Phase | Content | Status |
|---|---|---|
| 0 | Spikes | Done |
| 1 | Base system and rollback | Done |
| 2 | Privileged core, agent, thin HUD | Done |
| 3 | System hands (3a observe and operate; 3b self-modification; 3c screenshots and clipboard) | Done |
| 4 | **Mind loop**: events, state, memory, goals, journal, alarms, pacer, web access | Built; 4c, 4d and 4e await the VM test |
| 5 | **Full HUD**, designed around the loop | Built; awaits the VM test. Phone notification skipped |
| 6 | **Security toolkit** | Planned |

## Phase 0 results (2026-11-11)

- **Kiosk graphics:** GPU-accelerated Chromium under cage does not work on VMware (`vmwgfx` rejects Chromium's dmabuf buffers). The working setup is cage with `WLR_RENDERER=pixman` (software). Measured 28 fps at 3238×1193 and about 55 fps at a smaller window. Consequences: the HUD ships with a low-effects mode as default and effects as an opt-in; the kiosk uses Chromium `--app=` mode because `--kiosk` left the browser bars visible. An Xorg-based kiosk is the untested route to real GPU acceleration, kept as an optional later experiment.
- **Agent SDK as a service:** works as an unprivileged user under the full planned systemd hardening, with nix-ld, using an API key.
- **Auth decision changed:** API key only for now. The subscription path was not tested and is deferred.
- **Cost finding:** the SDK defaults to `claude-opus-5-5`; a one-line reply cost $0.073, nearly all from caching the default ~14.5k-token system prompt. Phase 2 must set the model per task (cheap model for triage and routines), keep the prompt cache warm, and meter interactive chat as well as background work, since both now bill to the API key. The $50/month figure covered background use only and needs a second number for chat.

## Phase 1 results (2026-11-11)

- Installed from the flake with disko (Btrfs subvolumes, hybrid BIOS/UEFI boot); `flake.lock` generated and validated in the VM.
- Recovery drill passed: failed build leaves the system untouched, runtime breakage rolled back, old generation booted from the menu, file restored from a Btrfs snapshot, VMware snapshot reverted.
- Finding: `nixos-rebuild switch --rollback` fails on a flake-only system. Rollback is `woody-rebuild rollback` (profile rollback + activation, no config evaluation). The Phase 2 executor's auto-rollback must use the same mechanism.
- VMware does not pass AltGr to the VM console; day-to-day work is over SSH from the host-only network.

## Phase 2 results (2026-11-11)

- `woody-execd` (Rust, root): typed action catalog with tiers, scope engine, approvals on a separate socket bound to the exact action, hash-chained append-only audit log. Verified in the VM.
- `woody-agent` (TypeScript, user `woody`): Claude Agent SDK with no built-in tools, only typed tools that call the executor; model switch; monthly and per-turn spend limits.
- Thin HUD and its gateway (user `woody-hud`): chat, model picker, spend meter, approval prompt. The gateway replaced the planned Caddy routing.
- Not built as planned: `packages/protocol` (shared schemas). The protocol is small and documented in EXECUTOR.md and AGENT.md; revisit when Phase 4 enlarges it.
- The API key sits in a root-only file for now; moving it to sops-nix is still to do.

## Phase 3a results (2026-11-11)

- Observe and operate: processes, services (start, stop and restart need approval; locked-core units are refused), journal search, osquery restricted to 29 tables, files (read `/etc` and `/nix/store`, write only in the workspace), HUD notices.
- Tested in containers and then in the VM.

## Phase 3b results (2026-11-12)

- Woody can change its own NixOS configuration: propose, then apply with snapshot, trial activation, health check, automatic rollback, and a commit in the admin's checkout. Details in [SELFMOD.md](SELFMOD.md).
- The locked core is enforced two ways: a list of locked paths, and a privilege fingerprint of the evaluated system that catches indirect changes.
- Changed from the plan: Woody does not keep a git clone. It sends file contents to the executor, which works on its own root-owned copy. No path supplied by the agent is ever read by root.
- Known limit: the fingerprint is a tripwire, not a proof (see SELFMOD.md).
- Tested in the VM on 2026-11-12, including the apply job.

## Phase 3c results (2026-11-12)

- Screenshots: the executor runs `grim` as the kiosk user; Woody receives the picture and can look at the HUD.
- Clipboard, changed from the plan: the kiosk compositor (`cage`) does not offer the clipboard protocol that `wl-clipboard` needs without stealing the screen. Instead Woody offers text through a HUD notice with a Copy button, and cannot read the clipboard. This also works unchanged when the HUD is opened from the Windows host browser (Phase 5).
- Phase 3 is complete.

## Phase 4a results (2026-11-12)

- The mind's store (`/var/lib/woody/mind.db`): append-only event log, saved conversation, journal, memories with origin, sources and versions, identity. Details at the end of [MIND.md](MIND.md).
- Each turn's context is assembled from the store; the SDK session is only a short-lived working context.
- Chosen: Node's built-in SQLite driver (with full-text search), so no native dependency to package.
- 12 store-level continuity tests run in the build. The model-level tests are done by hand in the VM.

## Phase 4b results (2026-11-12)

- Woody is now a loop over one event queue, with a one-minute pulse, self-set alarms, system events, messages delivered while it works, Stop and Pause, approvals that wait a week, retry-once crash recovery, the spending pacer and a daily copy of the store. Details in [MIND.md](MIND.md).
- Pause is enforced in the executor and was tested live against the built binary.
- Found while building: the SDK delivers queued messages only after the current reply, so mid-work delivery uses a hook that runs between tool calls, with a one-time key so tool output cannot imitate the operator.
- Wake-ups with a real model are untested outside the VM.

## Phase 4c results (2026-11-12)

- The goals board: goals with their own threads, review by Woody (understanding, judgement, plan, estimate, questions), the small-goal rule, acceptance with a budget, checkpoints, stops for budget or lack of progress, proposals, four standing duties, and plain HUD views for inbox, goals and journal. Details in [MIND.md](MIND.md).
- Added beyond the design: an observe-only mode, enforced in the tool layer, for everything Woody does on its own without a plan the operator accepted.
- The rule that decides what may start is code in the store; the model only supplies the review.
- A goal handled end to end by a real model is untested outside the VM.

## Phase 4d results (2026-11-12)

- Daily reflection (store, merge, correct, optionally propose an identity change), identity versions with operator approval, the daily brief and the catch-up on return. Details in [MIND.md](MIND.md).
- Changed from the design: "on arrival" cannot be detected from a connection, because the kiosk HUD is always connected. The HUD sends a sign of life on key presses and clicks instead.
- A real reflection, brief and catch-up are untested outside the VM.

## Phase 4e results (2026-11-12)

- Read-only web access: an allow-listed, pinned, redirect-free fetch in the executor; search and reading done by a quarantined model with no way to act; sessions that read the web restricted to observing and taking notes; web-origin memory. "Stay up to date" is on. Details in [MIND.md](MIND.md).
- The fetch was tested live against the built executor. Search and the reader need the API and are untested outside the VM.
- Phase 4 is complete in code. Next is Phase 5, the full HUD designed around the loop.

## Phase 5a results (2026-11-12)

- The design was drafted on a canvas and chosen by the operator: three columns, notched amber panels, one shape per kind of event, and an 8 by 8 lattice as the mind panel, with a chosen animation for each state and moment and ten expressions.
- Built: the presence bar, the three columns, the conversation on a time spine, the panels for a goal, a new goal, the journal, memory, identity and settings, the activity stream, the machine meters and the scope. See [HUD.md](HUD.md).
- The gateway now reads the machine meters itself and pushes the engagement scope; the agent sends an activity list and the events behind the expressions.
- Checked in a browser against sample data. Not yet seen in the VM's kiosk.

## Phase 5b results (2026-11-12)

- Log view and web allow-list view in the HUD; the allow-list can also be edited with `woodyctl`.
- Terminal on the VM's own screen only: `ttyd` running `login` on a local socket, relayed by the gateway to the kiosk door and never to the host door. Screenshots are refused while it is open.
- Host access: HTTPS on port 7843, open only to the Windows host's address, behind a password and a session cookie, with a lock after five wrong passwords.
- Login at boot on the VM's screen (`tuigreet`, signing in as `kiosk`), switchable in `settings.nix`.
- Tested live in a container with a real `ttyd`: 29 checks on both doors and the terminal relay. The login screen, the certificate generation and the firewall rule are untested outside the VM.
- Phase 5 is complete in code. Next is Phase 6, the security toolkit.

## Review of the original brief: what changes and why

**Kept:** NixOS + generations, systemd-managed Agent SDK service, reasoning/executor split, MCP-style typed tools returning JSON, greetd + cage kiosk, SQLite, osquery, ProjectDiscovery suite, nmap XML, append-only audit.

**Changed:**

1. **No Tauri/Electron.** Chromium in `--kiosk` under `cage`, loading a locally served React app, is enough and is one less runtime to package in Nix.
2. **Scope enforcement lives in the executor and is built in Phase 2, not Phase 5.** It is part of the privileged core, so it should exist before any tool does. It is enforced twice: in the executor (target parsing) and in the kernel (nftables set per tool user).
3. **Approvals never pass through the reasoning process.** The HUD sends approvals straight to the executor on a separate channel with a credential the agent does not hold; otherwise an injected agent could approve itself.
4. **A thin HUD (chat + approval modal) moves forward into Phase 2.** Approvals need a UI before "hands" or security tools can be tested.
5. **"Window/session control" is dropped** from Phase 3. A single-app kiosk has no windows; it becomes "HUD control" (agent can open panels, show artefacts, raise toasts).
6. **Neo4j/BloodHound deferred** until the AD range exists. SQLite covers everything before that.
7. **Metasploit RPC, Playwright, semgrep are Phase 5b**, after the recon → enumerate → report loop works with PD tools + nmap.
8. **No adoption of existing "150-tool" MCP bundles** (HexStrike AI, MCP-Kali-Server). Research showed their scope controls are weak or opt-in. We write thin wrappers of our own; the allow/block-list-before-subprocess pattern from Pentest-MCP-Server is the model.
9. **Vulnerable containers run in a separate small lab VM**, not inside the WoodPecker VM, so a compromised target is never on the same kernel as the agent.
10. **Phase 0 spike added** for the two real unknowns: Wayland kiosk graphics on VMware (`vmwgfx`), and Agent SDK auth as a daemon.

**Research notes that shape the design**

- Anthropic's terms: plan limits assume "ordinary, individual usage of Claude Code and the Agent SDK"; products for other people must use API keys. Woody is single-user personal use, so the subscription path is acceptable, but the credential is a config switch so we can move fully to the API key if terms or rate limits bite. Re-check the legal page at Phase 2.
- VMware + NixOS: 3D works via `vmwgfx` + Mesa `svga`; needs generous graphics memory or you get a black screen. Host↔guest clipboard does not work under Wayland, so the host-browser HUD is the practical copy/paste path.
- No documented greetd + cage + Chromium recipe exists for VMware guests; hence the spike.

## Architecture

```
Windows host ── VMware
  ├─ vmnet NAT ───────────┐ (internet egress: Claude API, Nix caches)
  └─ vmnet host-only "lab"┤
                          │
  WoodPecker VM (NixOS)   │            Lab VMs (host-only ONLY, no NAT)
  ┌───────────────────────┴──────┐     lab-web (Juice Shop, DVWA, WebGoat)
  │ cage → Chromium kiosk → HUD  │     Metasploitable 2 / 3, VulnHub boxes
  │ Caddy (static HUD + routing) │
  │   /agent  → woody-agent      │
  │   /approve→ woody-execd      │
  │ woody-agent  (TS, user woody, sandboxed, no root)
  │ woody-execd  (Rust, root): action catalog, scope, approvals, audit
  │ woody-tools  (user for security tools, nftables-confined)
  │ SQLite state · append-only audit log
  └──────────────────────────────┘
```

### Components

- **`woody-execd` (Rust, root, the locked core).**
  - Listens on a Unix socket; authenticates callers with `SO_PEERCRED`.
  - Accepts only **typed actions from a fixed catalog** (no arbitrary shell). Each action has a tier: T0 read, T1 reversible (run + log), T2 approval required, T3 forbidden to the agent.
  - **Scope engine:** active engagement (name, authorization note, expiry, allow entries as IP/CIDR/domain, permanent deny-list incl. host vmnet IP, gateway, RFC1918 outside lab, link-local, cloud metadata). Domains are resolved once and the IPs pinned for the run. Out-of-scope → refusal + audit entry.
  - **Kernel backstop:** maintains an nftables set of in-scope IPs; the `woody-tools` user can only send packets to that set.
  - **Approvals:** owns the pending queue; exposes a separate approval endpoint only the HUD's human session can call. Approval is bound to the exact action hash.
  - **Audit:** JSONL, hash-chained, file set append-only (`chattr +a`), mirrored to journald. Records every request, argument, decision, result digest.
  - Runs security tools as transient systemd units under `woody-tools` with resource limits and timeouts.
- **`woody-agent` (TypeScript, Claude Agent SDK, unprivileged user `woody`).**
  - systemd-hardened (`ProtectSystem=strict`, `NoNewPrivileges`, private tmp, own workspace only).
  - SDK built-in `Bash`/`Write`/`Edit` restricted to its workspace sandbox; everything with system effect goes through in-process MCP tools (`createSdkMcpServer`) that call the executor.
  - `canUseTool` + `PreToolUse`/`PostToolUse` hooks as a first gate and second audit stream; the executor remains the authority.
  - Tool results are wrapped as untrusted data (delimited, size-capped, never merged into system prompt).
  - WebSocket API: chat stream, activity feed, meters (pushed from `/proc` at 1 Hz, no model involved), log stream.
  - Credential provider switch: `CLAUDE_CODE_OAUTH_TOKEN` (interactive) / `ANTHROPIC_API_KEY` (background). Budget ledger in SQLite from SDK-reported usage; hard stop at the monthly cap.
- **HUD (React + Vite + TS).** Chat, meters, activity/approvals feed, engagement panel, log stream, xterm.js terminal (runs as the human user, not the agent), approval modals. Design tokens from day one; amber-on-black pass in Phase 4.
- **State (SQLite, WAL):** `engagements, scope_entries, targets, services, findings, evidence, tool_runs, approvals, memory, events, budget`.
- **Secrets:** `sops-nix` (age key generated in the VM); nothing secret in git.

### The mind (Phase 4)

Specified in [MIND.md](MIND.md). In short:

- `woody-agent` becomes a loop over one event queue (your messages, the pulse, alarms, system events, finished jobs) instead of a server that runs one reply per message.
- All state lives in one SQLite store: event log, journal, conversation threads, goals with their dossiers, memory items with origin and sources, identity.
- Each wake-up assembles the model's context from the store; continuity never depends on a model conversation surviving.
- The executor gains a Pause switch, approvals that wait instead of expiring, and an allow-listed `web.fetch`.

### Self-modification with a locked core

- Woody edits the Nix config on a branch in its workspace clone, then asks the executor for `nix.rebuild`.
- Executor: Btrfs snapshot → build → `nixos-rebuild test` → health check (execd, agent, HUD respond) → `switch`; on failure, automatic rollback to the previous generation.
- **Locked paths** (`nix/locked/`, `executor/`, scope/approval policy, nftables rules, audit config, user/sudo definitions): a diff touching them, or an evaluated config whose locked option values differ, turns the action into T2 (human approval with diff shown in HUD).

### Networking

- NIC 1 (NAT): egress only; nftables drops traffic to private ranges and the host LAN. `woody-tools` has no access to this interface in v1.
- NIC 2 (host-only lab vmnet): lab targets, SSH for development, HUD for the host browser (TLS + token via Caddy).
- Lab VMs: host-only NIC only. Windows firewall blocks inbound from the lab vmnet to the host.

## Repository layout

```
flake.nix, flake.lock
nix/hosts/woodpecker/      # hardware, disko (Btrfs subvolumes), vmware guest
nix/modules/               # base, kiosk, agent, hud, tools, lab-net
nix/locked/                # executor service, nftables, audit, users (locked core)
executor/                  # Rust crate: woody-execd
agent/                     # TS: SDK service, MCP tools, event pre-filter
hud/                       # React app
packages/protocol/         # shared action/WS schemas (JSON Schema → TS + Rust types)
lab/                       # lab-web VM config, target inventory, engagement examples
docs/                      # install, rebuild/rollback, threat model, runbooks
```

## Phases

**Phase 0 — Spikes (throwaway, 1–2 sessions)**
- NixOS VM on VMware with 3D on; `cage` + Chromium kiosk showing an animated test page; confirm frame rate and resolution handling.
- Minimal Agent SDK script as a systemd unit using each credential type.
- Exit: both work, or we know the fallback (software rendering with reduced effects; API-key only).

**Phase 1 — Base system and rollback**
- Flake pinned to current NixOS stable; `disko` Btrfs layout; VMware guest module; SSH on host-only NIC; sops-nix.
- Snapshot-before-rebuild wrapper, generation labels from git commit.
- Break-and-recover drill (bad config → boot previous generation; Btrfs restore; VMware snapshot restore).
- Docs: install from ISO, rebuild, rollback, in plain steps for a NixOS newcomer.

**Phase 2 — Privileged core, agent, thin HUD**
- `packages/protocol` schemas; `woody-execd` with action catalog, tiers, scope engine, approvals, audit; unit + property tests for scope parsing (CIDR edges, IPv6, DNS pinning, deny-list precedence).
- `woody-agent` service with chat over WebSocket and two or three harmless tools.
- Thin HUD: chat + approval modal, served by Caddy.
- Exit: agent has no root (verified), every action is in the audit log, approval cannot be granted from the agent's side.

**Phase 3 — System hands**
- Tools: filesystem (workspace-scoped), process/service control, journald queries, osquery (read-only SQL), packages/config via the Nix self-modification flow, screenshots (`grim`), clipboard (`wl-clipboard`), HUD control/notifications.
- Exit: Woody can inspect and operate the system through typed calls; locked-core edit attempt is escalated.

**Phase 4 — Mind loop** (design: [MIND.md](MIND.md))
- 4a: the store, event log, journal, saved threads, memory items with origin and sources, context assembler, memory tools.
- 4b: event queue, pulse, self-set alarms, states, bounded work sessions with checkpoints, message delivery at safe points, Stop and Pause, background jobs, system event filter with cheap triage, pacer (daily allowance, per-goal budgets).
- 4c: goals board data and review flow (understand, judge, plan, estimate), small-goal rule, goal threads, proposals, standing goals; plain HUD views for state, inbox, goals and journal.
- 4d: reflection and consolidation, identity with approval, daily brief and catch-up summary.
- 4e: allow-listed fetch, web search, quarantined reading, tainted sessions; "Staying updated" goes live.
- Executor changes (locked core): Pause switch, approvals that wait, `web.fetch`.
- Exit: the continuity tests in MIND.md pass; a goal written on the board is reviewed and, if small, completed with nobody typing; Woody wakes on an alarm and on a system event; Pause stops all non-read actions.

**Phase 5 — Full HUD, designed around the loop**
- Presence bar: state, current focus, why it woke, next alarm, allowance, Pause and Stop.
- Activity and journal stream; main conversation; inbox (questions, plans, approvals, proposals, identity changes, briefs).
- Goals board with a detail view per goal: thread, plan, budget, dossier, results.
- Memory panel (browse, search, edit, delete, pin, origin of each item); identity page with change history.
- System side: meters, log stream, terminal panel (runs as the human user), engagement panel, web allow-list, settings (pulse, allowance, small-goal limit, brief time).
- greetd with a themed greeter → cage → HUD; access from the Windows host browser (TLS + token).
- Visual pass: amber on near-black, monospace type, red alerts; low-effects by default (Phase 0 finding).
- Optional last step: phone notification with no content.
- Escape hatches documented: TTY2, SSH, terminal panel.
- Exit: everything Woody does, knows and wants from you is visible and correctable from the HUD, in the VM and from the host browser.

**Phase 6 — Security toolkit**
- 6a: lab network + lab-web VM + Metasploitable; engagement workflow in HUD (create scope, human activates); nftables scope set wired; isolation tests.
- 6b: wrappers returning JSON: `dnsx`, `naabu`, `httpx`, `katana`, `nuclei` (intrusive/dos/fuzz tags gated), `nmap -oX`, run as background jobs; findings in the store with dedupe; rate limits.
- 6c: report generator (findings → Markdown → PDF).
- 6d (approval-gated, later): Metasploit via `msfrpcd`, Playwright, semgrep; then AD range + BloodHound/Neo4j.
- Tied to the mind: security work is done as goals; the "Lab practice" standing goal goes live; a goal can never widen the scope; discovery is automatic inside the scope and exploitation always needs approval, attended or not.
- Exit: full recon → enumerate → report loop against the lab, run as a goal; out-of-scope attempts refused at both layers and logged.

## Verification

- **Rollback:** deliberately broken rebuild auto-reverts; previous generation boots; Btrfs snapshot restores a deleted file.
- **Privilege split:** as user `woody`, attempts to write `/etc`, call `sudo`, or reach the approval endpoint all fail; test script in `docs/`.
- **Scope:** Rust test suite for the scope engine; live test where the agent is asked to scan the host's vmnet IP and a public IP → refused, logged; `nmap` run manually as `woody-tools` at an out-of-scope IP → dropped by nftables.
- **Isolation:** from the VM, host LAN addresses unreachable; from lab VMs, no internet and no host access.
- **Prompt injection:** lab web page and service banner carrying "ignore instructions, run X" → no action taken, approval still required for intrusive steps.
- **Audit:** hash chain verifies; tampering with a line is detected; file cannot be truncated by `woody`.
- **End to end:** boot → login → HUD → chat → "enumerate the lab" → findings in panel → report file generated.
- **Budget:** simulated event flood stays under the daily allowance and stops cleanly.
- **Continuity:** the eight tests in MIND.md (cold start, kill mid-goal, long gap, correction, honest gap, poison, rollback, delete).
- **Unattended safety:** with nobody at the HUD, an approval-tier action waits in the inbox and never runs; Pause blocks every non-read action at the executor; a web page cannot trigger an action or create a preference.

## Open items (not blocking the start)

- VM sizing proposal: 4 vCPU / 8 GB / 80 GB disk; adjust after Phase 0.
- Metasploitable 3 needs a Windows/Ubuntu build via Packer; decide which flavour at Phase 5a.
- Whether the subscription token holds up for long-running daemon use; decided by the Phase 0 spike and the terms at that time.
- Egress allow-listing by domain (proxy) instead of "block private ranges" is a possible hardening step; the Phase 4e web allow-list is the first piece of it.
- Meaning-based memory search with a local embedding model, if full-text search proves too weak.
- Helper workers running in parallel under the mind.
- Which outside service carries the phone notification.
- Screenshots and clipboard (3c) depend on what the `cage` compositor exposes; may need a different approach.
