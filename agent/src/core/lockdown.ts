// What must hold before anything else in the agent runs. This module is
// imported first by server.ts, so it is evaluated before every other one.
//
// Woody's own code runs in this same process (see gate.ts and selfcheck.mjs).
// The check on that code looks at what is written in its files. Code that is
// put together at run time, from a string, would not be in any file: so the
// agent refuses to run unless that is switched off for the whole process.
// The switch is a start-up option of node (set in nix/modules/agent.nix); it
// cannot be turned on again from inside.
let generates = true;
try {
  new Function("")();
} catch {
  generates = false;
}
if (generates) {
  console.error("woody-agent: refusing to start. Code generation at run time is possible in this process;");
  console.error("woody-agent: start node with --disallow-code-generation-from-strings (see nix/modules/agent.nix).");
  process.exit(78);
}

// The clock, JSON and arithmetic are what the limits are computed with: nobody replaces their functions.
for (const o of [Date, JSON, Math]) Object.freeze(o);

export {};
