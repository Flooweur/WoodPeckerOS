// The gateway's settings: where it listens, where the agent and the executor
// are, where it keeps its state. They come from the environment, set by the
// system's configuration (nix/locked/hud.nix).
import path from "node:path";

export const PORT = Number(process.env.WOODY_HUD_PORT ?? "7800");
export const BIND = process.env.WOODY_HUD_BIND ?? "127.0.0.1";
export const AGENT_SOCKET = process.env.WOODY_AGENT_SOCKET ?? "/run/woody-agent/agent.sock";
export const APPROVE_SOCKET = process.env.WOODY_APPROVE_SOCKET ?? "/run/woody/approve.sock";
export const STATE_DIR = process.env.WOODY_HUD_STATE_DIR ?? "/var/lib/woody-hud";
export const RUNTIME_DIR = process.env.WOODY_HUD_RUNTIME_DIR ?? "/run/woody-hud";
export const WEB_ROOT = path.resolve(import.meta.dirname, "../web");
export const ORIGINS = (process.env.WOODY_HUD_ORIGINS ?? `http://127.0.0.1:${PORT}`).split(",");
/** HTTPS port for the operator's browser on the host-only network. 0 turns it off. */
export const HOST_PORT = Number(process.env.WOODY_HUD_HOST_PORT ?? "0");
export const TLS_DIR = process.env.WOODY_HUD_TLS_DIR ?? path.join(STATE_DIR, "tls");
export const PASSWORD_FILE = path.join(STATE_DIR, "host-password");
/** Unix socket of the terminal service. Empty: no terminal. */
export const TERM_SOCKET = process.env.WOODY_TERM_SOCKET ?? "";
export const TERMINAL_FLAG = path.join(RUNTIME_DIR, "terminal-open");
export const JOURNALCTL = process.env.WOODY_JOURNALCTL ?? "journalctl";
export const SYSTEMCTL = process.env.WOODY_SYSTEMCTL ?? "systemctl";
/** Where the operator's command line reaches the canvas of the running gateway. */
export const CANVAS_SOCKET = process.env.WOODY_CANVAS_SOCKET ?? path.join(RUNTIME_DIR, "canvas.sock");

/** Messages the browser may send on to the agent unchanged. */
export const AGENT_BOUND = new Set(["chat", "set_model", "new_session", "interrupt", "get_state", "get_history", "mind", "presence"]);
