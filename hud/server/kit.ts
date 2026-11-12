// The kit: ready parts for the canvas.
//
// A part is not a special kind of thing. Placing one writes an ordinary
// thing's source from a few values, so it appears at once and costs no model
// time, and afterwards it can be changed like any other thing. The kit is a
// convenience and never a limit: anything it lacks is written as a thing.
import { CanvasError } from "./canvas.js";

type Props = Record<string, unknown>;
type Part = {
  /** One line for Woody: what the part is and the values it takes. */
  about: string;
  /** Checks the values and returns the thing's source. Throws CanvasError on bad values. */
  build(props: Props): string;
};

const FEEDS = ["cpu", "memory", "disk", "network"] as const;

function str(props: Props, key: string, max: number, required = false): string {
  const v = props[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new CanvasError(`the part needs "${key}"`);
    return "";
  }
  if (typeof v !== "string") throw new CanvasError(`"${key}" must be text`);
  if (v.length > max) throw new CanvasError(`"${key}" is limited to ${max} characters`);
  return v;
}
function oneOf<T extends string>(props: Props, key: string, allowed: readonly T[], fallback: T): T {
  const v = props[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "string" || !allowed.includes(v as T)) throw new CanvasError(`"${key}" must be one of: ${allowed.join(", ")}`);
  return v as T;
}
function strings(props: Props, key: string, maxItems: number, maxLen: number): string[] {
  const v = props[key];
  if (!Array.isArray(v) || v.length === 0) throw new CanvasError(`the part needs "${key}": a list of texts`);
  if (v.length > maxItems) throw new CanvasError(`"${key}" is limited to ${maxItems} entries`);
  return v.map((x) => {
    if (typeof x !== "string" && typeof x !== "number") throw new CanvasError(`"${key}" must hold texts`);
    return String(x).slice(0, maxLen);
  });
}
/** Values go into the thing as data, never as markup or code. */
const embed = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    // The two line separators that end a script line even inside a string.
    .split(String.fromCharCode(0x2028)).join(" ")
    .split(String.fromCharCode(0x2029)).join(" ");

/** Turns a machine reading into a share (0 to 1) and a label, inside a thing. */
const READING = `
  function reading(feed, m) {
    if (feed === "cpu") return { share: m.cpu_pct / 100, text: m.cpu_pct + " %" };
    if (feed === "memory") return { share: m.mem_used_kb / m.mem_total_kb, text: (m.mem_used_kb / 1048576).toFixed(1) + " GB" };
    if (feed === "disk") return { share: 1 - m.disk_free_pct / 100, text: Math.round(100 - m.disk_free_pct) + " % used" };
    return { share: Math.min(1, (m.net_kbps || 0) / 1024), text: (m.net_kbps || 0) + " kB/s" };
  }`;

