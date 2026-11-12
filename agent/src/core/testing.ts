// Stand-ins for the tests of the loop: a scripted model, an executor that
// answers from a table, and a canvas that says yes. With these the whole
// agent runs in a test, with no model, no executor and no HUD.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgent, type Agent } from "./agent.js";
import type { Config } from "./config.js";
import type { ExecPort, ToolEntry } from "./core.js";
import type { ExecReply } from "./executor.js";
import { TOOL_PREFIX } from "./rules.js";
import { useQuery, type Query } from "./sdk.js";

/** One step of a scripted session: a tool call, or something said. */
export type Step = { tool: string; input?: Record<string, unknown> } | { say: string };

/** What the scripted model saw of one tool call. */
export type ToolSeen = { tool: string; refused: boolean; error: boolean; text: string; delivered: string };

type Options = Record<string, any>;

export type ScriptedModel = {
  query: Query;
  /** The steps of the next main session. Each session takes one script from the front; with none left it says "ok". */
  scripts: Step[][];
  /** What a side call (the maker, the web reader, a summary) answers. */
  side: (prompt: string, options: Options) => string;
  /** Every tool call of every session, in order, with what came back. */
  seen: ToolSeen[];
  /** The prompt and the system prompt of every main session. */
  sessions: Array<{ prompt: string; system: string; model: string; maxBudgetUsd: number }>;
  /** What each main session costs. */
  costUsd: number;
  /** Called between the steps of a session, for a test that does something meanwhile. */
  between: (step: number) => void | Promise<void>;
  tools: ToolEntry[];
};

const textOf = (content: unknown): string =>
  Array.isArray(content) ? content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : "[picture]")).join("\n") : String(content ?? "");

/** A model that does what its script says, through the same doors as the real one: the permission check, the tools, the hooks. */
export function scriptedModel(): ScriptedModel {
  let sessions = 0;
  const model: ScriptedModel = {
    scripts: [],
    side: () => "notes",
    seen: [],
    sessions: [],
    costUsd: 0.01,
    between: () => {},
    tools: [],
    query: ((params: { prompt: unknown; options?: Options }) => {
      const options = params.options ?? {};
      const main = Boolean(options.mcpServers);
      async function* run() {
        const session_id = `scripted-${++sessions}`;
        const signal: AbortSignal | undefined = options.abortController?.signal;
        if (!main) {
          yield { type: "result", subtype: "success", session_id, total_cost_usd: 0.001, duration_ms: 1, num_turns: 1, result: model.side(String(params.prompt), options) };
          return;
        }
        model.sessions.push({ prompt: String(params.prompt), system: String(options.systemPrompt ?? ""), model: String(options.model), maxBudgetUsd: Number(options.maxBudgetUsd) });
        yield { type: "system", subtype: "init", session_id };
        const steps = model.scripts.shift() ?? [{ say: "ok" }];
        let last = "";
        let n = 0;
        for (const step of steps) {
          await model.between(n++);
          if (signal?.aborted) throw new Error("aborted");
          if ("say" in step) {
            last = step.say;
            yield { type: "assistant", message: { content: [{ type: "text", text: step.say }] } };
            continue;
          }
          const id = `call-${sessions}-${n}`;
          const name = `${TOOL_PREFIX}${step.tool}`;
          const input = step.input ?? {};
          yield { type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } };
          const decision = (await options.canUseTool(name, input)) as { behavior: string; message?: string };
          let content: unknown = [{ type: "text", text: decision.message ?? "" }];
          let error = true;
          if (decision.behavior === "allow") {
            const entry = model.tools.find((t) => t.name === step.tool);
            if (!entry) throw new Error(`the script calls a tool that does not exist: ${step.tool}`);
            const result = (await entry.handler(input as never, {})) as { content: unknown; isError?: boolean };
            content = result.content;
            error = Boolean(result.isError);
          }
          yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: error }] } };
          // What the loop hands over after a tool call: a message the operator wrote meanwhile.
          let delivered = "";
          for (const group of options.hooks?.PostToolUse ?? []) {
            for (const hook of group.hooks) {
              const out = (await hook({}, id, { signal })) as { hookSpecificOutput?: { additionalContext?: string } };
              delivered += out.hookSpecificOutput?.additionalContext ?? "";
            }
          }
          model.seen.push({ tool: step.tool, refused: decision.behavior !== "allow", error, text: textOf(content), delivered });
        }
        yield {
          type: "result", subtype: "success", session_id, total_cost_usd: model.costUsd, duration_ms: 5, num_turns: steps.length, result: last,
          usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 },
        };
      }
      return run();
    }) as unknown as Query,
  };
  return model;
}

