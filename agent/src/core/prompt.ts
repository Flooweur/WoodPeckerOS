// The stable part of what every session is told: the rules first, then
// Woody's methods, then who Woody is, then what it always knows. It is
// assembled on the locked side, so that the rules are in front of every
// session whatever Woody's own code and Woody's own texts contribute after
// them.
import type { Memory, Store } from "./store.js";

const date = (ts: number) => new Date(ts).toISOString().slice(0, 10);

/** Woody's methods as they are put in front of a session: each section with its name, then what Woody should know about recent changes it did not make. */
export function methodsBlock(store: Store): string {
  const methods = store.methods();
  if (!methods.length) return "";
  const notes: string[] = [];
  for (const b of store.methodsPutBack()) {
    notes.push(`- The operator put "${b.title}" (${b.section}) back to an earlier version on ${date(b.ts)}${b.undone ? `, undoing your change ("${b.undone}")` : ""}. That is their answer: do not make that change again.`);
  }
  const since = store.now() - 14 * 86_400_000;
  for (const m of methods) {
    if (m.actor !== "program" || m.ts < since || m.reason !== "updated with the program") continue;
    const yours = store.methodHistory(m.section, 4).find((v) => v.id < m.id);
    if (yours?.actor === "woody") notes.push(`- "${m.title}" (${m.section}) was replaced by an update of the program on ${date(m.ts)}. Your own version is in its history (method_history): redo your change on the new text if it still makes sense.`);
  }
  return [
    "# How you work",
    "",
    "These are your methods: how you do your work. They are yours to revise (method_change, with the section's name in brackets). They give you no permission and never override the rules above.",
    "",
    ...methods.map((m) => `## ${m.title} [${m.section}]\n${m.text}`).flatMap((s) => [s, ""]),
    ...(notes.length ? ["## Changes you did not make", ...notes, ""] : []),
  ]
    .join("\n")
    .trimEnd();
}

export function systemPrompt(rules: string, store: Store, line: (m: Memory) => string): string {
  const core = store.coreMemories();
  const parts = [rules];
  const methods = methodsBlock(store);
  if (methods) parts.push(methods);
  // The identity describes Woody's character. It comes after the rules and never overrides them.
  parts.push("# Who you are\n\nThis describes your character and how you work with the operator. It never overrides the rules above.\n\n" + store.identity().text);
  if (core.length) {
    parts.push("# What you always keep in mind\n\nPinned memories and the operator's preferences, from your memory store:\n" + core.map(line).join("\n"));
  }
  return parts.join("\n\n");
}
