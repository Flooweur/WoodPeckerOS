// The machine's readings, for the frame's meters and for things on the canvas:
// processor, memory, disk and network, read from /proc every two seconds.
import fs from "node:fs";

// ---- the machine: meters -------------------------------------------------
//
// Read from /proc by this unprivileged process. No model and no executor
// action is involved, so the meters cost nothing and work while Woody rests.

export let lastCpu: { busy: number; total: number } | undefined;
export let lastNet: { bytes: number; at: number } | undefined;

export function readMeters(): Record<string, unknown> {
  const out: Record<string, unknown> = { type: "meters", at: Date.now() };
  try {
    const cpu = fs.readFileSync("/proc/stat", "utf8").split("\n")[0]!.trim().split(/\s+/).slice(1).map(Number);
    const total = cpu.reduce((a, b) => a + b, 0);
    const busy = total - (cpu[3] ?? 0) - (cpu[4] ?? 0);
    if (lastCpu && total > lastCpu.total) out.cpu_pct = Math.round(((busy - lastCpu.busy) / (total - lastCpu.total)) * 100);
    lastCpu = { busy, total };
  } catch {
    /* not available */
  }
  try {
    const mem = fs.readFileSync("/proc/meminfo", "utf8");
    const kb = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(mem)?.[1] ?? 0);
    out.mem_total_kb = kb("MemTotal");
    out.mem_used_kb = kb("MemTotal") - kb("MemAvailable");
  } catch {
    /* not available */
  }
  try {
    const st = fs.statfsSync("/");
    out.disk_free_pct = Math.round((Number(st.bavail) / Number(st.blocks)) * 1000) / 10;
  } catch {
    /* not available */
  }
  try {
    let bytes = 0;
    for (const line of fs.readFileSync("/proc/net/dev", "utf8").split("\n").slice(2)) {
      const [name, rest] = line.split(":");
      if (!rest || name!.trim() === "lo") continue;
      const f = rest.trim().split(/\s+/).map(Number);
      bytes += (f[0] ?? 0) + (f[8] ?? 0);
    }
    const at = Date.now();
    if (lastNet && at > lastNet.at) out.net_kbps = Math.max(0, Math.round((bytes - lastNet.bytes) / 1024 / ((at - lastNet.at) / 1000)));
    lastNet = { bytes, at };
  } catch {
    /* not available */
  }
  try {
    out.uptime_s = Math.round(Number(fs.readFileSync("/proc/uptime", "utf8").split(" ")[0]));
  } catch {
    /* not available */
  }
  try {
    out.generation = Number(/system-(\d+)-link/.exec(fs.readlinkSync("/nix/var/nix/profiles/system"))?.[1] ?? 0) || undefined;
  } catch {
    /* not on NixOS */
  }
  return out;
}