export const KIT: Record<string, Part> = {
  text: {
    about: 'text { text, size?: "small" | "normal" | "large" }: a few lines of plain text',
    build(p) {
      const P = { text: str(p, "text", 2000, true), size: oneOf(p, "size", ["small", "normal", "large"] as const, "normal") };
      return `<p id="t"></p>
<style>
  body { display: grid; place-items: center; padding: 14px; }
  p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; text-align: center; color: var(--text); }
  p.small { font-size: 12px; } p.large { font-size: 22px; color: var(--fg); }
</style>
<script>
  const P = ${embed(P)};
  const t = document.getElementById("t");
  t.textContent = P.text; t.className = P.size;
  woody.ready();
</script>`;
    },
  },

  note: {
    about: "note { title, body }: a titled note",
    build(p) {
      const P = { title: str(p, "title", 80, true), body: str(p, "body", 4000, true) };
      return `<h1 id="h"></h1><p id="b"></p>
<style>
  body { padding: 14px 16px; overflow: auto; }
  h1 { margin: 0 0 8px; font-size: 14px; letter-spacing: .1em; text-transform: uppercase; }
  p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text); }
</style>
<script>
  const P = ${embed(P)};
  document.getElementById("h").textContent = P.title;
  document.getElementById("b").textContent = P.body;
  woody.ready();
</script>`;
    },
  },

  list: {
    about: "list { title?, items: text[], checkable?: boolean }: a list; when checkable, ticks are saved",
    build(p) {
      const P = { title: str(p, "title", 80), items: strings(p, "items", 50, 200), checkable: p.checkable === true };
      return `<h1 id="h"></h1><ul id="l"></ul>
<style>
  body { padding: 12px 14px; overflow: auto; }
  h1 { margin: 0 0 8px; font-size: 14px; letter-spacing: .1em; text-transform: uppercase; }
  h1:empty { display: none; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; color: var(--text); }
  li.can { cursor: pointer; } li.done { color: var(--dim); text-decoration: line-through; }
</style>
<script>
  const P = ${embed(P)};
  let done = [];
  document.getElementById("h").textContent = P.title;
  const ul = document.getElementById("l");
  function draw() {
    ul.replaceChildren(...P.items.map((text, i) => {
      const li = document.createElement("li");
      const ticked = done.includes(i);
      li.textContent = (P.checkable ? (ticked ? "[x] " : "[ ] ") : "· ") + text;
      li.className = (P.checkable ? "can " : "") + (ticked ? "done" : "");
      if (P.checkable) li.onclick = () => { done = ticked ? done.filter((d) => d !== i) : [...done, i]; woody.state.set({ done }); draw(); };
      return li;
    }));
  }
  woody.state.get().then((s) => { done = (s && Array.isArray(s.done)) ? s.done : []; draw(); woody.ready(); });
</script>`;
    },
  },

  table: {
    about: "table { columns: text[], rows: text[][] }: a small table",
    build(p) {
      const columns = strings(p, "columns", 12, 60);
      if (!Array.isArray(p.rows) || p.rows.length > 200) throw new CanvasError('the part needs "rows": up to 200 rows, each a list of texts');
      const rows = p.rows.map((r) => {
        if (!Array.isArray(r)) throw new CanvasError('each entry of "rows" is a list of texts');
        return r.slice(0, columns.length).map((c) => String(c ?? "").slice(0, 300));
      });
      return `<table><thead><tr id="h"></tr></thead><tbody id="b"></tbody></table>
<style>
  body { padding: 10px 12px; overflow: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th { text-align: left; color: var(--dim); font-weight: 400; letter-spacing: .08em; text-transform: uppercase; font-size: 11px; }
  th, td { padding: 4px 10px 4px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
  td { color: var(--text); overflow-wrap: anywhere; }
</style>
<script>
  const P = ${embed({ columns, rows })};
  const cell = (tag, text) => { const e = document.createElement(tag); e.textContent = text; return e; };
  document.getElementById("h").append(...P.columns.map((c) => cell("th", c)));
  document.getElementById("b").append(...P.rows.map((r) => { const tr = document.createElement("tr"); tr.append(...P.columns.map((_, i) => cell("td", r[i] ?? ""))); return tr; }));
  woody.ready();
</script>`;
    },
  },

  chart: {
    about: 'chart { feed: "cpu" | "memory" | "disk" | "network", title? }: a live line of that reading, from when it was opened',
    build(p) {
      const P = { feed: oneOf(p, "feed", FEEDS, "cpu"), title: str(p, "title", 80) };
      return `<div id="h"></div><svg id="s" preserveAspectRatio="none" viewBox="0 0 300 100"><polyline id="l" fill="none" stroke="var(--fg)" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg><div id="v"></div>
<style>
  body { display: grid; grid-template-rows: auto 1fr auto; padding: 10px 12px; gap: 6px; }
  #h { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--dim); }
  svg { width: 100%; height: 100%; min-height: 0; border-bottom: 1px solid var(--line); border-left: 1px solid var(--line); }
  #v { text-align: right; color: var(--text); }
</style>
<script>
  const P = ${embed(P)};${READING}
  const samples = [];
  document.getElementById("h").textContent = P.title || P.feed;
  woody.subscribe("meters", (m) => {
    const r = reading(P.feed, m);
    samples.push(Math.max(0, Math.min(1, r.share || 0)));
    if (samples.length > 300) samples.shift();
    const step = 300 / Math.max(1, samples.length - 1);
    document.getElementById("l").setAttribute("points", samples.map((s, i) => (i * step).toFixed(1) + "," + (100 - s * 96 - 2).toFixed(1)).join(" "));
    document.getElementById("v").textContent = r.text;
  });
  woody.ready();
</script>`;
    },
  },

  clock: {
    about: 'clock { timezone?: an IANA name such as "Asia/Tokyo", seconds?: boolean, style?: "digital" | "analog", label? }: the time, here or elsewhere',
    build(p) {
      const P = { timezone: str(p, "timezone", 60), seconds: p.seconds !== false, style: oneOf(p, "style", ["digital", "analog"] as const, "digital"), label: str(p, "label", 60) };
      if (P.timezone) {
        try {
          new Intl.DateTimeFormat("en", { timeZone: P.timezone });
        } catch {
          throw new CanvasError(`"${P.timezone}" is not a time zone name (use one like Europe/Paris)`);
        }
      }
      return `<div id="d"><div id="t"></div><svg id="a" viewBox="-110 -110 220 220"><circle r="100" fill="none" stroke="var(--line)" stroke-width="2"/><g id="k"></g>
<line id="hh" y2="-52" stroke="var(--fg)" stroke-width="6"/><line id="mm" y2="-78" stroke="var(--fg)" stroke-width="4"/><line id="ss" y2="-88" stroke="var(--red)" stroke-width="2"/><circle r="5" fill="var(--fg)"/></svg><div id="l"></div></div>
<style>
  body { display: grid; place-items: center; }
  #d { display: grid; justify-items: center; gap: 4px; width: 100%; height: 100%; align-content: center; }
  #t { font-size: 17vw; letter-spacing: .04em; } #l { color: var(--dim); font-size: 12px; letter-spacing: .1em; text-transform: uppercase; }
  svg { width: 100%; height: 78vh; }
</style>
<script>
  const P = ${embed(P)};
  const analog = P.style === "analog";
  document.getElementById(analog ? "t" : "a").remove();
  document.getElementById("l").textContent = P.label || (P.timezone ? P.timezone.split("/").pop().replace(/_/g, " ") : "");
  if (analog) {
    for (let i = 0; i < 12; i++) {
      const m = document.createElementNS("http://www.w3.org/2000/svg", "line");
      m.setAttribute("y1", -100); m.setAttribute("y2", -90); m.setAttribute("stroke", "var(--dim)"); m.setAttribute("stroke-width", 3); m.setAttribute("transform", "rotate(" + i * 30 + ")");
      document.getElementById("k").append(m);
    }
    if (!P.seconds) document.getElementById("ss").remove();
  }
  const parts = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZone: P.timezone || undefined });
  function tick() {
    const [h, m, s] = parts.format(new Date()).split(":").map(Number);
    if (analog) {
      document.getElementById("hh").setAttribute("transform", "rotate(" + ((h % 12) + m / 60) * 30 + ")");
      document.getElementById("mm").setAttribute("transform", "rotate(" + (m + s / 60) * 6 + ")");
      if (P.seconds) document.getElementById("ss").setAttribute("transform", "rotate(" + s * 6 + ")");
    } else {
      const two = (n) => String(n).padStart(2, "0");
      document.getElementById("t").textContent = two(h) + ":" + two(m) + (P.seconds ? ":" + two(s) : "");
    }
  }
  tick(); setInterval(tick, 1000); woody.ready();
</script>`;
    },
  },

  meter: {
    about: 'meter { feed: "cpu" | "memory" | "disk" | "network", label? }: one live reading as a bar',
    build(p) {
      const P = { feed: oneOf(p, "feed", FEEDS, "cpu"), label: str(p, "label", 60) };
      return `<div id="n"></div><div id="b"><i id="f"></i></div><div id="v">–</div>
<style>
  body { display: grid; align-content: center; gap: 8px; padding: 14px 16px; }
  #n { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--dim); }
  #b { height: 16px; background: var(--line); } #f { display: block; height: 100%; width: 0; background: var(--fg); }
  #b.high #f { background: var(--red); }
  #v { font-size: 22px; color: var(--text); }
</style>
<script>
  const P = ${embed(P)};${READING}
  document.getElementById("n").textContent = P.label || P.feed;
  woody.subscribe("meters", (m) => {
    const r = reading(P.feed, m);
    document.getElementById("f").style.width = Math.round(Math.max(0, Math.min(1, r.share || 0)) * 100) + "%";
    document.getElementById("b").className = r.share > 0.9 && P.feed !== "network" ? "high" : "";
    document.getElementById("v").textContent = r.text;
  });
  woody.ready();
</script>`;
    },
  },

  picture: {
    about: "picture { svg: the markup of one <svg> element, caption? }: a drawing",
    build(p) {
      const svg = str(p, "svg", 120_000, true).trim();
      if (!/^<svg[\s>]/i.test(svg) || !/<\/svg>\s*$/i.test(svg)) throw new CanvasError('"svg" must be the markup of one <svg> element');
      const P = { caption: str(p, "caption", 200) };
      return `<figure>${svg}<figcaption id="c"></figcaption></figure>
<style>
  body { display: grid; }
  figure { margin: 0; display: grid; grid-template-rows: minmax(0, 1fr) auto; height: 100%; padding: 8px; gap: 6px; }
  figure > svg { width: 100%; height: 100%; min-height: 0; }
  figcaption { text-align: center; color: var(--dim); font-size: 12px; }
  figcaption:empty { display: none; }
</style>
<script>
  document.getElementById("c").textContent = ${embed(P)}.caption;
  woody.ready();
</script>`;
    },
  },

  buttons: {
    about: "buttons { title?, buttons: [{ label, event }] }: buttons that tell you which was pressed (you are woken with the event name)",
    build(p) {
      if (!Array.isArray(p.buttons) || p.buttons.length === 0 || p.buttons.length > 8) throw new CanvasError('the part needs "buttons": one to eight of { label, event }');
      const buttons = p.buttons.map((b) => {
        const o = (b ?? {}) as Props;
        const event = str(o, "event", 40, true);
        if (!/^[\w .:-]+$/.test(event)) throw new CanvasError('"event" is a short name: letters, digits, spaces, and . : - _');
        return { label: str(o, "label", 40, true), event };
      });
      const P = { title: str(p, "title", 80), buttons };
      return `<h1 id="h"></h1><div id="b"></div><p id="s"></p>
<style>
  body { display: grid; align-content: center; gap: 10px; padding: 14px 16px; }
  h1 { margin: 0; font-size: 14px; letter-spacing: .1em; text-transform: uppercase; } h1:empty { display: none; }
  #b { display: flex; flex-wrap: wrap; gap: 8px; }
  button { font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--fg); padding: 8px 14px; cursor: pointer; letter-spacing: .08em; text-transform: uppercase; font-size: 12px; }
  button:disabled { opacity: .4; }
  #s { margin: 0; min-height: 1.4em; color: var(--dim); font-size: 12px; }
</style>
<script>
  const P = ${embed(P)};
  document.getElementById("h").textContent = P.title;
  const said = document.getElementById("s");
  document.getElementById("b").append(...P.buttons.map((b) => {
    const e = document.createElement("button");
    e.textContent = b.label;
    e.onclick = () => {
      e.disabled = true;
      woody.emit(b.event, { label: b.label }).then(() => (said.textContent = "Woody was told."), (err) => (said.textContent = String(err.message || err))).finally(() => setTimeout(() => (e.disabled = false), 3000));
    };
    return e;
  }));
  woody.ready();
</script>`;
    },
  },

  input: {
    about: "input { label, event, placeholder?, button? }: a line the operator fills in; you are woken with the event name and the text",
    build(p) {
      const event = str(p, "event", 40, true);
      if (!/^[\w .:-]+$/.test(event)) throw new CanvasError('"event" is a short name: letters, digits, spaces, and . : - _');
      const P = { label: str(p, "label", 120, true), event, placeholder: str(p, "placeholder", 120), button: str(p, "button", 30) || "send" };
      // Not a <form>: forms do not submit inside the sealed frame.
      return `<section><label for="i" id="l"></label><div><input id="i" maxlength="1000" autocomplete="off"><button id="b" type="button"></button></div><p id="s"></p></section>
<style>
  body { display: grid; align-content: center; padding: 14px 16px; }
  section { display: grid; gap: 8px; } label { color: var(--dim); font-size: 12px; }
  div { display: flex; gap: 8px; }
  input { flex: 1; min-width: 0; font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--line); padding: 8px 10px; }
  input:focus { outline: 1px solid var(--fg); }
  button { font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--fg); padding: 0 14px; cursor: pointer; text-transform: uppercase; font-size: 12px; letter-spacing: .08em; }
  p { margin: 0; min-height: 1.4em; color: var(--dim); font-size: 12px; }
</style>
<script>
  const P = ${embed(P)};
  const input = document.getElementById("i"), said = document.getElementById("s");
  document.getElementById("l").textContent = P.label;
  document.getElementById("b").textContent = P.button;
  input.placeholder = P.placeholder;
  function send() {
    const text = input.value.trim();
    if (!text) return;
    woody.emit(P.event, { text }).then(() => { input.value = ""; said.textContent = "Woody was told."; }, (err) => (said.textContent = String(err.message || err)));
  }
  document.getElementById("b").onclick = send;
  input.onkeydown = (e) => { if (e.key === "Enter") send(); };
  woody.ready();
</script>`;
    },
  },
};

