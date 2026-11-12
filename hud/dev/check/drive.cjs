// Drives the real gateway and the VM's Chromium like an operator would, and
// checks what the canvas promises: things appear and start, the operator can
// move, resize, pin, close and undo, Woody cannot touch a pinned thing, a
// hostile thing stays sealed, and everything survives a restart.
// Run by run.sh, inside the Nix container (see run.sh).
const { execFile, spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");
const WebSocket = require("/work/hud/node_modules/ws");

const [NODE, CHROMIUM] = process.argv.slice(2);
const HUD = "/work/hud";
const STATE = "/tmp/hud-state";
const RUN = "/tmp/hud-run";
const OUT = "/out/canvas";
const AGENT_SOCK = "/tmp/check-agent.sock";
const EXEC_SOCK = "/tmp/check-exec.sock";
const env = { ...process.env, WOODY_HUD_STATE_DIR: STATE, WOODY_HUD_RUNTIME_DIR: RUN, WOODY_HUD_PORT: "7800", WOODY_AGENT_SOCKET: AGENT_SOCK, WOODY_APPROVE_SOCKET: EXEC_SOCK };
const net = require("net");

// ---- a stand-in for the executor's approval socket: it only knows Pause ----
let paused = false;
fs.rmSync(EXEC_SOCK, { force: true });
net.createServer((socket) => {
  socket.setEncoding("utf8");
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    for (const line of chunk.split("\n").filter(Boolean)) {
      const m = JSON.parse(line);
      socket.write(JSON.stringify(m.op === "status" ? { status: "ok", result: { paused } } : { status: "ok", result: [] }) + "\n");
    }
  });
}).listen(EXEC_SOCK);

