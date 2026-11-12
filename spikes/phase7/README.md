# Phase 7a: spikes for the canvas

Throwaway experiments that answer three questions before the canvas is built ([PLAN.md](../../docs/PLAN.md), Phase 7):

1. **Frame rate.** How many isolated things can the software-rendered kiosk carry?
2. **Isolation.** Is a thing really sealed in its frame: no network, no access to the frame page, the access token or other things?
3. **Making.** How long does each model take to write a thing, what does it cost, and does what it wrote start in the sandbox?

Nothing here is kept. The parts worth keeping (the bridge, the policy of a thing, the maker's instructions) are rewritten properly in 7b to 7d.

## What is in here

| Path | What it is |
|---|---|
| `serve.mjs` | A small server with no dependencies. It serves the test canvas the way the gateway is meant to, and plays the outside world: whatever reaches it from a thing is recorded as a leak |
| `canvas/` | The frame page (`index.html`, `frame.js`), the bridge given to every thing (`bridge.js`), and the sample things |
| `canvas/things/probe.html` | A hostile thing that tries every way out of its frame |
| `bench/` | The making benchmark (official Anthropic SDK) |
| `run.sh` | Runs the benchmark and the screen test in the VM |

How a thing is served, which is the design under test:

- A thing's source is an HTML fragment. The server puts it in a document it owns, with the bridge script first.
- That document is sent with a policy that allows inline code only and forbids every network use, and it is shown in a frame with `sandbox="allow-scripts"`. The thing therefore has no origin of its own: no storage, no cookies, no access to the page around it.
- The frame page has its own strict policy and only allows frames from the things path.
- The WebRTC interfaces are removed from the thing's page before its code runs, and the kiosk's browser is started with WebRTC confined. The policy alone cannot forbid them: this spike found that hole. `node serve.mjs --keep-webrtc` shows it.
- The bridge is `postMessage`. The frame page knows who is speaking from the window the message came from, never from what the message claims.

## Run it in the VM

After `git pull` and `woody-rebuild` (the rebuild adds the hook that lets the kiosk open a test page):

```bash
cd ~/WoodPeckerOS && ./spikes/phase7/run.sh bench
```

This asks four models (Haiku 5.5, Sonnet 5.5, Opus 5.5, Fable 5.2) for three things each, at low effort. It spends about $1 on the API key, and at most about $2.50 if every answer ran to its limit. This spending is outside Woody's own ledger. It prints a table of seconds and dollars.

```bash
cd ~/WoodPeckerOS && ./spikes/phase7/run.sh screen
```

Then sign in as `kiosk` on the VM's screen. The test runs by itself for about three minutes; keep the VM's window visible. The results are printed in the SSH terminal. At the end the VM's screen shows the things the models made: look at them, then press Enter in the terminal to get the HUD back.

Send back the two blocks of text the commands print, and say what the made things looked like.

## Results

### In a container, with the VM's Chromium build (2026-11-12)

Run headless, so the frame rates mean nothing there; isolation and the runner itself are what was tested.

| Question | Result |
|---|---|
| Ways out tried by the hostile thing | 33. All blocked once WebRTC was dealt with (32 before) |
| The one hole found | WebRTC: a thing could send packets to any address. The browser does not know the policy directive meant to forbid it |
| Fix 1 (kiosk) | Browser flag `--webrtc-ip-handling-policy=disable_non_proxied_udp`: no packet left. The similar flag `--force-webrtc-ip-handling-policy` did nothing |
| Fix 2 (every browser) | Removing the WebRTC interfaces from the thing's page: no packet left, including through a blank inner frame |
| A thing that burns the processor for 3 s | The frame page stalled 17 ms: sandboxed things run in their own process |
| Serving things from another site | No difference for isolation or for the stall |
| A thing injected by the frame page itself (`srcdoc`) | Does not start: it inherits the frame page's strict policy. Things must be served as their own documents |
| The built-in browser of the Claude desktop app | Refuses to load sandboxed frames, so it cannot be used to test the canvas |
| The benchmark | Runs end to end against a stand-in for the API; the things it saved started in the sandbox. Not run against the real API: the key is in the VM |

The same summary is in "Phase 7a results" in [PLAN.md](../../docs/PLAN.md).

### In the VM

To be filled in after the run.

| Question | Result |
|---|---|
| Frame rate, frame page alone | |
| Frame rate, 5 / 10 / 20 things (1 animated) | |
| Frame rate, 20 things, 5 animated | |
| Things served from another site: any difference? | |
| Isolation, in the kiosk | |
| Kit part: seconds and cost per model | |
| Small thing: seconds and cost per model | |
| Complex thing: seconds and cost per model | |
| Made things that started cleanly | |
| How the made things looked | |
