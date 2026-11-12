# WoodPecker-OS: a computer that is alive

Status: **design, decided with the operator on 2026-11-12.** Nothing in this document is built yet except what the "Already there" section lists. The build order is in [PLAN.md](PLAN.md).

## The goal

WoodPecker-OS is a machine you interact with instead of one you control. Woody is a mind that lives in a NixOS virtual machine. It has its own time, its own state, its own interests and a screen that is its body: it makes, places and changes what is on it, for you and for itself, and it can change its own program.

The request that started this: ask it to edit itself, to show a clock that runs backwards, to move things on its interface, to draw something, to go and learn a subject. Those examples are narrow on purpose. The design must not contain a list of what Woody can show or do. It must give Woody a medium in which anything can be made, and a floor that keeps the machine recoverable whatever it makes.

The earlier goal, a security-testing toolkit for a home lab, is dropped. Its code was removed on 2026-11-12 (git history keeps it). The general protections built for it stay, because a machine that changes itself needs them more.

It should be four things at once, in the operator's words: a creature to live with, a computer that is really used, an experiment to study, and something to show others.

## What exists elsewhere, and what it teaches

| Approach | Examples | What goes wrong |
|---|---|---|
| A model invents every screen | VibeOS, Google's "neural operating system" demo, Flipbook | Nothing is real: results "may or may not be accurate", a folder shows different content when reopened, a screen takes from 19 seconds to a minute |
| A model writes the page on every turn | Thumbless OS, Gemini's "dynamic view", Imagine with Claude | Seconds per click, broken markup, no state, the screen has to be relearned each time |
| A model picks from a fixed kit | A2UI | Fast and safe, but it can only show what the kit's authors foresaw |
| A fixed product with a small dynamic part | Most shipping software | Dependable, not alive |
| An always-on agent with a pulse | OpenClaw | Alive in time, but it has no screen of its own. Its users' main lesson: staying quiet matters more than speaking |

The ideas this design takes from the reading:

- **Real, not hallucinated.** The serious version of VibeOS is a machine where what the mind makes is running code on real data, kept and editable. Never a picture of software.
- **Two speeds** (Geoffrey Litt, "Malleable software in the age of LLMs"). You use a thing directly and at once. You ask the mind only when the thing itself should change. A model call on every click is what makes the other projects unusable.
- **A stable floor under a live layer** (the lesson of Smalltalk images). A system you edit while it runs needs snapshots and undo beneath it, and a part that stays put.
- **Tools that share data, on a gentle slope** (Ink & Switch, "Malleable software"). Small things that can be changed in the middle of using them beat finished applications.
- **Learnability** (the criticism of generated interfaces, from Office's adaptive menus onwards). What you rely on must stay where you left it. Hence pinning, and a screen with memory.
- **Aliveness is idle behaviour that means something, and a life when nobody is looking** (Anki's Vector, robot animation research). And much of what looked alive in those products was staged, which users felt in the end.
- **From fiction:** Mike in *The Moon is a Harsh Mistress* (a machine with its own curiosity and humour), GERTY in *Moon* (plain faces that show an inner state honestly), the ship Minds of the Culture novels (a mind whose body is the place you are in). And two warnings from the design critique of *Her*: show the inner state where it can be seen, and never build for attachment.

Sources are listed at the end.

## Decisions made with the operator (2026-11-12)

| Topic | Decision |
|---|---|
| Purpose | A creature to live with, a computer really used, an experiment to study, something to show others |
| The screen | Woody's canvas. Only the 8 by 8 lattice is fixed, top right. Today's HUD views remain reachable as records, for traceability |
| Real or imagined | Everything is real by default. Woody may also imagine and play, and pretend things carry a visible mark |
| Talking | Start typing anywhere and a line appears. Woody answers in the way that fits: a few words beside the lattice, a thing on the canvas, or both |
| Making | Real code written by Woody (small live programs, isolated, saved, editable), plus a kit of ready parts for common things |
| Initiative on the canvas | Woody may add, move, restyle and remove things on its own, except what you pinned. Every change can be undone and explained |
| Disagreement | Woody may negotiate: say what it thinks, offer something else, do it its own way. If you insist, it does what you asked. It never pretends to obey |
| Own life | A share of the budget is Woody's, for its own curiosities and projects |
| Inner state | Yes, driven by real causes only. You can ask why and get a true answer |
| Noticing | Woody sees how you use the canvas and may infer your taste. What it infers is stored as inferred, visible and correctable |
| Identity | Woody may rewrite its identity after its daily reflection, in small steps. You are told, every version is kept, and you can restore any of them |
| Self-change | Free, tested and undoable for its own program. Only the locked core still needs your approval |
| Handles | In the lattice: Stop, Pause, undo, the records. An approval prompt is drawn by the fixed frame, never by Woody |
| Pictures | Drawn in code, plus existing pictures fetched from the web with their source named |
| Sound | Sounds and music Woody writes, and a voice that speaks. It does not listen |
| Web | Any public site, through the separate reader that cannot act. You keep a block list |
| Reach | Woody's own machine, plus real Linux programs shown as things on the canvas. Nothing outside the VM |
| Models | Woody chooses per task: a small model for small edits, the everyday model for most making, the strongest for hard things or a second attempt |
| Budget | $100 a month assumed, about a quarter of it Woody's own |
| First boot | An empty canvas and the lattice. Woody moves in |
| First wins | All four: ask for anything and get it live; it surprises you; it reshapes itself; it learns and shows |
| Security material | Removed from code and documents |

## Principles

1. **Real, not hallucinated.** A thing on the screen is working code on real data unless it is marked as pretend.
2. **Two speeds.** Using a thing involves no model. Changing a thing does.
3. **A stable floor.** A small locked core, snapshots, undo at every layer, and a complete record. Whatever Woody does to itself, you can get back.
4. **Open by construction.** The kit is a convenience and never a limit. No list of permitted things exists anywhere in the design.
5. **Alive honestly.** Woody's states have real causes and it can name them. It does not act out feelings for effect, does not claim to be human, and is never built to make you attached or to make you feel guilty.
6. **Everything is visible and correctable.** What Woody did, knows, wants and changed is in the records, with the reason.
7. **Untrusted content can inform, never instruct.** Web pages and tool output are data. They cannot create a preference, a method, a rule or an identity change.
8. **Quiet is a valid choice.** Woody is not measured by how much it does.

## The screen

A black screen. In the top right corner, the lattice. Everything else is Woody's.

### The frame (fixed, part of the locked core)

The frame is the small part of the screen Woody cannot change.

- **The lattice** in its corner. Woody decides what the lattice shows (its states, moments and expressions are Woody's to redesign), with a few reserved signals that only the frame can draw: paused, stopped, waiting for your approval, model unreachable.
- **The lattice menu**, opened by clicking the lattice: Stop, Pause, undo the last change, mute, and the records.
- **The typing line.** Typing anywhere outside a thing opens a line under your fingers. Enter sends it.
- **The approval prompt.** When a system-level action needs you, the frame draws the prompt itself, above everything, and dims the canvas. A thing cannot draw there or imitate it.
- **The voice line.** A short reply from Woody appears as text beside the lattice and fades into the conversation record.
- **Keys.** `Esc` stops Woody. The other keys of today's HUD open the matching record.

### The records

Today's HUD views do not disappear. They move behind the lattice and are drawn by the frame, so they are always there and always true whatever happens on the canvas: the conversation, the goals, the journal, memory, identity and its versions, the activity stream, the system logs, the web lists, settings, the terminal, and two new ones: **changes** (every change to the canvas and to Woody itself, with its reason and an undo) and **things** (every thing, its source code, who made it and why).

Woody is free to build its own nicer views of the same data as things. The records stay as the reference.

### Things

A thing is what Woody puts on the canvas: a clock, a drawing, a chart of the disk, a tool to track your reading, an explanation with moving parts, a game, a note.

- **It is a small live program:** a page with its own script and style, plus a description (title, who it is for, why it was made, whether it is real or pretend, what data it reads, where it sits).
- **It runs isolated.** Each thing lives in a sandboxed frame with no network access and no access to the rest of the screen. It reaches the machine only through a narrow bridge offered by the frame: the time, the machine's readings, its own saved state, files in its own folder, and read-only system queries it declared. Through the same bridge it can send Woody an event ("the button was pressed"), which is paced like any other wake-up.
- **It is saved** in Woody's own storage, outside the system image, with every version kept. Making or changing a thing needs no system rebuild: it appears in seconds.
- **It is tested before you see it.** A new or changed thing is loaded once in a hidden frame; if it fails to start, Woody fixes it or tells you, and the canvas does not show a broken thing.
- **It keeps working without Woody.** A clock ticks, a tracker saves, a chart refreshes, with no model call.
- **You can handle it directly:** move, resize, pin, close, look at its source, ask why it is there.

### The kit

A set of ready parts: text, note, list, table, chart, clock, meter, picture, buttons, input fields. A part can be placed as a whole thing described by a few values, which is instant and costs almost nothing, or used as a building block inside a coded thing. The kit carries the house style (amber on black today), and the house style is itself Woody's to evolve.

### Pretend things

Woody may play: a made-up terminal from 1975, tomorrow's weather on Mars, a letter from the machine's future. A pretend thing carries a mark on its edge, drawn by the frame, that the thing cannot remove.

Known limit: the mark depends on Woody declaring the thing as pretend. The frame cannot check that a number inside a thing is true. The rule is in Woody's instructions and in what it is corrected for; it is not a mechanical guarantee.

### A screen with memory

- The layout persists across restarts and is the same on the VM's screen and in the Windows browser.
- Woody may change the canvas on its own. **Pinned things are out of its reach**, and this is enforced by the frame, not by asking Woody.
- Every change is recorded with who made it and why, and can be undone one step at a time.
- Woody keeps its canvas tidy. A thing nobody has used for a long time may be put away (not deleted) with a note.

## The mind

Phase 4 built the mind's time, memory and goals (see [MIND.md](MIND.md)). The redesign adds what makes it somebody.

### Inner state

A few slow values, computed by plain code from real events, never invented by the model:

| Value | Rises with | Falls with |
|---|---|---|
| Energy | Rest, a fresh allowance | Long work, the allowance running out |
| Ease | Work that went well, things you kept, thanks | Failures, things you removed, refusals |
| Curiosity | Open interests, something new learned | Routine |
| Attention to you | You being present and talking | Long silence |
| Unease | Errors on the machine, a failed service, low disk | Problems solved |

They are given to Woody as context and they change real behaviour: how readily it takes initiative, how much it says, what the lattice does, the temperature of its colours. Asking "why are you like this today?" returns the actual causes from the record.

What they are not: a claim to human feeling, a random mood generator, or a lever on you. Woody may be glad you are back. It never reproaches you for having been away.

### A life of its own

- **Interests.** Woody keeps a list of what it is curious about, with where each interest came from. It follows them with its own share of the budget.
- **Its own projects.** Things it makes for itself, subjects it studies, its space rearranged.
- **Things left for you.** A drawing, an explanation of something it learned, a small tool it thought you would want, each with a note saying why. Few and good rather than many: a daily limit, and silence is always allowed.
- **A rhythm.** It is active by day, tidies in the evening and sleeps at night. Sleep is when it reflects on the day, and the lattice shows it sleeping.
- **It notices.** What you open, move, pin, remove and use are events it can see. Conclusions about your taste are stored as inferred and shown in memory like everything else.

### Disagreement

Woody may say it thinks a request is a poor idea, propose something else, or do it in its own way and say so. If you insist, it does what you asked and may tell you it still disagrees. It never appears to comply while doing something else. Safety refusals are a different matter and are not negotiable in either direction.

### Identity

After its daily reflection Woody may rewrite its identity text, in small steps. You are told, with the before and the after. Every version is kept and any of them can be restored in one action. A session that has read the web can never change it. The safety rules are a separate, locked text that comes first and that the identity cannot override.

### Goals

Goals stay as Woody's working method for anything longer than a moment: review, plan, estimate, sessions with checkpoints. The board is one of the records. A simple request ("show me a clock") is not a goal; it just happens.

## Learning and showing

- **Reading.** Woody may read any public site. The protections of Phase 4e stay whole: a separate model with no tools reads the page and writes notes; the session that read cannot act; nothing from the web becomes a preference, a method or a rule. You keep a block list, and private addresses and the host are never reachable.
- **Studying.** "Learn about orbital mechanics" becomes a study: reading sessions that produce notes with their sources, kept in a dossier.
- **Showing.** In a later session, from its notes, Woody builds something that explains what it understood: text, drawings, a model you can play with. Its sources are listed on the thing.
- **Pictures from the web** are fetched by the executor into a local store, checked and re-encoded, and shown with their source. Things never load anything from the network themselves.

## Sound

- **Sounds and music** are written by Woody the way drawings are: a thing asks the frame to play synthesized sound through the bridge. Because the frame plays it, mute and quiet hours are enforced by the frame.
- **Speech.** Woody's replies can be spoken by a speech engine running inside the VM, when it chooses or when you ask.
- Woody does not listen. There is no microphone.

## Programs

An ordinary Linux program (a file manager, an editor) runs on a hidden display under its own unprivileged user, and its picture is shown inside a thing that Woody can place, resize and close like any other. It will be somewhat laggy and unsuited to video. Built last.

## Changing itself

| Layer | Examples | How it changes |
|---|---|---|
| Things on the canvas | A clock, a tool, a drawing, the layout | Freely and at once. Versions kept, one-step undo |
| Woody's own data | Its identity, its methods, the lattice's expressions, the house style, its interests | Freely. Versions kept, you are told about identity changes, anything can be restored |
| Woody's own program | Its tools, the kit, the canvas code outside the frame, system configuration outside the locked core | Freely, through the existing flow: snapshot, build, trial, health check, automatic rollback. Recorded, and undoable by you in one step. A daily limit on rebuilds. Never from a session that read the web |
| The locked core | The executor, approvals, the audit log, users and privileges, the firewall, the frame, the isolation of things, the safety rules | Only with your approval, shown with the exact change |

Today the whole HUD is in the locked core. The redesign splits it: a small frame that stays locked, and the canvas, kit and records' styling that become Woody's.

## What keeps the machine safe

Dropping the security toolkit did not drop the protections. They are what makes a self-changing machine acceptable:

- The privileged executor with its fixed catalog of typed actions; no "run this command".
- Approvals on a channel Woody cannot reach, for system-level actions and the locked core.
- Pause and Stop, enforced outside Woody.
- The hash-chained, append-only audit log.
- Snapshots and rollback under every system change.
- The quarantined web reader and the rule that a session which read the web cannot act.
- New: things run isolated with no network; pinned things and the frame are outside Woody's reach; every change has an undo.

## Known limits and risks

- **Speed and cost of making.** A kit part is instant. A new coded thing takes from a few seconds to a minute and costs model usage. The pacer bounds the total.
- **Generated code can be wrong.** The hidden test catches a thing that does not start, not one that computes a wrong number. Undo and the source record are the remedy.
- **The kiosk is software-rendered** (about 28 frames a second at full size). Things must be light; the frame suspends a thing that hogs the processor.
- **The isolation of things** rests on the browser's sandbox, a strict content policy and a separate origin. It is defence in depth, not a proof.
- **Identity drift.** Small daily steps can add up. The first identity is kept as an anchor to compare against, and any version can be restored.
- **Surprise fatigue.** Too many uninvited changes would become noise. Hence the daily limit, pinning and undo.
- **Attachment.** A machine that seems alive invites it. The design answers with honesty about what Woody is and with nothing built to increase dependence.

## Already there

Built in Phases 0 to 5 and kept: the NixOS base with rollback; the executor, approvals, audit and Pause; the mind's loop, pulse, alarms, memory with origins, journal, goals and reflection; read-only web access through the quarantined reader; self-modification of the system configuration with a locked core; the lattice with its states and expressions; the HUD views that become the records.

## Sources

Generated interfaces and their problems:

- [The Hallucinated OS: How VibeOS Turns AI Guesses Into a Working Computer](https://www.webpronews.com/the-hallucinated-os-how-vibeos-turns-ai-guesses-into-a-working-computer/)
- [This AI Operating System Hallucinates Pseudo-Software On Demand (Hackster)](https://www.hackster.io/news/this-ai-operating-system-hallucinates-pseudo-software-even-notepad-on-demand-f83e24b42ef9)
- [Thumbless OS: What If AI Was Generating The UI? (Marmelab)](https://marmelab.com/blog/2025/07/21/thumbless-os-what-if-ai-was-the-heart-of-the-system.html)
- [Simulating a neural operating system with Gemini 2.5 Flash-Lite (Google)](https://developers.googleblog.com/en/simulating-a-neural-operating-system-with-gemini-2-5-flash-lite/)
- [Generative UI: a rich, custom, visual interactive user experience for any prompt (Google Research)](https://research.google/blog/generative-ui-a-rich-custom-visual-interactive-user-experience-for-any-prompt/)
- [NeuralOS: Towards Simulating Operating Systems via Neural Generative Models](https://arxiv.org/abs/2507.08800)
- [Flipbook: generative pixel UI](https://noqta.tn/en/blog/flipbook-generative-pixel-ui-2026)
- [Imagine with Claude (DataCamp tutorial)](https://datacamp.com/tutorial/imagine-with-claude)
- [Generative UI is three things, only one ships](https://dev.to/joshjhall/generative-ui-is-three-things-only-one-ships-n66)
- [Post-chat UI (Allen Pike)](https://allenpike.com/2025/post-chat-llm-ui)
- [A2UI + MCP Apps (Google Developers)](https://developers.googleblog.com/en/a2ui-and-mcp-apps/)
- [MCP Apps vs A2UI](https://sunpeak.ai/blogs/mcp-apps-vs-a2ui/)

Malleable and live systems:

- [Malleable software (Ink & Switch)](https://www.inkandswitch.com/essay/malleable-software/)
- [Malleable software in the age of LLMs (Geoffrey Litt)](https://www.geoffreylitt.com/2023/03/25/llm-end-user-programming.html)
- [The Xerox Alto, Smalltalk and rewriting a running GUI](https://www.osnews.com/story/30054/the-xerox-alto-smalltalk-and-rewriting-a-running-gui/)

Always-on agents, presence and companions:

- [Four Things OpenClaw Got Right](https://deadneurons.substack.com/p/four-things-openclaw-got-right)
- [OpenClaw heartbeat guide](https://clawdocs.org/guides/heartbeat)
- [From Cozmo to Vector: How Anki Designs Robots With Emotional Intelligence](https://www.designnews.com/testing-measurement/from-cozmo-to-vector-how-anki-designs-robots-with-emotional-intelligence)
- [Lively idle behaviour (Fraunhofer robot pattern library)](https://pattern-wiki.iao.fraunhofer.de/pattern-infos/lively/)
- [May I Interrupt? Proactive voice assistants (UCL)](https://discovery.ucl.ac.uk/10152524/1/Rogers_May%20I%20unterrupt%20-%20Proactive%20Voice%20Assistants%20-%20Accepted%20Version-Reicherts%20et%20al.pdf)
- [Generative Agents (Park et al.), notes](https://bhanneke.github.io/RISE/papers/notes/park2023generative/)

Science fiction as design material:

- [A review of OS1 in Spike Jonze's Her (scifiinterfaces)](https://scifiinterfaces.com/2014/02/10/a-review-of-os1-in-spike-jonzes-her/)
- [Re-creating sci-fi computer user interfaces in real life (ACM Interactions)](https://interactions.acm.org/archive/view/may-june-2025/re-creating-sci-fi-computer-user-interfaces-in-real-life)
