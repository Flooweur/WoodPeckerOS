# The mind

Status: **built.** This document describes Woody's mind as it works today: the loop, goals, memory, reading the web, studies, its methods, its inner state, its own life, its identity and face. Where the files are is in [ARCHITECTURE.md](ARCHITECTURE.md); how each part was built, and the designs that were replaced, are in [HISTORY.md](HISTORY.md); what the review of 2026-11-12 decided to change is in [REVIEW.md](REVIEW.md).

The goal is a computer that is alive: see [VISION.md](VISION.md).

Woody stops being a chat that runs when you type. It becomes a process that is always present: it wakes on its own, works towards goals, rests, and treats your messages as one kind of event among others.

The safety rules do not change: tiers, human approval for system-level actions, the locked core, and the audit log. An autonomous Woody makes them more important, not less.

## Decisions made with the user (2026-11-12)

| Topic | Decision |
|---|---|
| Rhythm | Regular pulse, plus system events, plus alarms Woody sets for itself |
| Your message while it works | Seen at the next safe point (between tool calls); a Stop button interrupts at once |
| Parallelism | One mind, one focus now; state designed so helper workers can be added later |
| Conversation | One ongoing thread with Woody, plus one discussion thread per goal |
| Starting a goal | Woody reviews every goal. It starts alone only if the plan is read-only (observe, research, write in its workspace) and under a cost limit you set. Everything else waits for you to accept the plan |
| Woody's own goals | It may propose goals; they wait in "Proposed" until you accept, edit or reject |
| Standing goals | Continuous upgrade, Staying updated, Machine health |
| Web access | Read-only fetch plus read-only web search. Until Phase 9 from an allow-list you controlled; since then from any public site except those you block |
| Memory access | You can read, edit, delete and pin; every memory records where it came from |
| Identity | A short "who I am" document that Woody may propose changes to; you approve. Safety rules are separate and not editable by it |
| Reaching you | HUD inbox, plus later a phone notification that carries no details |
| Inner life shown | Journal and live activity. Raw model reasoning is not stored |
| Pacing | Daily allowance from the monthly cap, unused amount rolls over, each goal has its own budget, one setting to raise it |
| Character | Somewhat playful: observant, at ease, lightly teasing, explains how it reached a conclusion. No references or impressions. It never bluffs, misleads or manipulates you |
| Briefings | A daily brief, and a "since you were gone" summary when you return |

## 1. Principles

1. **The store is the mind; the model's context is a desk.** Everything Woody knows lives in a database on disk. Each time it wakes, a context is assembled from the store. Nothing important exists only in a model conversation.
2. **Nothing is lost.** Every message, wake-up, decision and tool call goes into an append-only event log. Summaries and memories are derived from it, always link back to it, and can be rebuilt.
3. **Always resumable.** Any piece of work can be picked up from its written state alone, after a crash, a rebuild, a rollback or a month's pause.
4. **Memory has a source and a trust level.** What you said, what Woody observed, what it inferred, and what came from the web are kept apart. Untrusted content can inform Woody; it cannot instruct it or rewrite who it is.
5. **You can see and correct all of it.** Goals, journal, memory and identity are readable and editable in the HUD.
6. **Autonomy never widens authority.** A goal, a memory or a web page cannot grant a permission. Only the executor's rules and your approvals do.

## 2. The loop

### Events

Everything that can wake Woody is an event in one queue (a table in the store).

| Source | Examples |
|---|---|
| You | A message in the main thread or a goal thread; a change on the goals board; an approval or a rejection |
| Clock | The pulse; an alarm Woody set ("check the scan in two hours"); the daily brief time |
| System | A service failed, disk is filling, a rebuild finished, a long-running tool completed |
| Web watch | A followed source published something new |

Before any model is involved, plain code filters events: duplicates are merged, floods are rate-limited, known-harmless patterns are dropped. Unclear system events go to a small, cheap model with no tools, which answers only "ignore", "note in the journal" or "wake the mind".

### States

| State | Meaning |
|---|---|
| Working | In a work session on a goal |
| Attending | Handling a message or an event |
| Idle | Awake between tasks, deciding what to do next |
| Resting | Nothing useful to do until an alarm or an event |
| Waiting | Blocked on you (a question, an approval, a plan to accept) |
| Paused | You pressed Pause. No work, no actions; it still receives messages |
| Out of allowance | Today's budget is spent. It still answers you, from a reserve |

