#!/usr/bin/env node
// woody-agent: the entry point. It reads the configuration, connects to the
// executor, builds the agent (agent.ts) and serves its socket.
//
// The agent speaks WebSocket (JSON messages) on a Unix socket handed over by
// systemd. Whoever can open that socket speaks as the operator: the HUD
// gateway and root (see nix/modules/agent.nix).
import fs from "node:fs";
import http from "node:http";
import { WebSocketServer } from "ws";
import { createAgent } from "./agent.js";
import { configFromEnv } from "./config.js";
import { ExecutorClient } from "./executor.js";

const cfg = configFromEnv();
const agent = createAgent({ cfg, exec: new ExecutorClient(cfg.execSocket) });

const server = http.createServer((_req, res) => {
  res.writeHead(426, { "content-type": "text/plain" });
  res.end("woody-agent speaks WebSocket only\n");
});
const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024 });

wss.on("connection", (ws) => {
  agent.clients.add(ws);
  agent.send(ws, agent.stateMessage());
  // The conversation so far, so a reloaded HUD shows it again.
  agent.send(ws, agent.historyMessage());
  ws.on("message", (data) => agent.handle(ws, data.toString()));
  ws.on("close", () => agent.clients.delete(ws));
  ws.on("error", () => agent.clients.delete(ws));
});

// systemd socket activation passes the listening socket as file descriptor 3.
const listenFds = Number(process.env.LISTEN_FDS ?? "0");
if (listenFds >= 1) {
  server.listen({ fd: 3 }, () => console.log("woody-agent: listening on the systemd socket"));
} else if (process.env.WOODY_AGENT_SOCKET) {
  const socketPath = process.env.WOODY_AGENT_SOCKET;
  fs.rmSync(socketPath, { force: true });
  server.listen(socketPath, () => console.log(`woody-agent: listening on ${socketPath}`));
} else {
  const port = Number(process.env.WOODY_AGENT_PORT ?? "7801");
  server.listen(port, "127.0.0.1", () => console.log(`woody-agent: listening on 127.0.0.1:${port} (development)`));
}

// The first pulse comes shortly after start, so anything left in the queue
// by a restart is picked up without waiting a full interval.
setTimeout(() => void agent.pulse(), Math.min(3000, cfg.pulseMs)).unref();
setInterval(() => void agent.pulse(), cfg.pulseMs).unref();

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    agent.shuttingDown = true;
    agent.session?.abort.abort();
    for (const ws of wss.clients) ws.close(1001, "agent shutting down");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
