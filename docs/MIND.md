# The mind (design)

Status: **Phase 4 (4a to 4e) is built** (the store, journal, memory and context assembly; then the loop, alarms, system events, Pause and the pacer; then the goals board; see the "What 4x built" sections at the end). This is the specification for Phase 4 (the mind loop) and the base that the HUD and the redesign build on.

**Redesign of 2026-11-12.** The security toolkit is dropped and the goal is now a computer that is alive: see [VISION.md](VISION.md). This document describes the mind as it is built today. The section "What the redesign will change" at the end lists the rules below that later phases replace.

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
| Web access | Read-only fetch from an allow-list you control, plus read-only web search |
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

## 5. Web access

- **Fetch** goes through the executor: read-only, only to sites on an allow-list held in a root-owned file. Woody can ask to add a site; you approve. Private addresses and the host are never reachable this way.
- **Search** uses Claude's built-in web search, which runs on Anthropic's side. It returns titles, links and excerpts; opening a result still needs the site to be on the allow-list.
- **Quarantined reading.** A fetched page is first read by a small model with no tools, which extracts notes. The mind sees the notes, labelled as untrusted, not the raw page.
- **Tainted sessions.** A work session that has read web content can only take notes in the workspace. Acting on what was learned happens in a later session, from the notes. A page can therefore never directly trigger an action.

## 6. Pacing

- The monthly cap ($100) is spread as a daily allowance; what is not used rolls over.
- A quarter of the cap is Woody's own, paced the same way, for its own time. See "A life of its own" below.
- Each goal has a budget taken from the allowance. Estimates are compared with real spending, so Woody's estimates improve.
- A reserve is always kept for answering you.
- When the allowance is spent, Woody rests and says so. One setting in the HUD raises the cap.
- Moving to subscription usage later changes where the cost goes, not this mechanism.

## 7. Talking to you

- **Main thread:** the ongoing conversation.
- **Goal threads:** questions, decisions and progress for one goal.
- **Inbox:** everything that needs you, in one list: questions, plans to accept, approvals, proposals, identity changes, briefs.
- **Daily brief:** what it did, what it learned, what is blocked on you, what it plans next.
- **Catch-up:** when you open the HUD after an absence, a summary of what happened since.
- **Phone notification (later):** a push that says only that Woody needs you. No content leaves the machine. It needs an outside notification service and is built after the HUD.

## 8. What changes in the existing code

| Component | Change |
|---|---|
| `agent/` | The request-and-reply server becomes the loop: event queue, context assembler, work sessions, checkpoints, memory and goal tools, pacer. The chat protocol gains threads, inbox, state and journal messages |
| `executor/` (locked core) | Pause switch; approvals that wait instead of expiring; `web.fetch` with its allow-list; mind events in the audit log |
| `hud/` | Plain views for state, inbox, goals and journal in Phase 4; the real design in Phase 5 |
| `nix/` | Timers for the pulse and the daily copy; the journal watcher; firewall rule for the fetcher |

## 9. Build order (Phase 4)

| Step | Content | Done when |
|---|---|---|
| 4a | Store, event log, journal, threads saved to disk, memory items, context assembler, memory tools | Cold start, correction, honest gap and delete tests pass; the HUD keeps its transcript across reloads |
| 4b | Event queue, pulse, alarms, states, work sessions with checkpoints, message delivery at safe points, Stop and Pause, background jobs, system event filter, pacer | Kill mid-goal and rollback tests pass; Woody wakes on an alarm and on a failed service with nobody typing |
| 4c | Goals board data, review flow, small-goal rule, goal threads, proposals, standing goals (health first); plain HUD views | A goal written on the board is reviewed, questioned, estimated and, if small, completed unattended |
| 4d | Reflection, consolidation, identity with approval, daily brief and catch-up | Long gap test passes; an identity change is proposed and applied only after approval |
| 4e | Allow-listed fetch, search, quarantined reading, tainted sessions; "Staying updated" goes live | Poison test passes; an off-list fetch is refused and logged |

## What 4a built

Code: `agent/src/mind/` (`store.ts`, `context.ts`, `reflect.ts`, `tools.ts`), wired in `agent/src/server.ts`.

