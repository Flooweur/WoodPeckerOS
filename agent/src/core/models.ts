// The Claude models Woody uses, named once.
//
// When a model is replaced by a newer one, this is the only file to change.

export const MODELS = {
  /** Small jobs: journal summaries, the triage of log errors, the web reader, small edits. */
  small: "claude-haiku-5-5",
  /** Most thinking and most making. */
  everyday: "claude-sonnet-5-5",
  /** Intricate work, or a second attempt. */
  strong: "claude-opus-5-5",
  /** Only when the operator asks for the strongest. */
  strongest: "claude-fable-5-2",
} as const;

/** The models the operator can choose for the conversation. */
export const CHAT_MODELS = [
  { id: MODELS.everyday, label: "Sonnet 5.5", note: "default" },
  { id: MODELS.strong, label: "Opus 5.5", note: "stronger, about 2x the cost" },
  { id: MODELS.strongest, label: "Fable 5.2", note: "most capable, about 4x the cost" },
] as const;

export const DEFAULT_MODEL: string = MODELS.everyday;
/** For small calls that belong to no session. Not selectable for chat. */
export const TRIAGE_MODEL: string = MODELS.small;