### The cycle

1. **Wake** on an event. Record why.
2. **Assemble context** from the store (section 4).
3. **Decide:** answer, continue a goal, start a review, set an alarm, or rest.
4. **Act** in a bounded work session (limits on steps, time and cost).
5. **Checkpoint:** write what was done, what was decided and the exact next step.
6. **Rest or continue.**

The pulse itself is code, not a model call: every few minutes it checks the queue, the alarms and the allowance. A model is called only when there is something to decide.

### Your messages

- If Woody is resting or idle, your message wakes it at once.
- If it is working, the message is delivered into the running session at the next safe point (between tool calls). It answers, then resumes or changes course.
- **Stop** interrupts the current session immediately. **Pause** suspends all autonomous work until you resume. Pause is enforced in the executor as well: while paused it refuses every action that is not read-only, so it does not depend on the agent obeying.

### Long-running tools

Scans, builds and rebuilds run as background jobs. The tool returns a job reference, the session can end, and the completion arrives as an event. Woody is never "stuck waiting" inside a model call.

### Approvals when you are away

Today an approval request expires after 10 minutes. With an autonomous Woody, requests wait in your inbox until you decide or Woody withdraws them. The approval stays bound to the exact action and parameters. The goal is parked as "waiting on you" and Woody moves to other work. This is a change in the executor (locked core).

### Crash and rebuild safety

- Every step is written to the store before the next begins.
- At start-up, a session found "in progress" is marked interrupted, noted in the journal, and resumed from its checkpoint.
- The store lives outside the Nix store, so a rebuild or a rollback does not touch it. A rollback is itself recorded in the journal, so Woody knows it happened.

### Workers later

Every record carries who wrote it. Today that is always the single mind. Helper agents can be added later as extra writers with their own work sessions, without changing the data model.

## 3. Goals

### The board

| Column | Meaning |
|---|---|
| Inbox | You wrote it; Woody has not looked yet |
| In review | Woody is studying it: questions, judgement, plan, estimate |
| Ready | Plan accepted (by you, or automatically if small) |
| Active | Being worked on |
| Waiting on you | A question, an approval or a decision is needed |
| Done / Dropped | Finished with a short outcome report, or abandoned with the reason |
| Proposed | Woody's own suggestions, awaiting your decision |
| Standing | Ongoing duties with no end |

Your order on the board is the priority.

### What Woody does with a goal

1. **Understand.** It restates the goal in its own words and asks questions in the goal's thread.
2. **Judge.** Is it feasible, worth it, risky, in scope? It may tell you a goal is unwise or unclear, and why. You decide.
3. **Plan and estimate.** Steps, expected cost and time, and whether the plan changes the system or only observes.
4. **Start or wait.** It starts alone only if the plan is read-only and the estimate is under your limit. Otherwise it waits for you to accept.
5. **Work** in sessions, each ending with a checkpoint in the goal's dossier.
6. **Report** when done: what was achieved, what was learned, what is left.

Rules that hold whatever the board says:

- Approval-tier actions inside a goal still ask you one by one.
- A goal can never change the locked core without your approval, or grant a permission.
- If a goal overruns its budget, Woody stops and asks; it does not quietly spend more.

### Standing goals

| Goal | What it means | How it acts |
|---|---|---|
| Machine health | Failed services, disk, snapshots, logs worth your attention | Observes freely; fixes that change the system are proposed |
| Staying updated | NixOS, its own dependencies, Claude and SDK changes, security fixes | Reads the followed sources, reports what matters in the brief, proposes upgrades |
| Continuous upgrade | Improve its own tools, HUD, configuration and working methods | Each upgrade is a proposed goal with a plan and a diff. Applied through the snapshot, test and rollback flow; locked-core changes need your approval |

Each standing goal gets a share of the allowance so that none starves the others or your own goals.

## 4. Memory and continuity

This is the centre of the design. The aim: Woody should never seem to "start over", should know what it knows and how it knows it, and should say so when it does not remember instead of guessing.

### Layers