- **The store** is `/var/lib/woody/mind.db` (SQLite, opened with Node's built-in driver; no new dependency). It holds the append-only event log, the conversation, the journal, memories and the identity text.
- **Every turn is recorded as it happens:** your message, each tool call and its result, Woody's reply, and a journal entry. The journal entry is written by the program, not by the model, so it exists even if the turn fails or is stopped. If the agent is killed mid-turn, the next start notes it in the conversation and the journal.
- **Context is assembled from the store.** The system prompt carries the rules, the identity and the core memories (pinned ones and your preferences). In front of each of your messages Woody gets the time and the memories relevant to it. When its working context is fresh (after 45 minutes of silence, 30 turns, a restart, or `/new`), it also gets a recap: the conversation summary, the last 14 exchanges word for word, and the latest journal entries.
- **After each turn,** a small model with no tools writes a readable journal summary and, when the conversation has grown, folds the older part into the running summary. If that fails, the mechanical journal entry remains.
- **Memory tools for Woody:** `remember`, `memory_search`, `memory_history`, `memory_update`, `memory_forget`, `journal_search`, `conversation_search`.
- **Trust rules, enforced in the store:** a preference or a method can only have the origin "the operator said so"; web content can only be a fact and never enters the always-on core. The `web` origin cannot be chosen by Woody at all; it is reserved for the quarantined reader of 4e.
- **Your access** is through `sudo woody-chat` for now (the HUD panel is Phase 5): see AGENT.md.
- **The HUD keeps its transcript** across reloads: the agent sends the stored conversation when a client connects.

Not in 4a: the event queue and pulse (4b), goals (4c), reflection that extracts memories by itself, identity changes and briefs (4d), web access (4e), and the daily copy of the database (4b; until then it is covered by the pre-rebuild Btrfs snapshots only).

### Test status

| Test | Store level (automated, 12 tests in the build) | Model level (by hand in the VM) |
|---|---|---|
| Cold start | Passes | To do |
| Correction | Passes | To do |
| Honest gap | Passes | To do |
| Delete | Passes | To do |
| Poison | Passes (rule in the store) | Full test needs web access (4e) |
| Long gap | Passes with a simulated clock | Later |
| Kill mid-goal, Rollback | Recovery of an interrupted turn is built; the tests belong to 4b | Later |

## What 4b built

Code: `agent/src/server.ts` (the loop), `agent/src/mind/pulse.ts`, `agent/src/budget.ts` (the pacer), the queue, alarms and watches in `agent/src/mind/store.ts`; Pause in `executor/src/server.rs`.

- **One queue.** Your messages, alarms, system events, finished jobs and decided approvals all go into one queue in the store. Woody handles them one at a time: yours first, then by priority.
- **The pulse** runs every minute as plain code. It fires due alarms, follows what Woody is waiting for, and every two minutes checks the system. A model is called only if the queue then holds something.
- **System events:** a service that newly failed; a filesystem with less than 10% free; error-level log lines. The first two are rules. Log errors are deduplicated, then a small model with no tools answers IGNORE, NOTE or WAKE (at most 40 times a day). NOTE writes a journal line without waking Woody.
- **Alarms:** Woody sets them with `alarm_set` (a reason and a delay or a time), and gets the reason back when one goes off. At most 50 waiting.
- **Wake-ups by itself.** When Woody wakes without you, the conversation shows "woke up: ..." and then its message, if it has one. If it decides nothing needs saying, it stays silent and only the journal records it.
- **Your messages while it works** are delivered between two tool calls, in a block carrying a one-time key that tool output cannot know. If Woody makes no further tool call, your message is answered right after.
- **Stop** interrupts the current work. **Pause** is enforced by the executor: while paused, everything that is not read-only is refused, approving is refused too, and Woody starts nothing on its own. It still answers you. The agent cannot unpause itself.
- **Approvals wait.** A request stays in your inbox for a week instead of 10 minutes. Woody waits 90 seconds for you, then moves on and is woken with the outcome when you decide.
- **Crash safety.** An event that was being handled when the agent died or was restarted goes back in the queue once, and Woody is told it is a retry so it checks what it had already done. A second failure drops it, so a crash cannot loop. A change of the running system (including a rollback) is detected and written in the journal.
- **The pacer.** The monthly cap is released day by day; unused days roll over; half a day is kept in reserve for answering you. Woody's own work is refused when the released amount is used up, and there is a ceiling of 12 autonomous sessions an hour. Your messages are limited only by the monthly cap.
- **Daily copy** of the store in `/var/lib/woody/backups/`, kept for 30 days.

Limits to know:

- Approval requests are held in the executor's memory. If the executor restarts before you decide, they are lost; Woody is told so and can ask again.
- Per-goal budgets come with goals (4c).
- The HUD shows Woody's state and a Pause button, but not yet an inbox or the alarms; use `/alarms` in `woody-chat`.

### Test status

| Test | Automated | By hand in the VM |
|---|---|---|
| Queue order, deduplication, retry after a kill, alarms, pacer | 6 more store tests (18 in total) | |
| Pause | Live against the built executor: reads run, the rest is refused, approving is refused, the agent cannot resume, the audit chain holds | To do with the HUD button |
| Wake on an alarm | | To do |
| Wake on a failed service | | To do |
| Message delivered while working | | To do |
| Approval decided later | | To do |
| Kill mid-work with a real session | | To do |

## What 4c built

Code: goals in `agent/src/mind/store.ts`, `agent/src/mind/goal-tools.ts`, the goal context in `agent/src/mind/context.ts`, scheduling in `agent/src/server.ts`, the views in `hud/web/src/Board.tsx`.

- **The board.** You add goals in the HUD (or with `/goal-add` in `woody-chat`). Each goal has its own thread, where Woody asks questions and reports, and where you can write to it.
- **Review.** When Woody has nothing more urgent, it reviews the next goal in your inbox: it restates it, judges it (and may advise against it), plans it, and estimates cost and time, or asks the questions that stop it from planning.
- **Who starts what** is decided by a rule in the store, not by the model:
  - open questions: the goal waits on you;
  - a plan that is read-only, estimated under your small-goal limit (one dollar to start with, adjustable in the HUD), and that Woody recommends: it starts by itself, in observe-only mode, with that limit as its budget;
  - everything else waits for you to accept the plan. Accepting gives the goal full permissions and a budget of one and a half times the estimate.
- **Observe-only mode** applies whenever Woody acts on its own without a plan you accepted: wake-ups, small goals, standing duties. It may look, research, write in its workspace and ask for an approval. It may not apply a configuration change that would take effect without you seeing it; it must propose a goal instead. The tool layer enforces this.
- **Work.** Accepted goals are worked on in your order, one bounded session at a time. Each goal session starts from the goal's dossier, not from an earlier conversation, and must end with a checkpoint: the dossier rewritten and the exact next step.
- **Stops.** A goal stops and lands in your inbox when its budget is used up, when three sessions in a row end without a checkpoint, or when Woody needs an answer. Accepting it again lets it continue (with double the budget if that was the reason).
- **Proposals.** Woody can propose goals. They do nothing until you accept the idea, after which they are reviewed like yours. At most ten can wait.
- **Standing duties,** seeded at the first start: "Keep this machine healthy" (every 6 hours, $1.50 a week) and "Keep improving yourself" (weekly, $2 a week) are on; "Stay up to date" is off until web access (4e) exists. Each can be turned on or off in the HUD. They run in observe-only mode and report only what deserves your attention.
- **Order of attention:** your messages, then approvals, jobs, alarms and system events, then goals to review, then accepted goals, then standing duties. All of it is subject to Pause and to the pacer.
- **HUD:** three plain views behind the buttons in the top bar: **inbox** (plans to accept, questions, proposals), **goals** (the board, with a form to add one, and each goal's detail and thread), **journal**.

Limits to know:

- The estimate is the model's guess. The budget, not the estimate, is what is enforced.
- "Read-only" is declared by Woody in its review. The declaration decides whether the goal may start alone, but the permissions do not depend on it: a goal started that way stays in observe-only mode whatever its plan says.
- A goal session's reply appears in the goal's thread; the main conversation only gets a line when a goal needs you or is done.
- When the model API refuses requests (a spending limit on the key, an outage), Woody shows the error once, stops starting work on its own, and tries again after 5 minutes, then 10, 20 and so on up to 6 hours. Your own messages are still attempted. A review that fails three times for any other reason stops and waits for you.

### Test status

| Test | Automated | By hand in the VM |
|---|---|---|
| Small-goal rule, acceptance, budgets, stalls, proposals, standing duties, ordering | 6 more store tests (24 in total) | |
| Goal commands over the socket | Smoke test without an API key | |
| A goal reviewed, questioned, estimated and completed unattended | | To do |
| Observe-only refusal of a free configuration change | | To do |

## What 4d built

Code: `reflectionPrompt` and `briefPreamble` in `agent/src/mind/context.ts`, scheduling and presence in `agent/src/server.ts`, identity proposals and merging in `agent/src/mind/store.ts`.

- **Daily reflection.** Once a day, at the first quiet moment after 03:00, if you wrote to Woody or it did at least three things since the last one. Woody reads the period's record (its journal and what was said in every thread), stores what is durable, merges duplicates, corrects what is out of date, and may propose a change to its identity. It runs as its own session in its own thread, so nothing of it appears in the conversation; the journal records what it changed.
- **What reflection does not read:** tool output. Only lines you wrote are marked as yours, and only those can establish a preference or a method.
- **Merging** marks the duplicate as replaced by the memory that stays. Nothing is deleted, and a memory that came from you is never merged into a weaker one.
- **Identity.** As built in 4d, Woody proposed a new version of its identity text and nothing changed until you approved. Phase 8c replaced the proposal with a change Woody makes itself (see "Identity and face" below); a proposal that was still waiting can still be decided in the identity record. You can also rewrite the text yourself. Every version is kept. The identity is placed after the rules and is declared unable to override them.
- **Daily brief** at 08:00 local time by default (changeable, or off): what Woody did, what it learned, what is blocked on you, what it plans next. It is built from the journal, the board and what waits on you, so it does not depend on what the model happens to remember.
- **Catch-up.** The HUD sends a sign of life when you press a key or click (at most once a minute). If that comes after three hours of silence and Woody did things by itself meanwhile, it tells you what happened. If nothing worth telling happened, it says nothing.
- All three are ordinary queued events: Pause and the pacer apply, and they run in observe-only mode.

Limits to know:

- Reflection is one pass a day by the chat model, with a spending cap per session. It is not a guarantee that everything worth remembering is caught; `remember` during work is still the main route.
- "Local time" is the VM's time zone (`settings.nix`).
- The catch-up relies on the HUD's sign of life. Messages from `woody-chat` count too.

### Test status

| Test | Automated | By hand in the VM |
|---|---|---|
| Identity proposal, approval, rejection, history | Store tests (30 in total) and a socket smoke test | To do with the HUD |
| Merge rules; what reflection reads; brief material | Store tests | |
| A real reflection, brief and catch-up | | To do |

## What 4e built

Code: `executor/src/web.rs` (the fetch), `agent/src/web.ts` (the quarantined reader), the web tools in `agent/src/tools.ts`, the taint rule in `agent/src/server.ts`.

- **Fetch** is an executor action. It accepts only `https://` URLs on port 443 to hosts on the allow-list, a root-owned file (`/var/lib/woody-execd/web-allow.json`) seeded with NixOS, GitHub, Anthropic's documentation and two Linux news sources. The executor resolves the host itself, refuses any address that is not public (so never the VM or the host), and pins the connection to the address it checked. Redirects are not followed. The request is made by `curl` running as a user with no rights (`woody-web`).
- **A refused fetch is recorded** in the audit log with its reason, before anything touches the network.
- **Adding a site** is an approval-tier action: Woody asks with a reason, you approve in the HUD. You can also edit the file as root.
- **Search** uses Claude's web search, run by a separate small model whose only tool is the search.
- **Quarantined reading.** Woody never sees a page or a search result. A small model with no tools reads it and writes notes answering Woody's question; Woody gets the notes, labelled as untrusted. The reader is told to report instruction-like text instead of relaying it.
- **Tainted sessions.** Once a session has received web notes, it may only observe and take notes for the rest of that session. Refused from then on: service and configuration changes, alarms, changes to its identity and to its lattice's designs, corrections, merges and deletions of memory, goal reviews, clipboard offers, and requests to widen the allow-list. This is enforced in code, not left to the model. If it was the main conversation, the model's working context is dropped afterwards, so the next session starts from the store.
- **What may still be written in a tainted session** is marked: a memory is stored as a fact from the web whatever origin Woody claims (so never a preference or a method, and never in the always-on core); a goal checkpoint or proposal carries a line saying it was written after reading the web.
- **"Stay up to date"** is now on: once a day, $2 a week.

Limits to know:

- The reader is a model, and a model can be fooled into writing misleading notes. The design does not rely on the reader being right: it relies on notes not being able to *do* anything, and on nothing trusted being written from them without a mark or your approval.
- Search results can come from any site; only fetching is restricted to the allow-list.
- The fetch user is not yet confined by a firewall rule of its own; the allow-list is enforced by the executor. A per-user rule is a later hardening step.
- A session that read the web cannot act even if you ask it to in the same message. Ask again in your next message; Woody then works from what it noted.

### Test status

| Test | Automated | By hand in the VM |
|---|---|---|
| URL rules, allow-list matching, public-address check, reply parsing | 6 executor tests (55 in total) | |
| Fetch end to end | Live against the built executor with real network: an allowed page, an off-list host, plain http, an address, a redirect, a wildcard subdomain, an approved addition, the audit log | |
| Poison: a page cannot create a preference or a method | Agent test at the tool level (34 in total) | To do with a real page |
| Tainted session refuses to act | Rule in code; not exercised with a model | To do |
| Search | Not exercised: it needs the API | To do |

## The inner state (Phase 8a)

Code: `agent/src/mind/inner.ts`, wired in `agent/src/server.ts`.

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

Code: `agent/src/mind/life.ts` (the rules), `agent/src/mind/life-tools.ts` (the interests), `agent/src/server.ts` (the loop), `hud/server/canvas.ts` (the daily limit and the note).

### Time of its own

The loop handles your messages first, then events, then goals. When none of these is waiting, it asks one question in plain code: should Woody take a moment of its own now?

| It does not, when | Why it says |
|---|---|
| You turned its own time off | "its own time is turned off" |
| It is night | "it is night: it sleeps" |
| Its share of today's allowance is used | "its own share of the allowance is used for now" |
| Its energy is low (below 0.34) | "it is tired and resting" |
| You wrote in the last ten minutes | "you are talking with it" |
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

Code: the limits in `agent/src/mind/self.ts`, the tools in `agent/src/mind/self-tools.ts`, the versions in `agent/src/mind/store.ts`, the frame's side in `hud/web/src/frame/faceData.ts` and `Lattice.tsx`.

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

## What the redesign will change

Decided on 2026-11-12 and specified in [VISION.md](VISION.md). The last column says what is built; the phases are in [PLAN.md](PLAN.md).

| Today | After the redesign | Phase |
|---|---|---|
| Woody's identity changes only when you approve a proposal | Woody rewrites it itself after reflection, in small steps; you are told, every version is kept, any can be restored | 8c: built, see "Identity and face" above |
| Acting on its own, Woody is in observe-only mode and must propose a goal for any change | Woody changes the canvas and its own program freely, with undo; only the locked core needs approval | 7 (canvas), 10 (program) |
| Woody proposes goals of its own and waits | A share of the budget is its own, for interests and projects it chooses | 8b: built, see "A life of its own" above |
| No inner state beyond Working, Resting and so on | A few slow values with real causes (energy, ease, curiosity, attention, unease) that shape behaviour | 8a: built, see "The inner state" above |
| Web reading only from an allow-list you approve | Any public site through the quarantined reader; you keep a block list | 9 |
| $50 a month | $100 a month, a quarter of it Woody's own | 8b: built |

What does not change: the store as the mind, the event log, memory with origin and trust, the quarantined reader, the rule that a session which read the web cannot act, Pause and Stop, approvals for the locked core.

The "security fixes" in the "Stay up to date" duty mean updates for this machine's own software. In version 6 of the store's schema the "Practise in the lab" duty is deleted from existing stores.
