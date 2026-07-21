import { execFileSync } from "node:child_process";

function queryProcessStart(pid: number): string | null {
  try {
    process.kill(pid, 0);
    if (process.platform === "win32") {
      return execFileSync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
      ], { encoding: "utf-8", timeout: 5_000, windowsHide: true }).trim();
    }
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf-8", timeout: 5_000,
    }).trim() || null;
  } catch {
    return null;
  }
}

const SELF_STARTED_AT = queryProcessStart(process.pid)
  ?? `fallback-${Math.round(Date.now() - process.uptime() * 1000)}`;

function processStart(pid: number): string | null {
  return pid === process.pid ? SELF_STARTED_AT : queryProcessStart(pid);
}

export function currentProcessIncarnation(): string {
  return `${process.pid}:${processStart(process.pid)}`;
}

export function processIncarnationIsLive(pid: number, incarnation: string): boolean {
  const started = processStart(pid);
  return started !== null && incarnation === `${pid}:${started}`;
}