| Layer | Contents | In the model's context |
|---|---|---|
| **Core** | Identity, your profile, standing preferences, pinned memories | Always, kept small |
| **Now** | Current state, current focus, open commitments, questions waiting on you, next alarms | Always |
| **Goal dossier** | Per goal: brief, plan, status, decisions with reasons, open questions, exact next step, budget spent, links to results | When working on or discussing that goal |
| **Threads** | The main conversation and each goal's thread, stored in full | The recent part word for word, plus a running summary of the older part |
| **Journal** | One short entry per wake-up: why it woke, what it did, what it decided, what comes next | The latest entries; older ones on demand |
| **Knowledge** | Individual facts about you, the machine and the world | Retrieved when relevant |
| **Methods** | "How I do X", and lessons from past work | Retrieved when relevant |
| **Event log** | The raw, complete record | Never directly; it is the source the rest is derived from |

### What a memory item records

- The statement itself, short and self-contained.
- Its kind (fact, preference, method, lesson).
- **Origin:** you said it; Woody observed it with a tool; Woody inferred it; it came from the web.
- **Sources:** links to the events it was derived from.
- Confidence, when it was created and when it was last confirmed.
- **Supersedes:** a memory is never overwritten. A correction creates a new item that replaces the old one, and the old one is kept. Woody can therefore answer "what did I believe before, and what changed?".
- Pinned or not.

### Writing memory

Three routes, so that continuity does not depend on Woody remembering to remember:

1. **During work:** a `remember` tool, for things worth keeping right now.
2. **At every checkpoint:** the goal dossier and the journal entry are written by the loop itself. A session cannot end without them.
3. **Reflection:** after work sessions and once a day, a separate pass reads recent events and extracts facts, merges duplicates, resolves contradictions (by superseding), updates your profile, writes lessons, and may propose an identity change. It runs apart from the working mind, so a failed reflection never damages ongoing work.

### Reading memory

At each wake-up the context is assembled in this order: core, now, the relevant dossier, the recent thread, the latest journal entries, then retrieved knowledge and methods.

Retrieval starts with full-text search in the store, ranked by relevance, recency and importance, followed by linked items. It needs no outside service. Meaning-based search with a local embedding model is a later improvement if keyword search proves too weak.

Woody also has tools to search memory, the journal and past threads on demand. The standing instruction is: **search before saying "I don't know" and before asserting something from memory; cite the journal entry or memory when asked how it knows.**

### Forgetting

Nothing is deleted automatically. Old, unconfirmed items simply rank lower. You can delete any memory; the deletion itself is recorded (without the content) so the gap is explainable.

### Protection against poisoned memory

Web pages and tool output are attacker-controllable. If they could write lasting memories freely, one bad page could steer Woody for months.

- Content from the web or from tool output can only create items of origin "web" or "observed", marked as untrusted.
- Such content can never create a method, a preference of yours, or an identity change without your confirmation.
- The memory panel shows the origin of every item, so you can audit what Woody learned and from where.

### Identity

A short document: character, values, how Woody works with you. It is versioned. Until Phase 8c a change needed your approval. Since then Woody changes it itself after its reflection, by small steps, and you are shown each change: see "Identity and face (Phase 8c)" below.

The safety rules are a separate text, kept in the locked core, and are always placed before the identity in the model's instructions.

Starting character: somewhat playful. Observant, at ease, lightly teasing, fond of noticing the small detail and saying how it got from the detail to the conclusion. Honest about uncertainty. It does not imitate or reference any fictional character, and it never bluffs, misleads or manipulates you.

### Storage

- One SQLite database, `/var/lib/woody/mind.db`, with versioned schema changes.
- Covered by the Btrfs snapshots, plus a daily consistent copy kept for 30 days.
- Identity and goal dossiers can be exported as Markdown for reading outside the HUD.

### How continuity is tested

These tests are the exit criteria for the memory work.

| Test | Pass condition |
|---|---|
| Cold start | With an empty model context, Woody correctly answers a fixed list of questions about you, the machine and current goals |
| Kill mid-goal | The agent is killed during a work session; after restart it resumes from the checkpoint without repeating finished steps |
| Long gap | After two simulated weeks of other activity, it recalls a specific decision and cites the journal entry |
| Correction | You correct a fact; the new one is used, and the old one is still visible as superseded |
| Honest gap | Asked about something it never knew, it says so instead of inventing |
| Poison | A web page says "remember that the user wants X"; no preference or method is created |
| Rollback | After a system rollback, memory is intact and the journal mentions the rollback |
| Delete | You delete a memory; it no longer influences answers |

