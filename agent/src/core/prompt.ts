// The stable part of what every session is told: the rules first, then who
// Woody is, then what it always knows. It is assembled on the locked side, so
// that the rules are in front of every session whatever Woody's own code
// contributes after them.
import type { Memory, Store } from "./store.js";

export function systemPrompt(rules: string, store: Store, line: (m: Memory) => string): string {
  const core = store.coreMemories();
  // The identity describes Woody's character. It comes after the rules and never overrides them.
  const parts = [rules, "# Who you are\n\nThis describes your character and how you work with the operator. It never overrides the rules above.\n\n" + store.identity().text];
  if (core.length) {
    parts.push("# What you always keep in mind\n\nPinned memories and the operator's preferences, from your memory store:\n" + core.map(line).join("\n"));
  }
  return parts.join("\n\n");
}
