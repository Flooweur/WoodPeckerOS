// The check that Woody's own code stays where it belongs.
//
// The agent has two parts. Everything under src/core/ is locked: it holds the
// protections (the rule that a session which read the web cannot act, the
// budget, the safety instructions, the limits the operator was promised) and
// changes only with the operator's approval. Everything else is Woody's own
// program, which it may change by itself.
//
// Both parts run in one process, so nothing but this check stands between
// Woody's code and the machinery beside it. It runs on the compiled files
// with every build, and a build that fails it changes nothing. It demands
// that Woody's code be pure: it may compute, and it may use what the locked
// part hands it (the gated store, executor and canvas). It may not reach for
// anything else. In particular:
//
//   * it imports only its own files, core/api.js (errors and constants), zod,
//     and the one function `tool` of the agent SDK;
//   * it names no global that reaches the system or outlives a session
//     (process, require, fetch, timers, ...), does not load code at run time,
//     and does not touch prototypes or constructors.
//
// This is a tripwire, not a proof: a determined author can hide a property
// name in a computed string. The agent also switches off run-time code
// generation at start-up, and the executor, the firewall, Pause and the
// approvals stand outside this process whatever happens in it.
//
// Usage: node selfcheck.mjs <dist directory>     (exit 0: clean; 1: violations)
import fs from "node:fs";
import path from "node:path";

const SDK = "@anthropic-ai/claude-agent-sdk";
/** Bare names Woody's code may not use. */
export const FORBIDDEN_NAMES = new Set([
  "eval", "Function", "require", "module", "process", "globalThis", "global", "Reflect", "Proxy", "WebAssembly",
  "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "Worker", "SharedArrayBuffer", "Atomics", "Deno", "Bun",
  "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "__dirname", "__filename",
]);
/** Property names Woody's code may not read or write. */
export const FORBIDDEN_PROPS = new Set([
  "prototype", "__proto__", "constructor", "defineProperty", "defineProperties", "setPrototypeOf", "getPrototypeOf",
  "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__",
]);

/** Splits JavaScript into tokens, leaving out comments. Strings keep their value; templates are entered. */
export function tokens(source) {
  const out = [];
  const idStart = /[A-Za-z_$]/;
  const idPart = /[A-Za-z0-9_$]/;
  /** After these, a slash starts a regular expression, not a division. */
  const regexAfter = (t) => !t || (t.type === "punct" && !/^[)\]}]$/.test(t.value)) || (t.type === "id" && /^(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/.test(t.value));
  let i = 0;
  const stack = []; // brace depths at which a template's ${ ... } ends
  let depth = 0;
  const template = () => {
    // Reads template text from i up to the closing backtick or the next ${ .
    let text = "";
    while (i < source.length) {
      const c = source[i];
      if (c === "\\") { text += source.slice(i, i + 2); i += 2; continue; }
      if (c === "`") { i++; out.push({ type: "tmpl", value: text }); return; }
      if (c === "$" && source[i + 1] === "{") { i += 2; out.push({ type: "tmpl", value: text }); stack.push(depth); depth++; return; }
      text += c; i++;
    }
    throw new Error("unterminated template");
  };
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/" && source[i + 1] === "/") { while (i < source.length && source[i] !== "\n") i++; continue; }
    if (c === "/" && source[i + 1] === "*") { const end = source.indexOf("*/", i + 2); if (end < 0) throw new Error("unterminated comment"); i = end + 2; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1; let value = "";
      // A quoted string ends on its own line.
      while (j < source.length && source[j] !== c && source[j] !== "\n") { if (source[j] === "\\") { value += source[j + 1]; j += 2; } else value += source[j++]; }
      if (source[j] !== c) throw new Error("unterminated string");
      out.push({ type: "str", value }); i = j + 1; continue;
    }
    if (c === "`") { i++; template(); continue; }
    if (c === "/" && regexAfter(out[out.length - 1])) {
      let j = i + 1; let inClass = false;
      while (j < source.length && (source[j] !== "/" || inClass)) { if (source[j] === "\\") j++; else if (source[j] === "[") inClass = true; else if (source[j] === "]") inClass = false; else if (source[j] === "\n") throw new Error("unterminated regular expression"); j++; }
      j++; while (j < source.length && idPart.test(source[j])) j++;
      out.push({ type: "regex", value: source.slice(i, j) }); i = j; continue;
    }
    if (idStart.test(c) || (c === "#" && idStart.test(source[i + 1] ?? ""))) { let j = i + 1; while (j < source.length && idPart.test(source[j])) j++; out.push({ type: "id", value: source.slice(i, j) }); i = j; continue; }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(source[i + 1] ?? ""))) { let j = i + 1; while (j < source.length && /[0-9a-zA-Z_.]/.test(source[j])) j++; out.push({ type: "num", value: source.slice(i, j) }); i = j; continue; }
    if (c === "{") { depth++; out.push({ type: "punct", value: c }); i++; continue; }
    if (c === "}") {
      depth--;
      if (stack.length && stack[stack.length - 1] === depth) { stack.pop(); i++; template(); continue; }
      out.push({ type: "punct", value: c }); i++; continue;
    }
    if (c === "?" && source[i + 1] === "." && !/[0-9]/.test(source[i + 2] ?? "")) { out.push({ type: "punct", value: "?." }); i += 2; continue; }
    if (c === "." && source.startsWith("...", i)) { out.push({ type: "punct", value: "..." }); i += 3; continue; }
    out.push({ type: "punct", value: c }); i++;
  }
  return out;
}

