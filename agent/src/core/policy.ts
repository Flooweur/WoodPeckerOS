// What a session may do: one table.
//
// Every tool, every executor action, every canvas request and every write to
// the mind's store has a kind. Whether a kind is allowed depends on the
// session in progress. The gates (gate.ts, woody-store.ts) and the loop all
// ask here, so the rule is written once.
//
// Something that has no kind is refused: a new tool does nothing until it is
// added to this table (policy.test.ts checks that every tool is in it).

export type Kind =
  /** Reads: the machine, the canvas, Woody's own records. */
  | "look"
  /** Reading the web through the quarantined reader. */
  | "read-web"
  /** Writing something down, marked with where it came from: a memory, a note, a checkpoint, a file in the workspace. */
  | "note"
  /** A notice on the operator's screen. */
  | "notify"
  /** An expression on the lattice. */
  | "express"
  /** A change to the canvas. */
  | "canvas"
  /** Deciding what Woody will do later: alarms, interests, studies, the review of a goal. */
  | "plan"
  /** Changing what Woody is: its identity, its methods, its face. */
  | "self"
  /** Correcting, merging or deleting a memory. */
  | "memory-edit"
  /** Text offered to the operator's clipboard, which leaves the machine with them. */
  | "clipboard"
  /** A change to the system: services, the configuration. */
  | "system"
  /** A program run in the workbench without network: it can change the workbench's files and nothing else. */
  | "work"
  /** A program run in the workbench with the network: what it brings back is web content, and it could send data out. */
  | "work-net";

/**
 * What a session that has read the web may still do.
 *
 * Today: observe and take notes. The review of 2026-11-12 decided that it
 * may also do what stays inside the machine ("canvas" and "plan"); that
 * change is made here, in these two lines, when it is built.
 */
const AFTER_WEB: Record<Kind, boolean> = {
  look: true,
  "read-web": true,
  note: true,
  notify: true,
  express: true,
  canvas: false,
  plan: false,
  self: false,
  "memory-edit": false,
  clipboard: false,
  system: false,
  // The workbench without network stays inside the machine. With the network it would be a way out.
  work: true,
  "work-net": false,
};

/** Kinds that count as reading the web: once done, the session is one that has read the web. */
export const READS_WEB: ReadonlySet<Kind> = new Set<Kind>(["read-web", "work-net"]);

export const TAINTED =
  "Refused: this session has read web content, so for the rest of it you may only observe and take notes. Write down what you learned and what you think should be done. Acting on it happens in a later session, from those notes.";

/** Why this kind of action is refused in this session, or null when it is allowed. */
export function refusal(kind: Kind | undefined, session: { tainted: boolean }): string | null {
  if (kind === undefined) return "Refused: this action is not in the policy table (core/policy.ts).";
  if (session.tainted && !AFTER_WEB[kind]) return TAINTED;
  return null;
}

/** Woody's tools. */
export const TOOL_KIND: Record<string, Kind> = {
  // the machine
  system_info: "look", process_list: "look", service_list: "look", service_status: "look", journal_query: "look", osquery: "look", screenshot: "look",
  service_start: "system", service_stop: "system", service_restart: "system",
  config_propose: "system", config_apply: "system", config_status: "look",
  fs_list: "look", fs_read: "look", fs_write: "note",
  hud_notify: "notify", clipboard_offer: "clipboard",
  // the workbench (with the network, the gate treats the run as "work-net")
  run: "work",
  // the web
  web_search: "read-web", web_fetch: "read-web", web_picture: "read-web", web_blocklist: "look",
  // the canvas
  canvas_look: "look", thing_source: "look", kit_place: "canvas", thing_make: "canvas", thing_change: "canvas", thing_place: "canvas", thing_remove: "canvas",
  thing_state: "look", thing_state_set: "canvas", thing_write: "canvas", thing_patch: "canvas",
  // memory, journal, alarms
  remember: "note", memory_search: "look", memory_history: "look", memory_update: "memory-edit", memory_merge: "memory-edit", memory_forget: "memory-edit",
  journal_search: "look", conversation_search: "look",
  alarm_set: "plan", alarm_list: "look", alarm_cancel: "plan",
  // goals
  goal_board: "look", goal_get: "look", goal_review: "plan", goal_checkpoint: "note", goal_propose: "note",
  // its own life
  inner_state: "look",
  interest_add: "plan", interest_list: "look", interest_note: "note", interest_drop: "plan",
  study_start: "plan", study_note: "note", study_plan: "note", study_done: "note", study_list: "look", study_get: "look", study_drop: "plan",
  // what it is
  identity_change: "self", face_list: "look", face_design: "self", face_reset: "self", express: "express",
  method_change: "self", method_remove: "self", method_history: "look",
};

/** The executor's actions. One that is not listed counts as a change to the system. */
export const EXEC_KIND: Record<string, Kind> = {
  "system.info": "look", "process.list": "look", "service.list": "look", "service.status": "look", "journal.tail": "look", "journal.query": "look",
  "osquery.query": "look", "screen.capture": "look", "config.status": "look", "web.blocklist": "look",
  "web.fetch": "read-web", "web.picture": "read-web",
  "service.start": "system", "service.stop": "system", "service.restart": "system", "config.propose": "system", "config.apply": "system",
};

/** The kind of one request to the executor. A workbench run is another kind when it asks for the network. */
export function execKind(action: string, params: Record<string, unknown>): Kind {
  if (action === "work.run") return params.network === true ? "work-net" : "work";
  // An action this table does not know counts as a change to the system; the executor refuses it anyway.
  return EXEC_KIND[action] ?? "system";
}

/** The requests Woody's canvas tools can make to the canvas. One that is not listed cannot be made at all. */
export const CANVAS_KIND: Record<string, Kind> = {
  look: "look", get: "look", pictures: "look", limits: "look", may_add: "look", kit_catalogue: "look", state_get: "look",
  make: "canvas", kit: "canvas", change: "canvas", restore: "canvas", place: "canvas", remove: "canvas", bring_back: "canvas", state_set: "canvas",
};
