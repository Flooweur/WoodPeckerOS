// Recall by meaning.
//
// Woody's memory is searched by words (SQLite full-text search). That misses
// a memory about a "holiday" when the question says "trip". An embedding
// model turns a text into a list of numbers such that texts with a similar
// meaning get similar lists; with one running in the machine, memories are
// also found by meaning.
//
// The model is a separate local service (nix/modules/embed.nix). Without it, or
// when it does not answer in time, everything here falls back to the search
// by words: recall by meaning never blocks an answer.
import http from "node:http";

export type Embedder = {
  /** The model's name: vectors of different models cannot be compared, so each stored vector says which made it. */
  model: string;
  /** One vector per text. A question and a stored text may be prepared differently by some models. */
  embed(texts: string[], kind: "query" | "passage"): Promise<Float32Array[]>;
};

/** One POST of JSON, to "http://host:port" or to a Unix socket written as "unix:/path/to.sock". */
function postJson(url: string, pathname: string, payload: unknown, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const where = url.startsWith("unix:") ? { socketPath: url.slice(5) } : { hostname: new URL(url).hostname, port: new URL(url).port || 80 };
    const req = http.request(
      { ...where, path: pathname, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error(`the embedding service answered ${res.statusCode}`));
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error("the embedding service did not answer in JSON"));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("the embedding service did not answer in time")));
    req.on("error", reject);
    req.end(body);
  });
}

/** An embedding service that speaks the common "/v1/embeddings" protocol (llama.cpp's server does). */
export function httpEmbedder(opts: { url: string; model: string; queryPrefix?: string; passagePrefix?: string; timeoutMs?: number }): Embedder {
  return {
    model: opts.model,
    async embed(texts, kind) {
      const prefix = (kind === "query" ? opts.queryPrefix : opts.passagePrefix) ?? "";
      const body = (await postJson(opts.url, "/v1/embeddings", { model: opts.model, input: texts.map((t) => prefix + t) }, opts.timeoutMs ?? 6000)) as {
        data?: Array<{ index?: number; embedding?: number[] }>;
      };
      const data = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (data.length !== texts.length || data.some((d) => !Array.isArray(d.embedding) || !d.embedding.length)) throw new Error("the embedding service returned something else than one vector per text");
      return data.map((d) => Float32Array.from(d.embedding!));
    },
  };
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * How similar an item must be to the question to count as related, given the
 * similarities of all items.
 *
 * Something is always "closest", also when nothing is related, and with a real
 * model even unrelated texts are fairly similar (about 0.4 with bge-m3). So an
 * item must stand out from the background: the less similar half of the
 * items, which is unrelated whatever the question. It must be above that
 * half's average by three of its standard deviations and by at least 0.10.
 * (Measured with bge-m3 on 2026-11-12: related memories stood 0.13 to 0.28
 * above the background, the closest unrelated ones 0.05 to 0.07.)
 * With fewer than four items there is no background, and a fixed floor is used.
 */
export function relatedFloor(sims: number[]): number {
  if (sims.length < 4) return 0.55;
  const low = [...sims].sort((a, b) => a - b).slice(0, Math.ceil(sims.length / 2));
  const mean = low.reduce((s, x) => s + x, 0) / low.length;
  const sd = Math.sqrt(low.reduce((s, x) => s + (x - mean) ** 2, 0) / low.length);
  return mean + Math.max(3 * sd, 0.1);
}

/** The stored items related in meaning to the question (see relatedFloor), closest first. */
export function nearest(query: Float32Array, items: Array<{ id: number; vec: Float32Array }>, limit: number): number[] {
  const scored = items.map((it) => ({ id: it.id, sim: cosine(query, it.vec) }));
  if (!scored.length) return [];
  const floor = relatedFloor(scored.map((x) => x.sim));
  return scored
    .filter((x) => x.sim >= floor)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, limit)
    .map((x) => x.id);
}

/**
 * One list out of several ranked lists (reciprocal rank fusion): an item
 * near the top of any list ranks high, and one found by both ranks higher.
 */
export function fuse(lists: number[][], limit: number): number[] {
  const score = new Map<number, number>();
  for (const list of lists) list.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (60 + i)));
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);
}

export const vectorToBlob = (v: Float32Array): Uint8Array => new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice();
export const blobToVector = (b: Uint8Array): Float32Array => new Float32Array(b.slice().buffer);