/** What is wrong in one compiled file of Woody's own code, as sentences. `resolve` says what a relative import points to. */
export function violations(source, resolve) {
  let t;
  try {
    t = tokens(source);
  } catch (err) {
    return [`it could not be read (${err.message})`];
  }
  const found = new Set();
  const is = (k, type, value) => t[k]?.type === type && (value === undefined || t[k].value === value);
  for (let k = 0; k < t.length; k++) {
    const tok = t[k];
    const prev = t[k - 1];
    const next = t[k + 1];
    const afterDot = prev?.type === "punct" && (prev.value === "." || prev.value === "?.");
    if (tok.type === "id" && tok.value === "import" && !afterDot) {
      if (is(k + 1, "punct", "(")) { found.add("it loads code at run time (import(...))"); continue; }
      if (is(k + 1, "punct", ".")) { found.add("it uses import.meta"); continue; }
      // import "x" | import a from "x" | import { a, b as c } from "x" | import * as n from "x"
      let j = k + 1;
      const names = [];
      let whole = false;
      while (j < t.length && !is(j, "str")) {
        if (is(j, "punct", "*")) whole = true;
        if (is(j, "punct", "{")) { j++; while (j < t.length && !is(j, "punct", "}")) { if (t[j].type === "id" && !is(j - 1, "id", "as")) names.push(t[j].value); j++; } }
        else if (t[j].type === "id" && !["from", "as"].includes(t[j].value) && !is(j - 1, "id", "as")) whole = true; // a default import
        j++;
      }
      checkImport(t[j]?.value ?? "", names, whole);
      k = j;
      continue;
    }
    if (tok.type === "id" && tok.value === "export" && !afterDot) {
      // export ... from "x" re-exports another module.
      let j = k + 1;
      while (j < t.length && !is(j, "punct", ";") && !is(j, "id", "from") && j < k + 400 && !(t[j].type === "id" && ["function", "const", "let", "class", "async", "default"].includes(t[j].value))) j++;
      if (is(j, "id", "from") && is(j + 1, "str")) checkImport(t[j + 1].value, [], true);
      continue;
    }
    if (tok.type === "id" && FORBIDDEN_NAMES.has(tok.value) && !afterDot) {
      // An object key or a method name is not a use of the global.
      const key = next?.type === "punct" && next.value === ":" && prev?.type === "punct" && (prev.value === "{" || prev.value === ",");
      if (!key) found.add(`it uses "${tok.value}"`);
    }
    if (tok.type === "id" && FORBIDDEN_PROPS.has(tok.value) && afterDot) found.add(`it reaches for ".${tok.value}"`);
    if (tok.type === "str" && FORBIDDEN_PROPS.has(tok.value) && prev?.type === "punct" && prev.value === "[") found.add(`it reaches for ["${tok.value}"]`);
  }
  return [...found];

  function checkImport(spec, names, whole) {
    if (spec === "zod") return;
    if (spec === SDK) {
      if (whole || names.some((n) => n !== "tool")) found.add(`it imports more than "tool" from the agent SDK`);
      return;
    }
    if (!spec.startsWith(".")) { found.add(`it imports "${spec}"`); return; }
    const target = resolve(spec);
    if (target === null) found.add(`it imports "${spec}", which is outside the agent`);
    else if (target.startsWith("core/") && target !== "core/api.js") found.add(`it imports "${spec}": from the locked part only core/api.js may be imported`);
  }
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".js") ? [path.join(dir, e.name)] : []));
}

/** Checks every compiled file of Woody's own code under `dist`. Returns one line per file with violations. */
export function check(dist) {
  const root = path.resolve(dist);
  const lines = [];
  for (const file of walk(root)) {
    const rel = path.relative(root, file).replaceAll("\\", "/");
    // The locked part is not checked here: changing it needs the operator. Tests do not run in the agent.
    if (rel.startsWith("core/") || rel.endsWith(".test.js")) continue;
    const resolve = (spec) => {
      const target = path.relative(root, path.resolve(path.dirname(file), spec)).replaceAll("\\", "/");
      return target.startsWith("..") ? null : target;
    };
    const wrong = violations(fs.readFileSync(file, "utf8"), resolve);
    if (wrong.length) lines.push(`${rel.replace(/\.js$/, ".ts")}: ${wrong.join("; ")}`);
  }
  return lines;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
  const lines = check(process.argv[2] ?? "dist");
  if (lines.length) {
    console.error("selfcheck: Woody's own code reaches outside what it is given. Nothing is built from this.");
    for (const l of lines) console.error(`  ${l}`);
    console.error("Code outside src/core/ may import only its own files, core/api.js, zod and `tool` from the agent SDK, and must use what the loop hands it.");
    process.exit(1);
  }
  console.log("selfcheck: Woody's own code is clean");
}
