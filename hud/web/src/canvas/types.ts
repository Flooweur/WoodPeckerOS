// What the gateway says about the canvas (hud/server/canvas.ts).
export type Actor = "woody" | "you";
export type Box = { x: number; y: number; w: number; h: number; z: number };
export type ThingVersion = { v: number; ts: number; by: Actor; why: string; bytes: number };
export type ThingInfo = {
  id: string;
  title: string;
  kind: "real" | "pretend";
  for: "you" | "woody";
  by: Actor;
  why: string;
  created: number;
  version: number;
  versions: ThingVersion[];
  box: Box;
  pinned: boolean;
  removed: boolean;
  /** The unguessable name under which the gateway serves this thing. */
  key: string;
};
export type CanvasChange = {
  seq: number;
  ts: number;
  by: Actor;
  op: string;
  id: string;
  title: string;
  why: string;
  refused?: string;
  undone: boolean;
  text: string;
};
export type CanvasState = { things: ThingInfo[]; undo: { seq: number; by: Actor; text: string } | null };
export type CanvasResult = { seq: number; rid: string | null; op: string; ok: boolean; result?: any; error?: string };
