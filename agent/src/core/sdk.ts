// The one place the agent calls a model from.
//
// Everything that starts a model session (the loop, the maker, the web
// reader, the small side calls) imports `query` from here. The tests put a
// scripted stand-in in its place, so the loop can be run without a model.
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";

export type Query = typeof sdkQuery;

let current: Query = sdkQuery;

export const query: Query = ((params: Parameters<Query>[0]) => current(params)) as Query;

/** For tests only: replaces the model by a stand-in. Returns a function that puts the real one back. */
export function useQuery(standIn: Query): () => void {
  current = standIn;
  return () => {
    current = sdkQuery;
  };
}