// ---- a stand-in for the agent: it plays Woody on the gateway's canvas link ----
let linkSocket = null;
let linkSeq = 0;
const linkWaiting = new Map();
const thingEvents = [];
const canvasEvents = [];
// Since Phase 8c it also plays the agent towards the frame: it reports a state,
// answers for Woody's face and identity, and keeps what the operator asked of it.
const browsers = new Set();
const mindCalls = [];
let agentState = null;
let faceAnswer = null;
let identityAnswer = null;
let studiesAnswer = null;
let methodsAnswer = null;
const agentSay = (msg) => { for (const b of browsers) if (b.readyState === 1) b.send(JSON.stringify(msg)); };
fs.rmSync(AGENT_SOCK, { force: true });
const agentHttp = http.createServer();
new WebSocket.Server({ server: agentHttp }).on("connection", (ws) => {
  browsers.add(ws);
  if (agentState) ws.send(JSON.stringify(agentState));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "mind" && (m.op === "face" || m.op === "face_restore" || String(m.op).startsWith("identity") || String(m.op).startsWith("stud") || String(m.op).startsWith("method"))) {
      mindCalls.push(m);
      const result = String(m.op).startsWith("method") ? methodsAnswer : String(m.op).startsWith("stud") ? studiesAnswer : String(m.op).startsWith("face") ? faceAnswer : identityAnswer;
      if (!result) return;
      if (m.op === "identity_seen") {
        identityAnswer.state.unseen = [];
        agentState = { ...agentState, identity: { ...agentState.identity, unseen: [] } };
        agentSay(agentState);
      }
      ws.send(JSON.stringify({ type: "mind_result", op: m.op, ok: true, result }));
      return;
    }
    if (m.type === "canvas_link") { linkSocket = ws; browsers.delete(ws); }
    else if (m.type === "canvas_reply") { linkWaiting.get(m.rid)?.(m); linkWaiting.delete(m.rid); }
    else if (m.type === "thing_event") thingEvents.push(m);
    else if (m.type === "canvas_event") canvasEvents.push(m.change);
  });
  ws.on("close", () => { browsers.delete(ws); if (linkSocket === ws) linkSocket = null; });
});
agentHttp.listen(AGENT_SOCK);
/** One request as Woody. Resolves to { ok, result | error }. */
const woody = (op, params = {}) => new Promise((resolve) => {
  if (!linkSocket) return resolve({ ok: false, error: "no link" });
  const rid = `w${++linkSeq}`;
  linkWaiting.set(rid, resolve);
  linkSocket.send(JSON.stringify({ type: "canvas_request", rid, op, ...params }));
});
fs.rmSync(STATE, { recursive: true, force: true });
fs.rmSync(OUT, { recursive: true, force: true });
for (const d of [STATE, RUN, OUT]) fs.mkdirSync(d, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` · ${detail}` : ""}`);
}
/** The operator's command line. Resolves to { ok, out }. It must not block: the stand-ins below answer the gateway from this process. */
function cli(...args) {
  return new Promise((resolve) => {
    execFile(NODE, [`${HUD}/dist/server/gateway.js`, "canvas", ...args], { env, encoding: "utf8" }, (err, stdout, stderr) => {
      resolve(err ? { ok: false, out: String(stderr || stdout || err.message) } : { ok: true, out: stdout });
    });
  });
}
const things = async () => JSON.parse((await cli("list")).out);
const get = (url) => new Promise((resolve, reject) => http.get(url, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b })); }).on("error", reject));

let gateway;
function startGateway() {
  gateway = spawn(NODE, [`${HUD}/dist/server/gateway.js`], { env, stdio: ["ignore", "ignore", "inherit"] });
}

(async () => {
  startGateway();
  const sink = spawn(NODE, ["/work/spikes/phase7/serve.mjs", "--port", "7811", "--out", "/tmp/sink"], { stdio: "ignore" });
  await sleep(1200);
  const token = fs.readFileSync(`${STATE}/token`, "utf8").trim();

  // ---- things made as Woody would make them ----
  const T = "/work/spikes/phase7/canvas/things";
  check("make a thing", (await cli("make", "Backwards clock", `${T}/backclock.html`, "--why", "you asked for a clock that runs backwards")).ok);
  await cli("make", "Reading list", `${T}/list.html`, "--why", "to keep track of what you read");
  await cli("make", "The machine", `${T}/meters.html`);
  await cli("make", "Tomorrow on Mars", `${T}/note.html`, "--pretend", "--for", "woody", "--why", "playing");
  fs.writeFileSync("/tmp/broken.html", "<p>half made</p><script>throw new Error('oops, never ready')</script>");
  await cli("make", "Broken", "/tmp/broken.html", "--as", "you");
  await cli("make", "Probe", `${HUD}/dev/probe.html`, "--at", "1150,520,330,200");
  check("six things in the store", (await things()).length === 6);

  // ---- how a thing is served ----
  const frameHeaders = (await get("http://127.0.0.1:7800/")).headers["content-security-policy"] || "";
  check("the frame page only allows frames for things and the terminal", /frame-src http:\/\/127\.0\.0\.1:7800\/thing\/ http:\/\/127\.0\.0\.1:7800\/term\//.test(frameHeaders), frameHeaders.match(/frame-src[^;]*/)?.[0]);
  check("a thing cannot be fetched by a guessed name", (await get(`http://127.0.0.1:7800/thing/${"0".repeat(32)}`)).status === 404);
  check("a thing cannot be fetched by its id", (await get("http://127.0.0.1:7800/thing/t1")).status === 404);

  // ---- the browser ----
  const chrome = spawn(CHROMIUM, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--user-data-dir=/tmp/drive-profile",
    "--remote-debugging-port=9222", "--window-size=1600,900", "--webrtc-ip-handling-policy=disable_non_proxied_udp", "about:blank"], { stdio: "ignore" });
  let target;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(500);
    try {
      target = JSON.parse((await get("http://127.0.0.1:9222/json")).body).find((t) => t.type === "page");
    } catch { /* not up yet */ }
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.on("open", r));
  let seq = 0;
  const waiting = new Map();
  ws.on("message", (raw) => { const m = JSON.parse(raw); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
  const cdp = (method, params = {}, sessionId) => new Promise((resolve) => { const id = ++seq; waiting.set(id, resolve); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  /** Runs an expression inside one thing's own (sandboxed, separate) document. */
  const inThing = async (thingId, expression) => {
    const src = await js(`document.querySelector('[data-thing="${thingId}"] iframe').src`);
    const targets = (await cdp("Target.getTargets")).result.targetInfos;
    const t = targets.find((x) => x.url === src);
    if (!t) return { error: `no target for ${src}; iframe targets: ${targets.filter((x) => x.type === "iframe").length}` };
    const { sessionId } = (await cdp("Target.attachToTarget", { targetId: t.targetId, flatten: true })).result;
    const r = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    await cdp("Target.detachFromTarget", { sessionId });
    return { value: r.result?.result?.value, error: r.result?.exceptionDetails ? JSON.stringify(r.result.exceptionDetails).slice(0, 200) : undefined };
  };
  const js = async (expression) => { const r = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result?.result?.value; };
  const shot = async (name) => fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from((await cdp("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
  const mouse = (type, x, y, extra = {}) => cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, ...extra });
  const hover = (x, y) => cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  const click = async (x, y) => { await hover(x, y); await mouse("mousePressed", x, y); await mouse("mouseReleased", x, y); };
  const rect = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const until = async (expr, ms = 12000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js(expr)) return true; await sleep(250); } return false; };

  await cdp("Page.enable");
  await cdp("Page.navigate", { url: `http://127.0.0.1:7800/#t=${token}` });
  check("the things appear", await until(`document.querySelectorAll(".thing").length === 6`));
  check("five things start and say so", await until(`document.querySelectorAll(".thing.ready").length === 5`), `ready: ${await js(`[...document.querySelectorAll(".thing.ready")].map(e => e.dataset.thing).join(",")`)}`);
  check("the broken thing is not shown", await until(`document.querySelector('[data-thing="t5"]').classList.contains("failed")`, 12000), await js(`document.querySelector('[data-thing="t5"] .thing-cover')?.textContent`));
  check("a hidden frame for the broken thing", (await js(`getComputedStyle(document.querySelector('[data-thing="t5"] iframe')).visibility`)) === "hidden");
  check("the pretend thing carries the frame's mark", (await js(`document.querySelector('[data-thing="t4"] .thing-mark')?.textContent`)) === "pretend");
  check("every thing's frame is sandboxed without an origin", await js(`[...document.querySelectorAll(".thing iframe")].every(f => f.getAttribute("sandbox") === "allow-scripts")`));
  await sleep(2500); // let the meters arrive
  await shot("1-things");

  // ---- the operator moves, resizes, pins, closes ----
  const t1 = await rect('[data-thing="t1"]');
  check("the band is thin until the pointer is on it", (await js(`document.querySelector('[data-thing="t1"] .thing-strip').getBoundingClientRect().height`)) === 6);
  await hover(t1.x + 60, t1.y + 4);
  await sleep(200);
  check("the band opens into the strip when the pointer is on it", (await js(`document.querySelector('[data-thing="t1"] .thing-strip').getBoundingClientRect().height`)) === 26);
  await shot("2-strip");
  await mouse("mousePressed", t1.x + 60, t1.y + 4);
  for (let i = 1; i <= 8; i++) await mouse("mouseMoved", t1.x + 60 + i * 30, t1.y + 4 + i * 50);
  await mouse("mouseReleased", t1.x + 300, t1.y + 404);
  await sleep(400);
  const moved = (await things()).find((t) => t.id === "t1").box;
  check("dragging the strip moves the thing, and the gateway keeps it", moved.x === Math.round(t1.x) + 240 && moved.y === Math.round(t1.y) + 400, JSON.stringify(moved));
  const g = await rect('[data-thing="t1"]');
  await hover(g.x + g.w - 6, g.y + g.h - 6);
  await mouse("mousePressed", g.x + g.w - 6, g.y + g.h - 6);
  for (let i = 1; i <= 5; i++) await mouse("mouseMoved", g.x + g.w - 6 + i * 20, g.y + g.h - 6 + i * 10);
  await mouse("mouseReleased", g.x + g.w + 94, g.y + g.h + 44);
  await sleep(400);
  const sized = (await things()).find((t) => t.id === "t1").box;
  check("dragging the corner resizes it", sized.w === moved.w + 100 && sized.h === moved.h + 50, JSON.stringify(sized));

  // pin t1 from its strip, then try to touch it as Woody
  const p = await rect('[data-thing="t1"]');
  await hover(p.x + 60, p.y + 4);
  await sleep(150);
  const pinBtn = await rect('[data-thing="t1"] .thing-strip button');
  await click(pinBtn.x + pinBtn.w / 2, pinBtn.y + pinBtn.h / 2);
  await sleep(400);
  check("the pin button pins", (await things()).find((t) => t.id === "t1").pinned === true);
  const refusals = [await cli("place", "t1", "20", "20"), await cli("change", "t1", `${T}/clock.html`), await cli("remove", "t1"), await cli("pin", "t1", "off", "--as", "woody")];
  // (the last one is sent as the operator by the command line's own rule, so it is expected to work)
  check("Woody cannot move, change or remove a pinned thing", !refusals[0].ok && !refusals[1].ok && !refusals[2].ok, refusals[0].out.trim());
  const after = (await things()).find((t) => t.id === "t1");
  check("the pinned thing is exactly as it was", after.box.x === sized.x && after.version === 1 && !after.removed);
  await cli("pin", "t1"); // pinned again for the rest of the run
  const hist = JSON.parse((await cli("history", "30")).out);
  check("the refused attempts are in the record", hist.filter((c) => c.refused && c.by === "woody").length === 3, hist.filter((c) => c.refused).map((c) => c.text).join(" | "));

  // Woody changes an unpinned thing: the frame reloads it at the new version
  check("Woody may change an unpinned thing", (await cli("change", "t3", `${T}/clock.html`, "--why", "a clock is more useful here", "--title", "A clock")).ok);
  check("the frame shows the new version", await until(`document.querySelector('[data-thing="t3"] iframe')?.src.endsWith("v=2") && document.querySelector('[data-thing="t3"]').classList.contains("ready")`));

  // close t4 with its ×, then undo from the lattice menu
  const c4 = await rect('[data-thing="t4"]');
  await hover(c4.x + 60, c4.y + 4);
  await sleep(150);
  const closeBtn = await js(`(() => { const b = [...document.querySelectorAll('[data-thing="t4"] .thing-strip button')].pop().getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  await click(closeBtn.x, closeBtn.y);
  check("× takes a thing off the canvas", await until(`!document.querySelector('[data-thing="t4"]')`) && (await things()).find((t) => t.id === "t4").removed);
  await js(`document.querySelector(".lattice-button").click()`);
  await sleep(300);
  await shot("3-menu");
  const undoText = await js(`document.querySelector(".menu .undo")?.textContent`);
  await js(`document.querySelector(".menu .undo").click()`);
  check("undo in the lattice menu brings it back", await until(`!!document.querySelector('[data-thing="t4"]')`) && !(await things()).find((t) => t.id === "t4").removed, undoText);

  // ---- a thing's saved state goes through the bridge and survives a reload ----
  const readState = () => { try { return JSON.parse(fs.readFileSync(`${STATE}/canvas/things/t2/state.json`, "utf8")); } catch { return null; } };
  const l = await rect('[data-thing="t2"]');
  await click(l.x + 60, l.y + 6 + 24); // the first line of the list, inside the sandboxed frame
  await sleep(600);
  console.log(`note a pointer click at a thing's position ${readState() ? "reached it" : "did not reach it here (the scripted pointer does not enter separate-process frames in this headless run)"}`);
  if (!readState()) {
    const r = await inThing("t2", `document.querySelector("li").click(); document.querySelector("li").className`);
    check("a thing's own document is its own separate page", r.value === "done", JSON.stringify(r));
    await sleep(600);
  }
  const saved = readState();
  check("what a thing saves goes through the bridge to the gateway", Array.isArray(saved?.done) && saved.done.length === 1, JSON.stringify(saved));
  await cdp("Page.reload");
  await until(`document.querySelectorAll(".thing.ready").length >= 4`, 15000);
  const back = await inThing("t2", `document.querySelector("li").className`);
  check("after a reload the thing gets its saved state back", back.value === "done", JSON.stringify(back));

  // ---- isolation, under the real gateway ----
  await sleep(9000);
  let probe = null;
  try { probe = JSON.parse(fs.readFileSync(`${STATE}/canvas/things/t6/state.json`, "utf8")).probe; } catch { /* no report */ }
  const leaks = JSON.parse((await get("http://127.0.0.1:7811/leaks")).body).map((x) => x.via);
  const bad = (probe || []).filter((x) => x.outcome !== "blocked" && x.outcome !== "ok");
  check("the hostile thing reported", Array.isArray(probe) && probe.length >= 15, `${probe?.length} attempts`);
  check("every way out it tried was blocked", probe && bad.length === 0, bad.map((b) => `${b.name}: ${b.detail}`).join(" | "));
  check("nothing reached the listener", leaks.length === 0, leaks.join(","));
  check("a thing that tried to leave its frame is covered", await js(`document.querySelector('[data-thing="t6"]').classList.contains("failed")`), await js(`document.querySelector('[data-thing="t6"] .thing-cover')?.textContent`));
  check("the frame page is still there after the thing tried to leave", (await js(`location.href`)).startsWith("http://127.0.0.1:7800/") && (await js(`!!document.querySelector(".lattice-button")`)));
  check("the hostile thing could not write another thing's state", !fs.existsSync(`${STATE}/canvas/things/t1/state.json`));
  for (const x of probe || []) console.log(`     ${x.outcome.padEnd(8)} ${x.name}${x.detail ? ` · ${x.detail}` : ""}`);

  // ---- the records ----
  await js(`document.querySelector(".menu-backdrop")?.click()`);
  await js(`document.querySelector(".lattice-button").click()`);
  await sleep(200);
  await js(`[...document.querySelectorAll(".menu-list button")].find(b => b.textContent.includes("THINGS")).click()`);
  await sleep(300);
  await js(`[...document.querySelectorAll(".things-record .entry")].find(b => b.textContent.includes("A clock")).click()`);
  check("the things record shows a thing's source and versions", await until(`document.querySelector(".things-record pre")?.textContent.includes("toTimeString") && document.querySelectorAll(".things-record .record.inline").length === 2`));
  await shot("4-things-record");
  await js(`document.querySelector(".lattice-button").click()`);
  await sleep(200);
  await js(`[...document.querySelectorAll(".menu-list button")].find(b => b.textContent.includes("CHANGES")).click()`);
  check("the changes record lists the changes and the refusals", await until(`document.querySelectorAll(".change").length >= 12 && document.querySelectorAll(".change.refused").length === 3`));
  await shot("5-changes-record");
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });

  // ---- Woody's side: the link, the kit, the trial on the screen, Pause, events ----
  check("the gateway opened its canvas link to the agent", linkSocket !== null);
  const look = await woody("look");
  check("Woody can look: the things, the screen, the kit", look.ok && look.result.things.length >= 5 && look.result.kit.length === 10 && look.result.screen.w === 1600, look.ok ? `${look.result.things.length} things, kit of ${look.result.kit.length}, screen ${look.result.screen.w}x${look.result.screen.h}` : look.error);
  check("it sees which things run and which do not", look.ok && /^no/.test(look.result.things.find((t) => t.id === "t5")?.running) && look.result.things.find((t) => t.id === "t2")?.running === "yes", look.ok ? look.result.things.map((t) => `${t.id}=${t.running.slice(0, 12)}`).join(" ") : "");

  const { KIT_SAMPLES } = await import("/work/hud/dist/server/kit.js");
  const kitIds = {};
  for (const [part, props] of Object.entries(KIT_SAMPLES)) {
    const r = await woody("kit", { part, props, title: `kit ${part}`, why: "the scripted check" });
    kitIds[part] = r.ok ? r.result.thing.id : null;
    check(`kit part "${part}" starts on the screen`, r.ok && r.result.tried === true && r.result.started === true, r.ok ? `${r.result.start_ms} ms` : r.error);
  }
  await sleep(2500);
  await shot("7-kit");

  const countBefore = (await things()).filter((t) => !t.removed).length;
  const notStarting = await woody("make", { title: "Does not start", source: "<p>x</p><script>undefinedFunction()</script>", why: "the scripted check" });
  check("a thing of Woody's that does not start is refused with the reason", !notStarting.ok && /did not start/.test(notStarting.error) && /undefinedFunction/.test(notStarting.error), notStarting.error);
  check("and the canvas is as it was", (await things()).filter((t) => !t.removed).length === countBefore);
  const badChange = await woody("change", { id: kitIds.text, source: "<script>nope()</script>", why: "the scripted check" });
  const textThing = (await things()).find((t) => t.id === kitIds.text);
  check("a change that does not start is taken back to the version before", !badChange.ok && textThing.version === 1 && textThing.versions.length === 2, badChange.error);
  check("the frame shows the earlier version again", await until(`document.querySelector('[data-thing="${kitIds.text}"] iframe')?.src.endsWith("v=1") && document.querySelector('[data-thing="${kitIds.text}"]').classList.contains("ready")`));
  const goodChange = await woody("change", { id: kitIds.text, source: "<p id=p></p><script>p.textContent = 'changed'; woody.ready()</script>", why: "the scripted check" });
  check("a change that starts is kept", goodChange.ok && goodChange.result.started === true && goodChange.result.thing.version === 3, goodChange.ok ? "" : goodChange.error);

  check("Woody cannot pin or undo", !(await woody("pin", { id: kitIds.note, pinned: true })).ok && !(await woody("undo")).ok);
  const pinnedTry = await woody("change", { id: "t1", source: "<script>woody.ready()</script>" });
  check("Woody cannot change a pinned thing over the link either", !pinnedTry.ok && /pinned/.test(pinnedTry.error), pinnedTry.error);

  paused = true;
  const whilePaused = await woody("kit", { part: "text", props: { text: "while paused" }, title: "paused" });
  const lookPaused = await woody("look");
  check("while the operator has paused Woody, it cannot change the canvas", !whilePaused.ok && /paused-by-operator/.test(whilePaused.error), whilePaused.error);
  check("but it can still look", lookPaused.ok);
  paused = false;

  const pressed = await inThing(kitIds.buttons, `document.querySelector("button").click(); "clicked"`);
  await sleep(700);
  check("a button on a thing reaches Woody as an event from that thing", pressed.value === "clicked" && thingEvents.length === 1 && thingEvents[0].id === kitIds.buttons && thingEvents[0].name === "another", JSON.stringify(thingEvents[0] || pressed));
  await inThing(kitIds.input, `document.querySelector("input").value = "hello woody"; document.querySelector("input").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })); "sent"`);
  await sleep(700);
  check("a line typed into a thing reaches Woody with its text", thingEvents.length === 2 && thingEvents[1].name === "word" && thingEvents[1].data?.text === "hello woody", JSON.stringify(thingEvents[1]));
  await inThing(kitIds.buttons, `(async () => { for (let i = 0; i < 9; i++) { try { await woody.emit("flood", { i }); } catch (e) {} } return "done"; })()`);
  await sleep(500);
  check("a thing cannot flood Woody: six events a minute at most", thingEvents.filter((e) => e.id === kitIds.buttons).length === 6, `${thingEvents.filter((e) => e.id === kitIds.buttons).length} got through`);

  // ---- what Woody adds on its own: the note, the mark, the daily limit ----
  const TIDES = "<p id=p></p><script>p.textContent = 'tides'; woody.ready()</script>";
  const NOTE = "You mentioned sailing: here are today's tides.";
  const noNote = await woody("make", { title: "No note", source: TIDES, uninvited: true });
  check("a thing left for the operator unasked needs a note", !noNote.ok && /needs a note/.test(noNote.error), noNote.error);
  const left = await woody("make", { title: "Today's tides", source: TIDES, uninvited: true, note: NOTE, why: "from my interest in tides" });
  check("with a note it is made, tried on the screen and marked as put there on its own", left.ok && left.result.started === true && left.result.thing.uninvited === true, left.ok ? "" : left.error);
  const leftId = left.ok ? left.result.thing.id : "none";
  check("the frame shows Woody's note on it", await until(`document.querySelector('[data-thing="${leftId}"] .thing-note-text')?.textContent === ${JSON.stringify(NOTE)}`));
  check("the note sits below the thing and covers none of it", await js(`(() => { const t = document.querySelector('[data-thing="${leftId}"]'); return t.querySelector(".thing-note").getBoundingClientRect().top >= t.querySelector("iframe").getBoundingClientRect().bottom - 1; })()`));
  await shot("8-left-with-a-note");
  await js(`document.querySelector('[data-thing="${leftId}"] .thing-note button').click()`);
  check("once the operator has read it, the note is put away and stays in the thing's record", (await until(`!document.querySelector('[data-thing="${leftId}"] .thing-note')`)) && (await things()).find((t) => t.id === leftId)?.note_seen === true);
  const own2 = await woody("kit", { part: "text", props: KIT_SAMPLES.text, title: "own two", uninvited: true, for: "woody" });
  const own3 = await woody("kit", { part: "text", props: KIT_SAMPLES.text, title: "own three", uninvited: true, for: "woody" });
  const mayAdd = await woody("may_add", { for: "woody" });
  const own4 = await woody("kit", { part: "text", props: KIT_SAMPLES.text, title: "own four", uninvited: true, for: "woody" });
  check("three things added on its own in a day, and no more", own2.ok && own3.ok && !mayAdd.ok && !own4.ok && /limit the operator set/.test(own4.error), own4.ok ? "the fourth was made" : own4.error);
  check("what the operator asks for is not limited", (await woody("kit", { part: "text", props: KIT_SAMPLES.text, title: "asked for", why: "you asked" })).ok);
  const look2 = await woody("look");
  check("Woody sees how many it has added and the limit", look2.ok && look2.result.own_additions.today === 3 && look2.result.own_additions.limit === 3 && look2.result.things.find((t) => t.id === leftId)?.on_its_own === true, JSON.stringify(look2.result?.own_additions));
  check("Woody cannot raise its own limit", !(await woody("set_limit", { n: 20 })).ok && !(await cli("limit", "20")).ok);
  check("the operator can", (await cli("limit", "5", "--as", "you")).ok && (await woody("kit", { part: "text", props: KIT_SAMPLES.text, title: "own four", uninvited: true, for: "woody" })).ok);

  // ---- Woody is told what changes on the canvas, its own changes and the operator's ----
  const told = (test) => canvasEvents.some(test);
  check("Woody is told which of its changes were its own idea", told((c) => c.by === "woody" && c.op === "make" && c.uninvited === true && c.id === leftId) && told((c) => c.by === "woody" && c.op === "make" && c.uninvited === false));
  check("and where the operator moved a thing", told((c) => c.by === "you" && c.op === "place" && c.from && c.box && (c.from.x !== c.box.x || c.from.w !== c.box.w) && c.screen?.w === 1600));
  check("a refusal for the daily limit is part of the record", told((c) => c.by === "woody" && /today's limit/.test(c.refused || "")));
  check("Woody is told when the operator pins a thing it made", told((c) => c.by === "you" && c.op === "pin" && c.pinned === true && c.thing_by === "woody" && c.id === "t1"));
  check("and when the operator takes a thing off the canvas", told((c) => c.by === "you" && c.op === "remove" && c.title === "Tomorrow on Mars"));
  check("and when the operator undoes something", told((c) => c.by === "you" && c.op === "undo"));
  check("its own refused attempts are part of that record", told((c) => c.by === "woody" && c.refused === "pinned by the operator"));
  check("and so is a thing of its own that was taken back", told((c) => c.by === "woody" && c.op === "undo" && /did not start/.test(c.why)));
  check("each change is told once, in order", new Set(canvasEvents.map((c) => c.seq)).size === canvasEvents.length && canvasEvents.every((c, i) => i === 0 || c.seq > canvasEvents[i - 1].seq), `${canvasEvents.length} events`);

  // ---- Woody's face and its identity (Phase 8c) ----
  // The frame plays the designs Woody drew, checks each one itself, and never
  // lets Woody's data stand in for one of its own signals.
  const LIT = ["........", "........", "..9999..", "..9..9..", "..9..9..", "..9999..", "........", "........"];
  const DARK = Array.from({ length: 8 }, () => "........");
  const drawn = (colour, extra = {}) => ({ colour, fade: false, repeat: 1, frames: [{ rows: LIT, ms: 400 }, { rows: DARK, ms: 400 }], ...extra });
  const entry = (name, kind, design, builtin = true) => ({ name, kind, about: "for the check", builtin, looks: "as built in", design, version: 1, ts: Date.now(), reason: "for the check" });
  faceAnswer = {
    version: 1,
    history: {},
    designs: [
      entry("resting", "state", drawn("blue")),
      entry("shrug", "expression", drawn("green", { frames: [{ rows: LIT, ms: 1500 }] }), false),
      entry("paused", "state", drawn("green")), // one of the frame's signals, by name
      entry("problem", "moment", drawn("green")), // another
      entry("smile", "expression", drawn("red")), // red is the frame's
      entry("wink", "expression", { colour: "amber", frames: [{ rows: [...LIT.slice(0, 7), "<script>"], ms: 400 }] }), // not a picture
      entry("heart", "expression", drawn("blue", { frames: Array.from({ length: 40 }, () => ({ rows: LIT, ms: 400 })) })), // too many frames
    ],
  };
  const ID1 = "You are somewhat playful: observant, at ease, and fond of the small detail that gives the game away. You are also exact. You never bluff.";
  const ID3 = `${ID1} With this operator you give times in Paris time.`;
  identityAnswer = {
    current: { version: 3, text: ID3 },
    pending: [],
    history: [
      { version: 3, ts: Date.now() - 3_600_000, text: ID3, note: "changed by Woody after its reflection", author: "woody", reason: "They asked for Paris time three times this week.", seen: false },
      { version: 2, ts: Date.now() - 86_400_000, text: ID1, note: "written by the operator", author: "operator", reason: "", seen: true },
      { version: 1, ts: Date.now() - 9 * 86_400_000, text: ID1.replace(" You never bluff.", ""), note: "initial character", author: "initial", reason: "", seen: true },
    ],
    state: { version: 3, remaining: 0.9, paused: false, frozen: false, blocked: null, unseen: [3] },
  };
  identityAnswer.anchor = identityAnswer.history[2];
  agentState = {
    type: "state", model: "m", models: [], busy: false, has_credential: true,
    budget: { month: "2026-11", spent_usd: 1, cap_usd: 100, remaining_usd: 99, exhausted: false, daily_usd: 3.33, autonomous_usd: 3, own: { share_usd: 25, spent_usd: 0, available_usd: 1 } },
    mind: { identity_version: 3 },
    mind_state: { state: "resting", focus: "", since: Date.now(), mode: null, tainted: false, failed_units: [], paused: false, queue: { operator: 0, autonomous: 0 }, next_alarm: null, waiting_on_operator: 0 },
    face: 1,
    identity: { version: 3, unseen: [3], paused: false, remaining: 0.9 },
  };
  agentSay(agentState);
  const lat = (what) => js(`(() => { const l = document.querySelector(".lattice-button .lattice"); const lit = [...l.querySelectorAll("i")].find((i) => Number(getComputedStyle(i).opacity) > 0.5); return ${what}; })()`);
  const label = (name) => `document.querySelector(".lattice-button .lattice")?.getAttribute("aria-label") === "Woody: ${name}"`;
  check("the lattice shows the design Woody drew for resting", (await until(`document.querySelector(".lattice-button .lattice")?.dataset.own === "1"`)) && (await js(label("resting"))));
  check("in the colour Woody chose from its palette", (await js(`getComputedStyle(document.querySelector(".lattice-button .lattice i")).backgroundColor`)) === "rgb(127, 178, 245)");
  const flipped = await js(`(async () => { const seen = new Set(); for (let i = 0; i < 14; i++) { seen.add(getComputedStyle(document.querySelectorAll(".lattice-button .lattice i")[18]).opacity); await new Promise((r) => setTimeout(r, 90)); } return [...seen].sort().join(" "); })()`);
  check("its pictures follow one another", flipped === "0.1 1", flipped);
  agentSay({ type: "moment", name: "shrug" });
  check("an expression Woody invented plays when Woody shows it", (await until(label("shrug"), 3000)) && (await lat(`getComputedStyle(lit).backgroundColor`)) === "rgb(127, 207, 149)");
  check("and then the lattice goes back to its state", await until(label("resting"), 5000));
  agentSay({ type: "moment", name: "no-such-thing" });
  await sleep(500);
  check("a name the frame does not know plays nothing", await js(label("resting")));
  for (const [name, why] of [["smile", "in red"], ["wink", "that is not a picture"], ["heart", "with too many frames"]]) {
    agentSay({ type: "moment", name });
    check(`a design ${why} is ignored: the built-in "${name}" plays`, (await until(label(name), 3000)) && (await lat(`l.dataset.own === undefined`)));
    await until(label("resting"), 6000);
  }
  agentSay({ type: "moment", name: "problem" });
  check("a problem is the frame's to show, in red, whatever Woody drew under that name", (await until(label("problem"), 3000)) && (await lat(`l.dataset.own === undefined && getComputedStyle(lit).backgroundColor`)) === "rgb(255, 90, 77)");
  await until(label("resting"), 6000);
  paused = true;
  check("Pause is the frame's to show too", (await until(label("paused"), 15000)) && (await lat(`l.dataset.own === undefined && getComputedStyle(lit).backgroundColor`)) === "rgb(255, 90, 77)");
  paused = false;
  await until(label("resting"), 15000);

  check("the frame says by the lattice that Woody changed its identity", await until(`document.querySelector(".voice-note")?.textContent.includes("changed its identity")`));
  await shot("7-identity-notice");
  await js(`document.querySelector(".voice-note").click()`);
  check("the record shows the before, the after and the reason", (await until(`document.querySelector('.notice-box[data-change="3"] mark.diff-new')?.textContent.includes("Paris time")`)) && (await js(`document.querySelector(".notice-box").textContent.includes("three times this week") && document.querySelectorAll(".notice-box pre.diff").length === 2`)));
  check("opening it is looking: the notice goes, the change stays in the record", (await until(`!document.querySelector(".voice-note")`)) && mindCalls.some((m) => m.op === "identity_seen") && (await js(`!!document.querySelector('.notice-box[data-change="3"]')`)));
  await shot("8-identity-change");
  await js(`[...document.querySelectorAll(".notice-box button")].find((b) => b.textContent.includes("put version 2 back")).click()`);
  await sleep(400);
  check("one action puts the earlier version back", mindCalls.some((m) => m.op === "identity_restore" && m.id === 2));
  await js(`document.querySelector(".lattice-button").click()`);
  await until(`!!document.querySelector(".menu-list")`);
  await js(`[...document.querySelectorAll(".menu-list button")].find((b) => b.textContent.includes("ITS FACE")).click()`);
  check("the record of its face lists every design and shows which are Woody's own", (await until(`document.querySelectorAll(".face-entry").length >= 12`)) && (await js(`document.querySelectorAll(".face-entry .lattice[data-own]").length`)) === 2, `${await js(`document.querySelectorAll(".face-entry").length`)} entries`);
  check("a design under one of the frame's names is not listed as Woody's", await js(`![...document.querySelectorAll(".face-entry")].some((e) => /^(paused|problem)$/.test(e.querySelector("b").textContent) && e.textContent.includes("for the check"))`));
  check("a design that is not well formed is said to be so", await js(`[...document.querySelectorAll(".face-entry")].find((e) => e.querySelector("b").textContent === "smile").textContent.includes("not well formed")`));
  await shot("9-face");
  await js(`[...document.querySelectorAll(".face-entry")].find((e) => e.querySelector("b").textContent === "resting").querySelector("button").click()`);
  await sleep(400);
  check("the operator can put a built-in design back", mindCalls.some((m) => m.op === "face_restore" && m.name === "resting" && m.id === undefined));
  await js(`document.querySelector(".panel-head button.ghost").click()`);

  // ---- studies and an explainer's sources (Phase 9b) ----
  // The pages read for a study are handed over with the explainer and shown by the frame, not by the thing.
  const STUDY = {
    id: 3,
    subject: "How tides work",
    sources: [
      { url: "https://oceanservice.example/tides/basics", title: "What causes tides?" },
      { url: "https://encyclopedia.example/wiki/Tide", title: "" },
      { url: "http://plain.example/", title: "not https" },
      { url: "javascript:alert(1)", title: "not an address" },
    ],
  };
  const explainer = await woody("kit", { part: "text", props: KIT_SAMPLES.text, title: "Tides explained", why: "you asked me to learn about tides and show you", study: STUDY });
  check("an explainer is made with the study it explains", explainer.ok && explainer.result.thing.study?.sources.length === 2, explainer.ok ? JSON.stringify(explainer.result.thing.study?.sources.map((s) => s.url)) : explainer.error);
  const exId = explainer.ok ? explainer.result.thing.id : "none";
  check("the frame marks it with the number of pages that were read", await until(`document.querySelector('[data-thing="${exId}"] .thing-sources')?.textContent.trim() === "sources · 2"`));
  check("a thing that explains no study has no such mark", await js(`!document.querySelector('[data-thing="t1"] .thing-sources')`));
  await shot("10-explainer");
  await js(`document.querySelector('[data-thing="${exId}"] .thing-sources').click()`);
  check("its record lists the sources, as the frame holds them", (await until(`document.querySelectorAll(".sources .source").length === 2`)) && (await js(`document.querySelector(".sources").textContent.includes("https://oceanservice.example/tides/basics") && document.querySelector(".sources").textContent.includes("How tides work") && !document.querySelector(".sources").textContent.includes("plain.example")`)));
  check("an address is shown as text, never as a link out of the frame", await js(`document.querySelectorAll(".sources a").length === 0`));
  await shot("11-sources");
  studiesAnswer = {
    studies: [
      { id: 3, subject: "How tides work", why: "Learn about tides and show me.", owner: "operator", status: "done", created: Date.now() - 7_200_000, updated: Date.now(), budget_usd: 1.5, spent_usd: 1.1, max_readings: 5, readings: 3, plan: "", thing_id: exId, outcome: "It shows the two bulges.",
        notes: [{ id: 1, ts: Date.now(), text: "Tides are raised mainly by the moon.", sources: ["https://oceanservice.example/tides/basics"] }], pages: STUDY.sources.slice(0, 2).map((s) => ({ ...s, ts: Date.now() })) },
      { id: 4, subject: "Orbits", why: "Learn about orbits.", owner: "operator", status: "reading", created: Date.now(), updated: Date.now(), budget_usd: 1.5, spent_usd: 0.2, max_readings: 5, readings: 1, plan: "Kepler's second law.", thing_id: null, outcome: "", notes: [], pages: [] },
    ],
  };
  await js(`document.querySelector(".lattice-button").click()`);
  await until(`!!document.querySelector(".menu-list")`);
  await js(`[...document.querySelectorAll(".menu-list button")].find((b) => b.textContent.includes("STUDIES")).click()`);
  check("the studies record shows what is being learned and what was found", (await until(`document.querySelectorAll(".studies details").length === 2`)) && (await js(`document.querySelector(".studies").textContent.includes("reading · session 2 of 5") && document.querySelector(".studies").textContent.includes("Kepler") && document.querySelector(".studies").textContent.includes("read at oceanservice.example")`)));
  await js(`[...document.querySelectorAll(".studies button")].find((b) => b.textContent.includes("drop this study")).click()`);
  await sleep(400);
  check("the operator can drop a study", mindCalls.some((m) => m.op === "study_drop" && m.id === 4));
  await js(`(() => { const i = document.querySelector("#study-subject"); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(i, "How clocks keep time"); i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await sleep(200);
  await js(`[...document.querySelectorAll(".studies form button")].find((b) => b.textContent.trim() === "study").click()`);
  await sleep(400);
  check("and start one", mindCalls.some((m) => m.op === "study_add" && m.subject === "How clocks keep time" && m.size === "medium"));
  await shot("12-studies");
  await js(`document.querySelector(".panel-head button.ghost").click()`);

  // ---- Woody's methods (Phase 10b) ----
  // The operator sees what Woody changed in how it works, with the before and the after, and puts a version back.
  const SHIPPED = "- Review a goal first.\n- Write each checkpoint so that you could resume from it with no other memory.";
  const WOODYS = "- Review a goal first.\n- Write each checkpoint as a letter to a stranger.";
  methodsAnswer = {
    sections: [
      { section: "speaking", title: "Speaking with the operator", text: "- Be direct and brief.", id: 1, ts: Date.now() - 9 * 86_400_000, actor: "program", reason: "as shipped with the program", shipped: true },
      { section: "goals", title: "Working on goals", text: WOODYS, id: 7, ts: Date.now() - 3_600_000, actor: "woody", reason: "A checkpoint of mine was too thin to resume from.", shipped: true },
    ],
    history: {
      speaking: [{ id: 1, section: "speaking", title: "Speaking with the operator", ts: Date.now() - 9 * 86_400_000, text: "- Be direct and brief.", reason: "as shipped with the program", actor: "program" }],
      goals: [
        { id: 7, section: "goals", title: "Working on goals", ts: Date.now() - 3_600_000, text: WOODYS, reason: "A checkpoint of mine was too thin to resume from.", actor: "woody" },
        { id: 2, section: "goals", title: "Working on goals", ts: Date.now() - 9 * 86_400_000, text: SHIPPED, reason: "as shipped with the program", actor: "program" },
      ],
    },
  };
  await js(`document.querySelector(".lattice-button").click()`);
  await until(`!!document.querySelector(".menu-list")`);
  await js(`[...document.querySelectorAll(".menu-list button")].find((b) => b.textContent.includes("ITS METHODS")).click()`);
  check("the record of its methods lists each section and says which Woody wrote", (await until(`document.querySelectorAll(".methods > details").length === 2`)) && (await js(`document.querySelector(".methods").textContent.includes("1 of the 2 sections was written by Woody") && document.querySelector(".methods").textContent.includes("too thin to resume from")`)));
  check("a section Woody rewrote shows the before and the after", await js(`(() => { const d = [...document.querySelectorAll(".methods > details")].find((x) => x.textContent.includes("Working on goals")); return d.open && d.querySelector("mark.diff-gone")?.textContent.includes("resume") && d.querySelector("mark.diff-new")?.textContent.includes("letter to a stranger"); })()`));
  await shot("14-methods");
  await js(`[...document.querySelectorAll(".methods button")].find((b) => b.textContent.includes("put the version before back")).click()`);
  await sleep(400);
  check("one action puts the version before back", mindCalls.some((m) => m.op === "method_restore" && m.section === "goals" && m.id === 2));
  await js(`document.querySelector(".panel-head button.ghost").click()`);

  // ---- pictures from the web (Phase 9c) ----
  // A picture is kept by the canvas as the executor converted it, and reaches only the thing it was given to, through the bridge.
  const WEBP = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64"); // one pixel
  const PIC = `p-${require("crypto").createHash("sha256").update(WEBP).digest("hex").slice(0, 16)}`;
  const kept = await woody("picture_put", { id: PIC, base64: WEBP.toString("base64"), source: "https://oceanservice.example/img/bulges.png", width: 1, height: 1, about: "A diagram of the two tidal bulges." });
  check("the canvas keeps a picture handed over by the agent", kept.ok && kept.result.id === PIC, kept.ok ? "" : kept.error);
  const forged = await woody("picture_put", { id: "p-0000000000000000", base64: WEBP.toString("base64"), source: "https://oceanservice.example/x.png" });
  check("a picture that is not what its name says is refused", !forged.ok && /does not match its name/.test(forged.error), forged.error);
  const SHOWS = `<img id="i"><script>woody.picture("${PIC}").then((u) => { const i = document.getElementById("i"); i.onload = () => { document.body.dataset.loaded = String(i.naturalWidth); woody.ready(); }; i.onerror = () => { document.body.dataset.loaded = "error"; woody.ready(); }; i.src = u; }, (e) => { document.body.dataset.loaded = "refused: " + e.message; woody.ready(); });</script>`;
  const withPic = await woody("make", { title: "With a picture", source: SHOWS, why: "to show the diagram", pictures: [PIC] });
  check("a thing is made with the pictures it may show", withPic.ok && withPic.result.started === true && withPic.result.thing.pictures?.[0]?.source === "https://oceanservice.example/img/bulges.png", withPic.ok ? "" : withPic.error);
  const picThing = withPic.ok ? withPic.result.thing.id : "none";
  check("it loads its picture through the bridge, with no network", (await inThing(picThing, "document.body.dataset.loaded")).value === "1", JSON.stringify(await inThing(picThing, "document.body.dataset.loaded")));
  const without = await woody("make", { title: "Without it", source: SHOWS, why: "to try" });
  const nosy = without.ok ? without.result.thing.id : "none";
  check("a thing that was not given the picture cannot have it", /^refused: .*was not given to this thing/.test((await inThing(nosy, "document.body.dataset.loaded")).value || ""), JSON.stringify(await inThing(nosy, "document.body.dataset.loaded")));
  const noSuch = await woody("make", { title: "Unknown picture", source: SHOWS, why: "to try", pictures: ["p-ffffffffffffffff"] });
  check("a picture that is not kept cannot be given to a thing", !noSuch.ok && /is kept/.test(noSuch.error), noSuch.error);
  check("the frame counts the picture among the thing's sources", await until(`document.querySelector('[data-thing="${picThing}"] .thing-sources')?.textContent.trim() === "sources · 1"`));
  await js(`document.querySelector('[data-thing="${picThing}"] .thing-sources').click()`);
  check("and its record says where the picture came from", await until(`document.querySelector(".sources.pictures")?.textContent.includes("https://oceanservice.example/img/bulges.png")`));
  await shot("13-picture");
  await js(`document.querySelector(".panel-head button.ghost").click()`);
  const lookPics = await woody("look");
  check("Woody sees which pictures are kept and which thing shows each", lookPics.ok && lookPics.result.pictures?.[0]?.id === PIC && lookPics.result.pictures[0].used_by.includes(picThing) && /tidal bulges/.test(lookPics.result.pictures[0].shows), JSON.stringify(lookPics.result?.pictures));

  // ---- everything survives a restart of the gateway ----
  const before = (await things()).map((t) => [t.id, t.box.x, t.box.y, t.version, t.pinned, t.removed]);
  gateway.kill();
  await sleep(800);
  startGateway();
  await sleep(1500);
  check("the canvas is the same after the gateway restarts", JSON.stringify((await things()).map((t) => [t.id, t.box.x, t.box.y, t.version, t.pinned, t.removed])) === JSON.stringify(before));
  check("the frame reconnects and shows the things again", await until(`document.querySelectorAll(".thing.ready").length >= 4`, 20000), `ready: ${await js(`document.querySelectorAll(".thing.ready").length`)}`);
  await shot("6-after-restart");

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  ws.close();
  chrome.kill();
  gateway.kill();
  sink.kill();
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("driver error:", e);
  process.exit(2);
});