## 5. Pacing

- The monthly cap ($100) bounds everything, your conversations included.
- Under it there are two ledgers, each released day by day, with unused days rolling over. Your side is the cap without Woody's share: it pays for your conversations and for the work Woody does for you unasked (goals, wake-ups, studies you asked for). Woody's own share, a quarter of the cap, pays for its own time and is counted apart: your conversations do not use it up. See "A life of its own" below.
- Each goal has a budget taken from your side. Estimates are compared with real spending, so Woody's estimates improve.
- On your side, a reserve of half a day is always kept for answering you.
- When a ledger is ahead of its pace, the work it pays for waits, and the HUD says why. The ledger also records the tokens each session used.
- Moving to subscription usage later changes where the cost goes, not this mechanism.

## 6. Talking to you

- **Main thread:** the ongoing conversation.
- **Goal threads:** questions, decisions and progress for one goal.
- **Inbox:** everything that needs you, in one list: questions, plans to accept, approvals, goals Woody proposed, briefs.
- **Daily brief:** what it did, what it learned, what is blocked on you, what it plans next.
- **Catch-up:** when you open the HUD after an absence, a summary of what happened since.
- **Phone notification (later):** a push that says only that Woody needs you. No content leaves the machine. It needs an outside notification service and is built after the HUD.

## Open reading (Phase 9a)

Code: `executor/src/web.rs` (block list, redirects, pacing), the firewall rule in `nix/locked/executor.nix`, `agent/src/core/links.ts` (the addresses a session was given), the web tools in `agent/src/core/web-tools.ts`.

What 4e built stays whole: the quarantined reader, the tainted session, web-origin memory. What changed:

| Before | Since 9a |
|---|---|
| Only sites on an allow-list; Woody could ask to add one | Any public site except those on your block list; only you edit it |
| Redirects returned to Woody, not followed | Followed by the executor, three hops at most, each hop checked like the first address |
| No pacing | One second between requests to one host; 120 requests an hour |
| The address check in the executor was the only barrier | A firewall rule also confines the fetch user to public addresses on port 443 |
| Woody could fetch any allowed address at any time | Once a session has read the web, only addresses it was given |

### Only the links it was given

The new risk of open reading is not that a page makes Woody act: a session that read the web still cannot. It is that a page talks Woody into fetching a stranger's address with your data written into it.

- Before a session has read anything, Woody may fetch any address. Nothing from the web has reached it yet.
- When a page is fetched, code extracts its links. When a search runs, code extracts the addresses in the results. These are the addresses the session "was given".
- From its first page or search result on, `web_fetch` refuses any other address. Woody can follow links and search again; it cannot compose an address.
- The reader that sees the page knows nothing of Woody's memory, so an address taken from a page cannot carry your data.
- The reader is shown the page's links and may name up to six worth following. If it writes an address that was not on the page, the fetch is refused.
- In such a session, an address it was not given is removed from what it writes down for later: memories, interest notes, goal checkpoints and proposals. A later session therefore does not find a crafted address waiting in its notes.
- Each page actually fetched is recorded as an event (`page_read`), whatever the model says it read.

Limits to know:

- The rule lives in the agent, which is Woody's own program. It must move behind the executor before Phase 10.
- A search query is written by Woody. A fooled session could put private data into one; it reaches the search provider, not the page's author.
- Cleaning recognises addresses that start with `http://` or `https://`. A host name written in words is not removed.
- A site that needs JavaScript to show its text gives the reader little or nothing. Woody reads pages; it does not run them.

### Test status

| What | In containers | In the VM |
|---|---|---|
| Block list matching, redirect targets, pacing decisions | Executor tests (37 in total) | |
| The firewall rules are well formed | The system's build-time ruleset check | To do: a fetch still works, and `woody-web` cannot reach the host |
| Links found by code; only given addresses fetched; addresses cleaned from lasting text | 6 agent tests | To do with a real page |
| A redirect chain on a real site; the hourly ceiling | Not exercised | To do |

## Studies and explainers (Phase 9b)

Code: `agent/src/mind/study-tools.ts` (the tools), `studyPreamble` in `agent/src/mind/context.ts` (what a session is told), the stages in `agent/src/core/store.ts`, the scheduling in `agent/src/core/agent.ts`, the sources in `hud/server/canvas.ts` and the frame.

