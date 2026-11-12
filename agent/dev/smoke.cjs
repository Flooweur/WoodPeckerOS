// Starts the built agent the way the system does (code generation off), without a key or an executor,
// and asks it what the HUD asks. Usage, after a build (npm run build):  node dev/smoke.cjs .
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const agent = path.resolve(process.argv[2]);
const WebSocket = require(path.join(agent, "node_modules", "ws"));
const state = fs.mkdtempSync(path.join(os.tmpdir(), "woody-smoke-"));
const env = { ...process.env, WOODY_STATE_DIR: state, WOODY_AGENT_PORT: "7877", WOODY_EXEC_SOCKET: path.join(state, "no-exec.sock"), WOODY_PULSE_MS: "600000" };
delete env.ANTHROPIC_API_KEY;
delete env.CLAUDE_CODE_OAUTH_TOKEN;
delete env.LISTEN_FDS;
delete env.WOODY_AGENT_SOCKET;
const entry = path.join(agent, "dist", "core", "server.js");

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...args, entry], { env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => resolve({ code, out, child }));
    setTimeout(() => resolve({ code: null, out, child }), 4000);
  });
}

(async () => {
  let failures = 0;
  const check = (name, ok, detail = "") => {
    if (!ok) failures++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` · ${detail}` : ""}`);
  };

  const plain = await run([]);
  check("without the switch the agent refuses to start", plain.code === 78 && /refusing to start/.test(plain.out), `exit ${plain.code}`);
  plain.child.kill();

  const started = await run(["--disallow-code-generation-from-strings"]);
  check("with the switch it starts and listens", started.code === null && /listening on 127\.0\.0\.1:7877/.test(started.out), started.out.trim().split("\n").slice(-3).join(" | "));
  if (started.code !== null) process.exit(1);

  const ws = new WebSocket("ws://127.0.0.1:7877/");
  const got = [];
  ws.on("message", (raw) => got.push(JSON.parse(raw.toString())));
  await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
  const ask = async (op, extra = {}) => {
    const before = got.length;
    ws.send(JSON.stringify({ type: "mind", op, ...extra }));
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const m = got.slice(before).find((x) => x.type === "mind_result" && x.op === op);
      if (m) return m;
    }
    return { ok: false, error: "no answer" };
  };
  await new Promise((r) => setTimeout(r, 400));
  const st = got.find((m) => m.type === "state");
  check("it reports its state", Boolean(st && st.mind_state && st.identity && typeof st.face === "number" && st.life), st ? `state ${st.mind_state.state}, identity v${st.identity.version}` : "no state");

  for (const op of ["stats", "goals", "inbox", "identity", "life", "face", "studies", "methods", "activity", "journal", "memories"]) {
    const r = await ask(op, { n: 5 });
    check(`the record "${op}" answers`, r.ok === true, r.ok ? "" : r.error);
  }
  // What only the operator does still works from the operator's side.
  check("the operator suggests an interest", (await ask("interest_suggest", { topic: "Tide tables" })).ok === true);
  const study = await ask("study_add", { subject: "How tides work", size: "small" });
  check("the operator starts a study", study.ok === true && study.result.studies[0].owner === "operator", study.error || "");
  check("the operator switches Woody's identity changes off and on", (await ask("identity_freeze", { frozen: true })).result?.state?.frozen === true && (await ask("identity_freeze", { frozen: false })).result?.state?.frozen === false);
  const set = await ask("identity_set", { text: "You are Woody. You are calm, exact and a little dry, and you never bluff or mislead." });
  check("the operator rewrites the identity", set.ok === true && set.result.current.version === 2, set.error || "");
  check("and puts the first version back", (await ask("identity_restore", { id: 1 })).result?.current?.version === 3);
  check("a study can be dropped", (await ask("study_drop", { id: 1 })).ok === true);
  const life = await ask("life");
  check("the reason for the next moment of its own is given", typeof life.result?.next === "string" && life.result.next.length > 5, life.result?.next);

  // A message with no key: the agent must answer with the error, not fall over.
  ws.send(JSON.stringify({ type: "chat", text: "hello" }));
  await new Promise((r) => setTimeout(r, 1500));
  const err = got.find((m) => m.type === "error");
  check("a message without an API key is refused cleanly", Boolean(err && err.error === "no-credential"), err ? err.error : "no error message");
  check("the agent is still running", started.child.exitCode === null);

  ws.close();
  started.child.kill();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(state, { recursive: true, force: true });
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("smoke error:", e);
  process.exit(2);
});
