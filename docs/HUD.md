# The HUD

What you see when the VM boots: a full-screen page for talking to Woody and approving what it asks to do. Source in `hud/`, NixOS module in `nix/locked/hud.nix`.

This is the thin Phase 2 version: chat, model picker, spend meter, approval prompt. The conversation is stored by the agent and shown again after a reload. The top bar shows what Woody is doing (answering you, working, resting, waiting on you, paused) and has a **Pause** button, which stops everything Woody does on its own until you resume. You can send a message while Woody is working. Three buttons open plain side views: **inbox** (what needs you), **goals** (the board, where you add goals, accept plans and talk to Woody about one goal) and **journal**. Plain views for Woody's state, inbox, goals and journal come with the mind loop in Phase 4 (see [MIND.md](MIND.md)). The full HUD, designed around that loop (goals board, memory panel, meters, log stream, terminal, visual pass), is Phase 5.

## Parts

- **Gateway** (`hud/server/gateway.ts`, service `woody-hud`, user `woody-hud`): serves the page on `127.0.0.1:7800`, relays chat to the agent's socket, and sends your approve/deny decisions to the executor's approval socket.
- **Web app** (`hud/web/`, React): the page itself.
- **Kiosk** (`nix/modules/kiosk.nix`): Chromium in app mode under `cage`, opening the gateway's bootstrap page.

## How access is controlled

Any local process can connect to a loopback port, including the agent. So the gateway requires a secret token for everything except static files:

1. The gateway keeps a token in `/var/lib/woody-hud/token` (its own user only).
2. At start it writes `/run/woody-hud/boot.html`, readable only by the `woody-kiosk` group. The agent's user is not in that group.
3. The kiosk opens that file, which loads the HUD with the token in the URL fragment. The page stores it for the session and removes it from the address.
4. The WebSocket is refused without the token or from a foreign origin.

Each approval click carries the hash of the exact action shown in the prompt; the executor rejects it if the pending action differs.

## Using it

- Type in the box at the bottom. Enter sends, Shift+Enter adds a line.
- The **model** menu switches between Sonnet 5.5, Opus 5.5 and Fable 5.2 for the next message.
- **New chat** starts a fresh conversation. The transcript on screen is not restored after a page reload yet.
- Tool calls appear as collapsed rows; click one to see what came back.
- When Woody requests an approval-tier action, a red prompt appears. Keyboard focus starts on **Deny**.
- The three dots at the top show whether the HUD link, the agent and the executor are up.

## If the screen is blank or stuck

```bash
systemctl status woody-hud woody-agent woody-execd --no-pager | grep -E "●|Active"
```

```bash
journalctl -u woody-hud -n 30 --no-pager
```

```bash
journalctl -t woody-kiosk -b --no-pager | tail -30
```

Restart the kiosk session:

```bash
sudo systemctl restart greetd
```

`sudo woody-chat` and `sudo woodyctl` keep working from SSH whatever the HUD is doing.

## Known limits

- VMware does not pass AltGr to the VM, so characters like `#` or `@` are hard to type in the kiosk. Access from the Windows host browser (Phase 5) will solve this.
- The page is reachable only inside the VM for now.
