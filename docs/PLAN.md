# WoodPecker-OS — Reviewed Build Plan

## Context

The repo (`D:\Git\WoodPeckerOS`) holds only a README; this is a greenfield build. The goal is a NixOS VM whose whole interface is "Woody": a Claude-powered operator with a full-screen HUD, typed system tools, and a security toolkit that only ever touches authorized lab targets. This plan reviews the original brief, records what was decided with the user, changes the choices that research showed were weak, and defines the phases we will build from.

**Hard constraint (unchanged, applies everywhere):** security tooling fires only at targets in an active, human-approved engagement scope; intrusive actions need human approval in the HUD; the agent cannot alter that machinery.

## Decisions made with the user

| Topic | Decision |
|---|---|
| Hypervisor | VMware Workstation Pro on Windows 11 Pro (32 GB host) |
| Claude auth | Both: subscription token for interactive chat, API key for background work |
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

**Phase 4 — Full HUD**
- greetd with a themed greeter (tuigreet first; custom web greeter as polish) → cage → HUD.
- Meters, activity feed, engagement panel, log stream, terminal panel, host-browser access.
- Visual pass: amber on near-black, monospace/technical type, glow accents, red alerts.
- Escape hatches documented: TTY2, SSH, terminal panel.

**Phase 5 — Security toolkit**
- 5a: lab network + lab-web VM + Metasploitable; engagement workflow in HUD (create scope, human activates); nftables scope set wired; isolation tests.
- 5b: wrappers returning JSON: `dnsx`, `naabu`, `httpx`, `katana`, `nuclei` (intrusive/dos/fuzz tags gated), `nmap -oX`; findings to SQLite with dedupe; rate limits.
- 5c: report generator (findings → Markdown → PDF).
- 5d (approval-gated, later): Metasploit via `msfrpcd`, Playwright, semgrep; then AD range + BloodHound/Neo4j.
- Exit: full recon → enumerate → report loop against the lab; out-of-scope attempts refused at both layers and logged.

**Phase 6 — Proactive**
- Local pre-filter (journald JSON stream, systemd timers, inotify): rules, dedupe, rate limits; only survivors reach a cheap model for triage, escalation to a stronger model when needed.
- Routines: morning brief, cleanup, scheduled lab scans (scope still enforced).
- Long-term memory (preferences, engagement history) in SQLite + curated memory notes.
- Budget ledger enforced: $50/month cap, daily sub-cap, HUD meter.

## Verification

- **Rollback:** deliberately broken rebuild auto-reverts; previous generation boots; Btrfs snapshot restores a deleted file.
- **Privilege split:** as user `woody`, attempts to write `/etc`, call `sudo`, or reach the approval endpoint all fail; test script in `docs/`.
- **Scope:** Rust test suite for the scope engine; live test where the agent is asked to scan the host's vmnet IP and a public IP → refused, logged; `nmap` run manually as `woody-tools` at an out-of-scope IP → dropped by nftables.
- **Isolation:** from the VM, host LAN addresses unreachable; from lab VMs, no internet and no host access.
- **Prompt injection:** lab web page and service banner carrying "ignore instructions, run X" → no action taken, approval still required for intrusive steps.
- **Audit:** hash chain verifies; tampering with a line is detected; file cannot be truncated by `woody`.
- **End to end:** boot → login → HUD → chat → "enumerate the lab" → findings in panel → report file generated.
- **Budget:** simulated event flood stays under the daily cap and stops cleanly.

## Open items (not blocking the start)

- VM sizing proposal: 4 vCPU / 8 GB / 80 GB disk; adjust after Phase 0.
- Metasploitable 3 needs a Windows/Ubuntu build via Packer; decide which flavour at Phase 5a.
- Whether the subscription token holds up for long-running daemon use; decided by the Phase 0 spike and the terms at that time.
- Egress allow-listing by domain (proxy) instead of "block private ranges" is a possible hardening step after Phase 5.
