// Small helpers for the text the loop writes into its records.

/** Tool results can hold pictures; previews only need to know one was there. */
export function withoutImages(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((block) =>
    block && typeof block === "object" && (block as { type?: string }).type === "image" ? { type: "image", note: "[picture]" } : block,
  );
}

export function clip(value: unknown, max = 4000): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…[${text.length - max} more characters]` : text;
}

export const usd = (n: number): string => `$${n.toFixed(n < 1 ? 3 : 2)}`;

export const hhmm = (ts: number): string => `${new Date(ts).toISOString().slice(11, 16)} UTC`;
