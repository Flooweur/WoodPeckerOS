// One small model call with no tools: the way every background reader and
// summariser in the agent speaks to a model. It lives in the locked part
// because it holds the model interface; what Woody may change calls it only
// through a function handed to it, which records the cost.
import { query } from "./sdk.js";

export type CostSink = (model: string, costUsd: number) => void;

export async function ask(model: string, system: string, prompt: string, cwd: string, onCost: CostSink): Promise<string> {
  let out = "";
  for await (const message of query({
    prompt,
    options: {
      model,
      systemPrompt: system,
      tools: [],
      settingSources: [],
      persistSession: false,
      maxTurns: 1,
      maxBudgetUsd: 0.05,
      cwd,
    },
  })) {
    if (message.type === "result") {
      onCost(model, message.total_cost_usd ?? 0);
      if (message.subtype === "success") out = message.result;
    }
  }
  return out.trim();
}

/** A model call as it is handed to code outside the locked part: the model, the working directory and the cost record are already fixed. */
export type Aside = (system: string, prompt: string) => Promise<string>;