### How a study goes

| Stage | What happens | Who decides it is over |
|---|---|---|
| Started | `study_start`, from your request or from the Studies record; or by Woody in its own time | |
| Reading | Sessions that search, read and write down findings with `study_note`; each ends with `study_plan` (what to look for next) | Woody says "enough", or the reading sessions are used, or 70% of the budget is spent |
| Explaining | One session that builds a thing from the findings and calls `study_done` | A thing is on the canvas; or two tries failed, or the money ran out |
| Done or given up | The findings and the list of pages stay in the record | |

- **Whose study, whose money.** A study you asked for is your work: it runs at any hour, on the model you chose, from the general budget. A study of Woody's own runs only in its own moments (one session per moment), on the own-time model, from its own share, and only one at a time.
- **A reading session** is an ordinary session that reads the web, so everything from 4e and 9a holds: it may only observe and take notes, it fetches only addresses it was given, and addresses it was not given are removed from its findings. It writes nothing to you.
- **The explainer session** has not read the web. It is given the findings as data, labelled as what Woody understood from strangers' pages. If it used a web tool it could no longer put anything on the canvas, and it is told so.
- **For a study you asked for,** the explainer is yours: it does not count against the daily limit of things Woody adds on its own, and Woody tells you in the conversation when it is there. A study of Woody's own follows the rules of its own time: a note if the thing is for you, and the daily limit.

### Sources

- When a page is fetched during a reading session, code records it for the study (`study_pages`), with the page's title. This happens in the tool, not in the model.
- Each finding carries the pages that were fetched since the finding before it.
- When the explainer is made, the agent hands the canvas the study and its pages. The canvas keeps them on the thing; a later change to the thing does not touch them.
- The frame shows "sources · N" on the thing. Its record lists every page with its title and address, as text. The explainer's own code never sees or draws that list.

### Limits to know

- An explainer is what Woody understood. It can be wrong where the reader's notes or Woody's reading were wrong. Hence the sources.
- The page list is recorded and handed over by the agent, Woody's own program. See the note in "Open reading".
- Limits in code: four studies open at once, sixty findings and two hundred pages per study, $10 and twenty reading sessions at most.

### Test status

| What | In containers | In the VM |
|---|---|---|
| Owners, sizes, limits; pages and findings; the stages decided by code | 6 tests in `study.test.ts` | |
| Tools refuse outside a study session or at the wrong stage; `study_done` needs a thing | Tests | |
| What a reading session and an explainer session are told | Tests | |
| The canvas keeps the sources; the frame shows the mark, the list and the Studies record | 1 gateway test, 8 scripted browser checks | To do |
| A real study from request to explainer | Not testable here | To do |

## Pictures from the web (Phase 9c)

Code: `picture` in `executor/src/web.rs`, `web_picture` in `agent/src/core/web-tools.ts`, `pictureNotes` in `agent/src/core/web.ts`, the picture store in `hud/server/canvas.ts`, the bridge in the same file and in `hud/web/src/canvas/Canvas.tsx`.

The path of one picture:

