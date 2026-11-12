// The gateway's command-line modes, for the operator over SSH:
//   sudo -u woody-hud woody-hud set-password
//   sudo -u woody-hud woody-hud canvas <request> ...   (see docs/HUD.md)
// Each ends the process when it is done. Without one of them, the gateway starts.
import fs from "node:fs";
import net from "node:net";
import { CANVAS_SOCKET, HOST_PORT, PASSWORD_FILE } from "./config.js";
import { hashPassword } from "./door.js";

/** Input that arrived after the line just read (piped input delivers several lines at once). */
let pendingInput = "";

/** Reads a line from the terminal without showing it. */
function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk: string) => {
      const text = pendingInput + chunk;
      pendingInput = "";
      for (let i = 0; i < text.length; i++) {
        const ch = text[i]!;
        if (ch === "\r" || ch === "\n") {
          stdin.off("data", onData);
          if (stdin.isTTY) stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write("\n");
          pendingInput = text.slice(i + 1).replace(/^\n/, "");
          resolve(value);
          return;
        }
        if (ch === "\u0003") process.exit(1);
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
    if (pendingInput) onData("");
  });
}

/** Runs the command-line mode the process was started with, if any; returns when there is none. */
export async function commandLine(): Promise<void> {
  if (process.argv[2] === "set-password") {
    // sudo -u woody-hud woody-hud set-password
    const first = await readHidden("New password for the HUD from your own browser: ");
    if (first.length < 10) {
      console.error("Use at least 10 characters.");
      process.exit(1);
    }
    if ((await readHidden("Again: ")) !== first) {
      console.error("The two did not match.");
      process.exit(1);
    }
    fs.writeFileSync(PASSWORD_FILE, hashPassword(first) + "\n", { mode: 0o600 });
    console.log(`Saved. Open https://<the VM's host-only address>:${HOST_PORT || 7843}/ in your browser.`);
    process.exit(0);
  }

  if (process.argv[2] === "canvas") {
    // sudo -u woody-hud woody-hud canvas <request> ...   (see docs/HUD.md)
    const [, , , op, ...rest] = process.argv;
    const flags: Record<string, string> = {};
    const words: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (a.startsWith("--")) flags[a.slice(2)] = rest[i + 1]?.startsWith("--") || rest[i + 1] === undefined ? "yes" : rest[++i]!;
      else words.push(a);
    }
    const file = (p: string | undefined): string => {
      if (!p) throw new Error("a source file is needed");
      return fs.readFileSync(p, "utf8");
    };
    const num = (v: string | undefined): number | undefined => (v === undefined ? undefined : Number(v));
    let request: Record<string, unknown>;
    try {
      switch (op) {
        case "list":
        case "undo":
          request = { op };
          break;
        case "history":
          request = { op, n: num(words[0]) ?? 20 };
          break;
        case "make":
          request = { op, title: words[0], source: file(words[1]), kind: flags.pretend ? "pretend" : "real", for: flags.for, why: flags.why, uninvited: Boolean(flags.uninvited), note: flags.note,
            box: flags.at ? Object.fromEntries(flags.at.split(",").map((v, i) => [["x", "y", "w", "h"][i]!, Number(v)])) : undefined };
          break;
        case "kit":
          request = { op, part: words[0], props: JSON.parse(words[1] ?? "{}"), title: flags.title ?? words[0], why: flags.why, for: flags.for, uninvited: Boolean(flags.uninvited), note: flags.note };
          break;
        case "change":
          request = { op, id: words[0], source: file(words[1]), why: flags.why, title: flags.title };
          break;
        case "place":
          request = { op, id: words[0], box: { x: num(words[1]), y: num(words[2]), w: num(words[3]), h: num(words[4]) }, raise: true, why: flags.why };
          break;
        case "remove":
        case "bring_back":
        case "get":
          request = { op, id: words[0], why: flags.why };
          break;
        case "pin":
          request = { op, id: words[0], pinned: words[1] !== "off" };
          break;
        case "limit":
          request = words[0] === undefined ? { op: "limits" } : { op: "set_limit", n: Number(words[0]) };
          break;
        default:
          console.error(
            "usage: woody-hud canvas list | history [n] | undo\n" +
              "       woody-hud canvas make <title> <file> [--why text] [--pretend] [--for woody] [--at x,y,w,h] [--uninvited --note text]\n" +
              "       woody-hud canvas kit <part> '<values as JSON>' [--title text] [--why text] [--uninvited --note text]\n" +
              "       woody-hud canvas limit [n]     how many things Woody may add in a day on its own (setting it needs --as you)\n" +
              "       woody-hud canvas change <id> <file> [--why text] [--title text]\n" +
              "       woody-hud canvas place <id> <x> <y> [w] [h] | remove <id> | bring_back <id> | get <id> | pin <id> [off]\n" +
              "       add --as you to act as the operator; without it the request is made as Woody would make it",
          );
          process.exit(2);
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(2);
    }
    request.by = flags.as === "you" || ["undo", "pin", "list", "history", "get"].includes(op!) ? "you" : "woody";
    const socket = net.createConnection(CANVAS_SOCKET);
    let reply = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("data", (chunk: string) => {
      reply += chunk;
      if (!reply.includes("\n")) return;
      const r = JSON.parse(reply);
      if (r.ok) console.log(typeof r.result === "string" ? r.result : JSON.stringify(r.result, null, 2));
      else console.error(`refused: ${r.error}`);
      process.exit(r.ok ? 0 : 1);
    });
    socket.on("error", (err) => {
      console.error(`The HUD gateway is not reachable (${err.message}). Run this as the woody-hud user.`);
      process.exit(1);
    });
    await new Promise(() => {});
  }
}
