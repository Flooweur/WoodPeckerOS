// The addresses a session was given.
//
// Since Phase 9 Woody may read any public site. That opens one new risk: a
// page that fools Woody could make it fetch a stranger's address with the
// operator's private data written into it. So, once a session has read the
// web, it may fetch only addresses that code found in the pages and search
// results it received. It can follow links and search again; it can no longer
// compose an address itself. The reader that sees the page knows nothing of
// Woody's memory, so an address taken from a page cannot carry it.
//
// The same list is used to clean what such a session writes down for later:
// an address it was not given is removed from the text.

/** The address in its one canonical form, or null if it is not a plain https address. */
export function normalUrl(raw: string, base?: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim(), base);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  if (u.port && u.port !== "443") return null;
  u.port = "";
  u.hash = "";
  return u.href.length <= 2000 ? u.href : null;
}

const MAX_GIVEN = 20_000;

export class GivenLinks {
  private readonly urls = new Set<string>();

  add(urls: Iterable<string>): void {
    for (const raw of urls) {
      if (this.urls.size >= MAX_GIVEN) return;
      const url = normalUrl(raw);
      if (url) this.urls.add(url);
    }
  }

  has(raw: string): boolean {
    const url = normalUrl(raw);
    return url !== null && this.urls.has(url);
  }

  get size(): number {
    return this.urls.size;
  }

  clear(): void {
    this.urls.clear();
  }
}

const decode = (s: string) => s.replace(/&amp;/gi, "&").replace(/&#x2f;/gi, "/").replace(/&#47;/g, "/").replace(/&quot;/gi, '"').replace(/&#39;/g, "'");

/** The links of an HTML page: where each points, and the words it is shown with. */
export function pageAnchors(html: string, pageUrl: string, max = 3000): Array<{ text: string; url: string }> {
  const out: Array<{ text: string; url: string }> = [];
  const seen = new Set<string>();
  const anchor = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi;
  for (const m of html.matchAll(anchor)) {
    const url = normalUrl(decode(m[1] ?? m[2] ?? m[3] ?? ""), pageUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const text = decode((m[4] ?? "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
    out.push({ text: text.slice(0, 80), url });
    if (out.length >= max) break;
  }
  return out;
}

const BARE = /https:\/\/[^\s<>"'`\\^{}|]+/g;

/** Addresses written out in running text (a search result list, a plain-text page). */
export function textLinks(text: string, max = 3000): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(BARE)) {
    // Punctuation that ends a sentence or closes a bracket is not part of the address.
    const url = normalUrl(m[0].replace(/[.,;:!?)\]]+$/, ""));
    if (url) out.add(url);
    if (out.size >= max) break;
  }
  return [...out];
}

const REMOVED = "[an address this session was not given: removed]";

/**
 * Text a session that read the web wants to keep, with every address it was
 * not given taken out. What it noted in words stays.
 */
export function scrubLinks(text: string, given: GivenLinks): string {
  return text.replace(/https?:\/\/[^\s<>"'`\\^{}|]+/gi, (found) => {
    const tail = /[.,;:!?)\]]+$/.exec(found)?.[0] ?? "";
    const url = tail ? found.slice(0, -tail.length) : found;
    return given.has(url) ? found : `${REMOVED}${tail}`;
  });
}