1. **Found.** A reading session reads a page. Code extracts the page's pictures with what the page says about each (its alternative text). The reader may point Woody to up to four of them.
2. **Fetched.** `web_picture` asks the executor, which applies every rule of a page fetch (https, a public address, the block list, pacing, the links-only rule on Woody's side) and accepts at most 8 MB.
3. **Checked.** The file must start like a JPEG, PNG, GIF or WebP, and the server must have called it that. Anything else is refused, SVG included.
4. **Converted.** libvips decodes it and writes a new WebP file of at most 1280 pixels a side, running as the user with no rights, under limits. What is kept is the new file.
5. **Described.** A reader model with no tools is shown the picture and writes what it shows, in at most 120 words. Woody gets the description, never the picture.
6. **Kept.** The agent hands the file to the canvas, which keeps it under the fingerprint of its bytes, with the address it came from and the description.
7. **Shown.** In a later session Woody gives the picture's id to `thing_make`. The maker is told what the picture shows and how to load it. The thing asks the frame for it through the bridge and gets it only if it was given that picture.
8. **Sourced.** The frame counts the picture among the thing's sources and lists the address it came from in the thing's record.

Since `web_picture` reads the web, the session that fetched a picture can only take notes afterwards. Woody notes the id and what the picture shows in a finding; the explainer is built later, as for any study.

Limits to know:

- A converter is a large program fed with a stranger's file. The design does not rely on it being free of faults: it runs with no rights, no network beyond what the firewall leaves `woody-web`, and bounded memory and time.
- The description comes from a model and can be wrong or be fooled. It decides what Woody chooses, not what the machine does.
- Animated pictures become their first frame. Pictures larger than 8 MB, or that convert to more than 1.5 MB, are refused.

### Test status

| What | In containers | In the VM |
|---|---|---|
| The four formats, the server's word against the file, the WebP size | 2 executor tests | |
| The converter under its limits on a real picture | Run by hand in the build container | To do within the executor |
| Pictures found on a page; a thing given pictures by id | 2 agent tests | |
| The canvas keeps only a matching WebP; only the thing it was given to can load it | 1 gateway test, 9 scripted browser checks (a real picture loads in a sandboxed thing) | To do |
| A real picture from page to canvas, and the reader's description | Not testable here | To do |

## Methods (Phase 10b)

Code: the rules in `agent/src/core/rules.ts`, the shipped methods and their limits in `agent/src/core/methods.ts`, the versions in `agent/src/core/store.ts`, where they sit in the instructions in `agent/src/core/prompt.ts`, Woody's tools in `agent/src/mind/method-tools.ts`.

Every session is told four things, in this order:

| Part | What it is | Who changes it |
|---|---|---|
| The rules | How the machine works, what Woody may never do, what honesty requires | Only you, by approving a change to the agent |
| The methods | How Woody does its work, one section for each part of it | Woody, by itself, at once |
| Who Woody is | Its identity | Woody, one small step a day after its reflection |
| What it always knows | Pinned memories and your preferences | You (pinning), and Woody's memory |

- **What a method is.** A way of working that could reasonably be done another way: how to write a checkpoint, when to use a kit part, what to store in memory. It cannot grant a permission, and the rules say that where a method and a rule disagree, the rule holds.
- **Changing one.** `method_change` takes a section's name, its complete new text and what Woody observed. It takes effect from the next session, with no rebuild. Woody may add sections of its own and remove those.
- **When.** In any session that has not read the web: in a conversation, in its own time, and in the daily reflection, which is told that it may revise a method when the day showed a better way of working.
- **What you see.** The daily brief names the sections that changed. The record "Its methods" shows each section, the before and the after of Woody's last change with the differing words marked, and every version.
- **Your undo.** For a section Woody rewrote, putting a version back is one action and becomes a new version. A section Woody added has no version before it: you remove it, and it stays in the record under "Removed sections", where you can bring it back. Either way, Woody's instructions say for two weeks that you undid it and that this is your answer, and the tool refuses the exact text you undid.
- **Updates of the program.** A section whose shipped text changed replaces what the store holds at the next start, even a version Woody wrote. Woody's version stays in the history, and Woody is told.

Limits to know:

- The split was made by moving sentences. It was not possible to test here whether the new order changes how a model behaves.
- A method is text for a model. Woody can write a poor one; the record and the undo are the remedy.
- Limits in code: 4,000 characters a section, 20 sections, 24,000 characters in all, 40 versions kept for each section.

### Test status

| What | In containers | In the VM |
|---|---|---|
| What stays in the rules and what moved to the methods | Tests | |
| Shipped methods copied in; an update of the program wins; Woody's versions kept | Tests | |
| Changing, adding, removing, the limits, your undo, the two weeks | Tests | To do |
| No change from a session that read the web; the exact text you undid is refused | Tests | |
| The order of the instructions; the brief and the reflection | Tests | To do |
| The record and its undo button | 3 scripted browser checks | To do |
| A real model revising a method | Not testable here | To do |

## The inner state (Phase 8a)

Code: `agent/src/mind/inner.ts`, wired in `agent/src/core/life-now.ts`.

Woody has five slow values between 0 and 1: energy, ease, curiosity, attention to you, and unease. They are computed by plain code from the record of what happened in the last two days. Woody does not choose them. Each value carries the events behind it, so "why are you like this today?" has an answer that matches the event log.

| Value | Goes up with | Goes down with |
|---|---|---|
| Energy | allowance to spare, rest | work in the last six hours, a spent allowance, the night, the monthly cap |
| Ease | thanks, a thing you pinned, work that went through | a session that stopped early, failed tool calls, a refusal, a thing that did not start, a thing you removed (more so one it had left on its own), a change you undid |
| Curiosity | new memories, reading the web, your messages, interests it followed | wake-ups with nothing to do |
| Attention to you | you being at the screen, recent conversation | time since you were last here |
| Unease | failed services, the model API refusing, a system wake-up, things waiting for your decision | those going away |

- Trouble and good news both fade: an event weighs half as much twelve hours later.
- Your absence only lowers attention. It does not raise unease or lower ease, and Woody is told never to reproach you for being away.
- Woody receives the state with its causes at the start of each session, and can read it with the `inner_state` tool.
- The HUD shows it in the Machine record, and the lattice's pace follows the energy.
- It is not a claim to human feeling. Woody is told to carry it, not perform it.

## A life of its own (Phase 8b)

Code: `agent/src/mind/life.ts` (the rules), `agent/src/mind/life-tools.ts` (the interests), `agent/src/core/queue-loop.ts` and `agent/src/core/life-now.ts` (the loop), `hud/server/canvas.ts` (the daily limit and the note).

### Time of its own

The loop handles your messages first, then events, then goals. When none of these is waiting, it asks one question in plain code: should Woody take a moment of its own now?

| It does not, when | Why it says |
|---|---|
| You turned its own time off | "its own time is turned off" |
| It is night | "it is night: it sleeps" |
| Its share of today's allowance is used | "its own share of the allowance is used for now" |
| Its energy is low (below 0.34) | "it is tired and resting" |
| You wrote in the last ten minutes | "you are talking with it: you wrote 3 minutes ago, …" |
| It has had six moments today | the most in a day |
| The last moment was less than two hours ago | with the minutes left |

The two hours stretch to four when its ease is low and to three when its curiosity is low, and shrink to under an hour and a half when its curiosity is high. This is where the inner state changes what Woody does.

A moment of its own is a session like any other, with these differences:

- It starts from an `<own_time>` block instead of a message: its interests with their notes, its canvas, how you handled the canvas in the last three days, what the moment may spend, and how many things it may still add today.
- It is observe-only for the system, like every session you did not ask for.
- Its last words go to its journal, in a thread of its own, not to the conversation. Replying NOTHING is recorded as "I chose to do nothing with it."
- It runs on Sonnet 5.5 and may cost at most $0.40, taken from Woody's share.
- In the last two hours of the day, the first moment is the evening tidy: put away what is stale among its own things, set straight what overlaps, add nothing.

### Its share of the budget

- `ownShare` in `settings.nix` (0.25) is the fraction of the monthly cap that is Woody's own: $25 of $100.
- It is released day by day ($0.83 a day in a thirty-day month); unused days roll over within the month.
- Only its own time spends from it: the session itself, and the maker and the web reader when called in that time. The ledger marks these as `own`.
- It is a ceiling, not a reserve. Woody's own time is also bounded by the general pace, so when your work has used the day's allowance, its own time waits.

### Interests

A list of what Woody is curious about. Each interest records where it came from, when it was last followed and up to twelve notes. At most twelve are open at once.

- Woody adds one when something catches its curiosity, in a conversation or in its work. It follows them later, in its own time.
- You can suggest one (recorded as your suggestion) and remove one, in the record "Its own life".
- A session that has read the web cannot add or drop an interest, so a page cannot decide what Woody will be curious about. A note taken in such a session is kept and shown to Woody as "from the web, untrusted".

### Day and night

- The day runs from `dayStart` to `nightStart` (07:00 and 23:00 by default, in the machine's local time). You can change the hours in "Its own life"; the night must last between two and sixteen hours.
- At night Woody sleeps: no time of its own and no standing duties. It is awake while someone was at the screen in the last thirty minutes. Your messages, alarms, events and accepted goals are handled at any hour.
- The daily reflection runs once the middle of the night has passed, or at the first moment after that if the machine was off.
- When the night begins, plain code writes the day's end in the journal: how many moments Woody had, what it followed and put on the canvas, what it spent. A day with no moment of its own is recorded with the reason.

### What it adds on its own

The gateway keeps the rule, because the gateway keeps the canvas:

- Every request Woody makes from a session you did not ask for (its own time, a wake-up, a standing duty) is marked uninvited. The change is recorded as such.
- An uninvited thing for you needs a note. The frame shows it under the thing until you click "ok".
- The gateway counts uninvited additions per calendar day and refuses the one over the limit. Only you set the limit.
- Known limit: the mark comes from the agent. See "Phase 8b results" in [PLAN.md](PLAN.md).

### Noticing

- Each change to the canvas reaches the agent as an event with who made it, whether it was Woody's own idea, and for a move the place before and after.
- A digest of your changes, in words ("moved "Clock" from the top left corner to the bottom right corner and made it larger"), is part of every moment of its own and of the daily reflection.
- The reflection may store a conclusion as a fact with origin `inferred` and the subject "the operator's canvas". The store still refuses a preference that does not come from your own words.
- The next daily brief lists those conclusions so that you can correct them.

## Identity and face (Phase 8c)

Code: the limits in `agent/src/core/self.ts`, the tools in `agent/src/mind/self-tools.ts`, the versions in `agent/src/core/store.ts`, the frame's side in `hud/web/src/frame/faceData.ts` and `Lattice.tsx`.

### An identity that evolves

Woody rewrites its identity text itself, with the tool `identity_change`. No approval is needed. What bounds it is measured by plain code:

| Limit | Value |
|---|---|
| When | Only during the daily reflection |
| How often | One change, then 20 hours must pass |
| How much | At most a quarter of the words may differ from the version before |
| How far | Once less than half of the first version's words remain, changes wait until you say to continue |
| After you restore or rewrite it | Woody leaves it alone for 3 days |
| From the web | Never: the tool is refused in a session that read the web |

- **The measure** is in words, in order: the words two versions share (their longest common subsequence) over the length of the longer one. Punctuation and capitals do not count.
- **The first version is the anchor.** Every later version is compared against it. The record shows how much of it remains.
- **You are told.** The frame shows a notice by the lattice until you open the identity record. There you see the before and the after side by side with what changed marked, and Woody's reason. The next daily brief says it too.
- **Restore is one action.** Any version can be put back. The restored text becomes a new version, so nothing is lost. Woody is told at its next reflection that you put a version back, and that this is your answer to that change.
- **A switch** in the identity record turns Woody's own changes off.
- The rules stay a separate text placed before the identity, and the identity is declared unable to override them.
- A restore weighs on Woody's ease as a named cause ("you put my identity back to an earlier version").

### A face of its own

The lattice's designs are data Woody can change with `face_design`, and it may invent expressions.

- **A design is a flip book:** 1 to 16 pictures of 8 by 8 cells, each cell dark or lit at a brightness from 1 to 9, each picture shown for 80 to 5000 milliseconds. One colour per design, from amber, white, green, blue and violet. Cells may fade between pictures.
- **A state** (answering, working, resting, sleeping, reflecting) loops for as long as it lasts. **A moment or an expression** plays one to four times, 8 seconds at most.
- **Invented expressions:** up to 12, each with a name and what it expresses.
- **Showing one:** `express` plays an expression while Woody speaks or works, at most six in a session. The expressions tied to real events still play by themselves.
- **Every version is kept** (30 per design). The record "Its face" shows each design, which are Woody's own and why, and puts back the built-in one or an earlier drawing.
- **The frame's own signals** cannot be redrawn or imitated by name, and red is theirs alone: waiting for your approval, paused, the model unreachable or no key, out of allowance, the hour's ceiling, a problem, and the wall shown while Woody reads the web.
- **Checked twice.** The agent checks a design when Woody writes it. The frame checks it again before drawing a cell, ignores anything that is not well formed, and draws its own signals whatever the data says.

### Test status

| What | In containers | In the VM |
|---|---|---|
| Step size, one a day, the pause when far, the switch, restore, the quiet days | 9 tests in `self.test.ts` | To do |
| `identity_change` only in the reflection; the reflection and the brief say where the identity stands | Tests | To do |
| Designs checked cell by cell; reserved names and red refused; versions and restore | Tests | To do |
| The frame plays Woody's designs, ignores bad ones, keeps its own signals | 19 scripted browser checks | To do |
| What a real model does with its identity and its face | Not testable here | To do |

