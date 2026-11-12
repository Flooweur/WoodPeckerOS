# Security toolkit: purpose, limits and how to use it

## What this is for

The security tools in WoodPecker-OS are for one thing: the owner practising on their own machines, in a home lab on an isolated network. The lab is this VM plus deliberately vulnerable practice VMs (Metasploitable and similar) that can talk to nothing else.

Nothing here is built to test machines the owner does not own or hold written authorization for. That is not left to good intentions: the limits below are enforced in software, in the part of the system Woody cannot change.

## The safeguards

| Safeguard | What it does | Where |
|---|---|---|
| Engagement | Tools work only against targets listed in an engagement that a human set, with a stated authorization and an end time (72 hours at most). No engagement means every target is refused. | `executor/src/scope.rs`, `server.rs` |
| Lab limit | An engagement can list only addresses inside the lab network (`labSubnet`). Hostnames and anything outside are refused. Changing this needs a human edit to a locked file. | `nix/locked/executor.nix` |
| Permanent deny | The Windows host and the VMware gateways are never a target, whatever an engagement says. | `settings.nix`, both layers |
| Kernel filter | Tools run as the user `woody-tools`. The kernel drops every packet that user sends to an address outside the engagement. With no engagement it can reach nothing. | `nix/locked/scope-net.nix` |
| Human only | Only the approval channel (the HUD, or `sudo woodyctl`) can set or end an engagement. Woody's user cannot open that channel. A goal can never widen the scope. | `executor/src/server.rs` |
| Approval | Discovery and enumeration inside the engagement run by themselves. Anything intrusive waits for your approval in the HUD. | Phase 6b onward |
| Audit | Every engagement change, scope check, kernel filter update and tool call is written to the hash-chained, append-only audit log. | `/var/log/woody/audit.jsonl` |
| Pause | The Pause switch stops everything that is not read-only. | HUD, `woodyctl pause` |
| Tool output is data | Banners, pages and headers from targets are attacker-controllable. They are passed to Woody as quoted data and never as instructions. | Phase 6b onward |

The two scope layers are independent. The executor checks the target before a tool starts; the kernel filter then holds even if a wrapper has a bug or a tool follows a redirect.

## Set up the lab

1. **Keep the lab network isolated.** Lab VMs get one network adapter, set to **Host-only (VMnet1)**. Never give a vulnerable VM a NAT or bridged adapter.
2. **Block the lab from the Windows host.** In an administrator PowerShell on Windows:

```powershell
New-NetFirewallRule -DisplayName "Block lab to host" -Direction Inbound -RemoteAddress 192.168.222.0/24 -Action Block
```

   This also blocks the WoodPecker VM from reaching Windows, which is intended. SSH and the HUD go from Windows to the VM, so they keep working.
3. **Add a first target: Metasploitable 2.** Download it from Rapid7 (or its SourceForge mirror), unzip it, and open the `.vmx` file in VMware. Before starting it, set its network adapter to Host-only (VMnet1). Log in as `msfadmin` / `msfadmin` and run `ip addr` to read its address.

## Use it

Open **SCOPE** in the HUD, list the target addresses, state whose machines they are, choose a duration and confirm. The same from SSH:

```bash
sudo woodyctl engagement-set home-lab 8 "My own Metasploitable VM on the isolated host-only network" 192.168.222.130
```

```bash
sudo woodyctl scope
```

```bash
sudo woodyctl engagement-end
```

An engagement ends by itself when its time is up.

## Check that the barrier holds

Run this after every rebuild that touches the firewall, and whenever you want proof:

```bash
sudo woody-isolation-test
```

It tries, as the tools user, to reach the Windows host, the gateways, the internet and this machine's own services. Every attempt must be blocked. With an engagement active, add a lab target and an open port to also check that the allowed path works:

```bash
sudo woody-isolation-test 192.168.222.130:80
```

From a lab VM, also check by hand that it cannot reach the internet (`ping 1.1.1.1` must fail) or the Windows host.

## Known limits

- The kernel filter covers the tools user only. Woody's own process still reaches the internet for the Claude API and its allow-listed web reading.
- Hostname targets are not possible while the lab limit is on.
- When the firewall reloads (a rebuild), the kernel set is empty for up to 15 seconds. Tools are blocked during that time, never opened.
- The tool wrappers themselves (port scans, web probes, reports) come in Phase 6b and later.
