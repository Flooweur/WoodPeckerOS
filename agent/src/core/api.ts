// What Woody's own code may import from the locked side as values: errors
// and constants. Everything that does something (the store, the executor, the
// canvas, a model call) is handed to it by the loop, behind the gates
// (gate.ts, woody-store.ts), and never imported. The check that runs with
// every build (selfcheck.mjs) enforces this.
export { FileError } from "./files.js";
export { FACE, IDENTITY, PALETTE, RESERVED } from "./self.js";
export { MEMORY_KINDS, PolicyError, STUDY } from "./store.js";
export { WEB_MARK } from "./woody-store.js";
