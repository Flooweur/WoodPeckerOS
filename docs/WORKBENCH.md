# The workbench

Status: **built and tested in the VM** (2026-11-12, step C of [REVIEW.md](REVIEW.md)).

The workbench is where Woody runs real programs. Before it, Woody could look at the machine, keep records and make things for the canvas, but it could not compute, convert or handle a file. Now it can do work: rename three hundred files, convert a video, analyse a table, draw a chart with a program, try an idea.

Code: `executor/src/work.rs` (the action `work.run`), `nix/locked/workbench.nix` (the user, the disk, the firewall rule), the tool `run` in `agent/src/tools.ts`, the rule about the network in `agent/src/core/gate.ts` and `policy.ts`, the file exchange in `hud/server/files.ts` and `hud/web/src/frame/Files.tsx`.

## What a run is

Woody calls the tool `run` with a bash script. The executor runs it as the user `woody-work`, in a unit of its own, and returns what it printed.

| | |
|---|---|
| Where it starts | `/var/lib/woody-work/files`, the workbench's folder |
| Always there | bash, coreutils, grep, sed, awk, tar, zip, curl, git, jq, python3 |
| Anything else | Named in the request: `packages` (ffmpeg, imagemagick, pandoc...) or `python` (numpy, pandas, pillow...). Taken from the package set the system was built from, with no rebuild. A first use takes a while (ffmpeg: 12 seconds, numpy: 85 seconds); afterwards one or two seconds |
| Time | 60 seconds unless Woody asks for more, 10 minutes at most |
| Memory | 2 GB. A run that goes over is stopped at once, and the result says so |
| Output | 200,000 characters are kept; Woody is shown the beginning and the end |
| Disk | The workbench's own disk of 10 GB. A run can fill it and nothing else |
| At a time | One run |

Long jobs in the background (hours, with a wake-up at the end) are not built yet.

## What a run can see and reach

Measured in the VM:

| A run tried to | Result |
|---|---|
| List `/var/lib` | Sees only `woody-work` |
| Read Woody's mind, the API key, `/home`, the logs | No such file, or permission denied |
| Open the executor's or the agent's socket | Permission denied |
| See other processes | Sees only its own |
| Write to `/etc` | Read-only file system |
| Use `sudo` | Not there |
| Reach a web site, without having asked for the network | Cannot even resolve the name |
| With the network: a public site | Works |
| With the network: the HUD on this machine, the Windows host, the gateway | Blocked |

How:

- **Its own user**, with no rights and no other group. Woody's user is in the workbench's group, so Woody reads and writes the workbench's files; the reverse does not hold.
- **Its own unit**, in which nothing under `/var` exists except the workbench, the system is read-only, `/home` is hidden, and no privilege can be gained.
- **No network device** unless the run asked for one.
- **A firewall rule** on that user for when it did: public addresses on ports 80 and 443, the DNS server, and nothing else.
- **Its own disk**: a file of a fixed size, mounted at `/var/lib/woody-work`. It lives in its own Btrfs subvolume, so system snapshots do not carry it and a rollback of the system does not undo your files.

## The network, and why a run with it counts as reading the web

A program with the network can print a web page straight to Woody, around the reader that normally stands between Woody and the web. It could also send data out. So:

- **The network is asked for run by run**, and Woody is told to ask only when the work needs it.
- **Such a run counts as reading the web.** From then on the session follows the rules of one that read the web, and the workbench has no network for the rest of it. The addresses found in what the run printed become addresses the session was given.
- **A run without network is allowed in every session**, also one that has read the web: it can change the workbench's files and nothing else, and it has no way out. This is why the script's own code is never allowed to reach the Nix daemon or the name-service daemon: both can use the network on a caller's behalf. Programs are prepared by a first, separate step that runs only a command the executor wrote.

## Giving Woody a file, and taking a result

The workbench's folder has an `in` folder for what you give and an `out` folder for what Woody leaves you.

- **In the HUD**, the lattice menu has **Files**. "Give Woody a file" takes one or several; in your own browser you can also drop files anywhere on the page. Each result has a download button (in your own browser; the VM's own screen has nowhere to save to) and a remove button.
- **Woody is told and waits.** A line appears in the conversation, and the file is listed in front of Woody the next time you speak to it. No session is started by an upload.
- **Nothing in the folder is trusted.** A program Woody ran may have left anything there. A download is always sent as a file to save, never as a page; a path is used only if its real location is inside the folder; links are neither listed nor followed. Woody's own writes do not follow a link either.

A folder shared with the Windows host was decided against for now: it is a VMware feature and would not survive the move to a machine of its own.

## Limits to know

- **Not a proof.** The wall is the operating system's separation of users and the unit's settings. A flaw in the kernel could cross it. The executor, the audit log and the snapshots stand behind it.
- **What a run prints is data.** Woody is told so, like for every tool result. A file you give it may contain text written to mislead it.
- **A run with the network can fetch anything public**, including programs. They run inside the same walls.
- **Python libraries** come from the package set by name. One that is not in it needs a run with the network and `pip` into the workbench.
- **Every run is in the audit log**, with the script's hash, its size and its first 2,000 characters.

## Test status

| What | In containers | In the VM |
|---|---|---|
| Requests are validated; names of programs cannot carry code | 5 executor tests | |
| The unit's settings: no network unless asked; the script never reaches a daemon | Executor tests | Done |
| What a run can see and reach | | Done (the table above) |
| Named programs and Python libraries | | Done: ffmpeg, numpy; a wrong name gives a clear error |
| Limits: time, memory, output, disk | | Done |
| A run with the network makes the session one that read the web | Gate and loop tests | |
| Woody's file tools in the workbench; planted links are refused | Loop test (on Linux) | |
| Woody uses it by itself | | Done: it computed an average from a given file and left a report |
| Giving, listing, taking, removing files | 4 gateway tests, 8 browser checks | See below |