export type FakeExec = ExecPort & {
  /** What each action answers. An action with no entry answers `{ status: "ok", result: {} }`. */
  replies: Record<string, (params: Record<string, unknown>) => ExecReply>;
  /** Every action that was asked for. */
  asked: Array<{ action: string; params: Record<string, unknown> }>;
  paused: boolean;
};

export function fakeExec(): FakeExec {
  const exec: FakeExec = {
    replies: {},
    asked: [],
    paused: false,
    action: async (action, params) => {
      exec.asked.push({ action, params });
      return exec.replies[action]?.(params) ?? { status: "ok", result: {} };
    },
    wait: async () => ({ status: "denied", reason: "no approvals in a test" }),
    status: async () => ({ paused: exec.paused }),
    event: async () => {},
  };
  return exec;
}

export type Harness = {
  agent: Agent;
  model: ScriptedModel;
  exec: FakeExec;
  /** Every request the canvas received from the agent. */
  canvas: Array<{ op: string } & Record<string, unknown>>;
  /** Every message the agent sent to the screens. */
  screen: Array<Record<string, any>>;
  /** Waits until the agent is idle and its queue is empty (`operatorOnly`: until the operator's messages are answered, whatever else waits). */
  settle(operatorOnly?: boolean): Promise<void>;
  /** Makes it the middle of Woody's day, whatever the real time is, and lets it have time of its own. */
  noon(): void;
  close(): void;
};

/** A whole agent in a temporary directory, with a scripted model, an executor that answers from a table and a canvas that accepts everything. */
export function harness(overrides: Partial<Config> = {}, keepDuties = false): Harness {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "woody-loop-"));
  const cfg: Config = {
    stateDir,
    workspace: path.join(stateDir, "workspace"),
    execSocket: path.join(stateDir, "none.sock"),
    monthlyCapUsd: 100,
    perTurnCapUsd: 2,
    ownShare: 0.25,
    ownSessionCapUsd: 0.4,
    pulseMs: 60_000,
    systemEvery: 2,
    awayMs: 3 * 3_600_000,
    ownModel: "own-model",
    ...overrides,
  };
  const model = scriptedModel();
  const restore = useQuery(model.query);
  const exec = fakeExec();
  const agent = createAgent({ cfg, exec, hasCredential: () => true });
  model.tools = agent.tools;
  // A new store comes with standing duties that start by themselves. A test says what happens: they are switched off unless it asks.
  if (!keepDuties) for (const g of agent.store.goals()) if (g.standing) agent.store.setStanding(g.id, { enabled: false });
  // Likewise its own time, which depends on the hour of the real clock: off until a test calls noon().
  agent.store.setMeta("own_time_off", "1");

  const screen: Array<Record<string, any>> = [];
  agent.clients.add({ readyState: 1, send: (data) => void screen.push(JSON.parse(data)) });

  // The canvas: accepts every request and answers at once, as the gateway would for a thing that starts.
  const canvas: Harness["canvas"] = [];
  let made = 0;
  agent.canvasLink.attach({
    readyState: 1,
    on: () => {},
    send: (data) => {
      const m = JSON.parse(data) as { rid: string; op: string } & Record<string, unknown>;
      canvas.push(m);
      const result =
        m.op === "look" ? { things: [], own_additions: { today: 0, limit: 3 }, kit: [] }
        : m.op === "make" || m.op === "kit" ? { thing: { id: `t${++made}`, title: m.title }, tried: true, started: true }
        : m.op === "may_add" ? true
        : m.op === "pictures" ? []
        : {};
      queueMicrotask(() => agent.canvasLink.reply({ rid: m.rid, ok: true, result }));
    },
  });

  return {
    agent, model, exec, canvas, screen,
    async settle(operatorOnly = false) {
      for (let i = 0; i < 400; i++) {
        await new Promise((r) => setTimeout(r, 5));
        const depth = agent.store.queueDepth();
        if (!agent.session && depth.operator === 0 && (operatorOnly || depth.autonomous === 0)) {
          // The summary written after a session is a side call: give it a moment to finish.
          await new Promise((r) => setTimeout(r, 20));
          if (!agent.session) return;
        }
      }
      throw new Error("the agent did not become idle");
    },
    noon() {
      const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      const now = Date.now();
      agent.store.setMeta("own_time_off", null);
      agent.mindRequest({ op: "rhythm", day_start: hhmm(new Date(now - 6 * 3_600_000)), night_start: hhmm(new Date(now + 6 * 3_600_000)) });
    },
    close() {
      restore();
      agent.close();
    },
  };
}