/** Values that make every part build: used by the tests and by the scripted browser check. */
export const KIT_SAMPLES: Record<string, Props> = {
  text: { text: "Hello from the kit.", size: "large" },
  note: { title: "A note", body: "Two lines.\nThe second one." },
  list: { title: "To read", items: ["chapter 3", "the manual"], checkable: true },
  table: { columns: ["what", "size"], rows: [["store", "41 GB"], ["snapshots", "18 GB"]] },
  chart: { feed: "cpu", title: "processor" },
  clock: { timezone: "Asia/Tokyo", seconds: true, style: "analog" },
  meter: { feed: "memory", label: "memory" },
  picture: { svg: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#ffb000"/></svg>', caption: "a dot" },
  buttons: { title: "Again?", buttons: [{ label: "another", event: "another" }, { label: "enough", event: "enough" }] },
  input: { label: "A word for today", event: "word", placeholder: "one word" },
};

/** The source of a thing made from a kit part. */
export function buildPart(part: unknown, props: unknown): string {
  const known = typeof part === "string" ? KIT[part] : undefined;
  if (!known) throw new CanvasError(`there is no kit part "${String(part)}". The parts are: ${Object.keys(KIT).join(", ")}`);
  if (!props || typeof props !== "object" || Array.isArray(props)) throw new CanvasError('"props" must be the part\'s values');
  return known.build(props as Props);
}

/** What the kit holds, one line per part. */
export const kitCatalogue = (): string[] => Object.values(KIT).map((p) => p.about);
