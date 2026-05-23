// Pool state + lifecycle for warm-pool processes. Owns the `pool` Map (per
// keyStr list of processes), the `waiters` Map (acquire queue when at cap),
// and the periodic idle-evict loop. spawn.ts owns the actual subprocess
// spawn — this file decides WHEN to spawn (via acquire) and WHEN to evict
// (via the idle loop or shutdown).

import { createLogger } from "../../logger.js";
import { spawnWarmProcess } from "./spawn.js";
import { keyStr, type WarmPoolKey, type WarmProcess } from "./types.js";

const logger = createLogger("anthropic-client.warm-pool.pool");

// 30 min idle eviction. Real chat has long natural pauses (think, coffee,
// distraction). The earlier 5-min cap was killing warm processes between
// every "long pause" follow-up — the user paid cold start (~3s) on the
// turn AFTER any break. 30 min covers normal chat rhythm; on actual sleep
// the pool drains naturally and the next session warmups are fast.
const IDLE_EVICT_MS = 30 * 60 * 1000;
const MAX_PROCESSES_PER_KEY = 3;

const pool = new Map<string, WarmProcess[]>();
const waiters = new Map<string, Array<() => void>>();
let evictTimer: ReturnType<typeof setInterval> | null = null;

function wakeOneWaiter(key: string): void {
  const ws = waiters.get(key);
  if (!ws) return;
  const w = ws.shift();
  if (w) w();
}

function startEvictLoop(): void {
  if (evictTimer) return;
  evictTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, procs] of pool) {
      const survivors = procs.filter((p) => {
        if (p.state === "dead") return false;
        if (p.state === "idle" && now - p.lastUsedAt > IDLE_EVICT_MS) {
          logger.info(`[warm-pool] evicting idle process key=${key} age=${Math.round((now - p.spawnedAt) / 1000)}s`);
          try { p.proc.kill("SIGTERM"); } catch { /* already dead */ }
          p.state = "dead";
          return false;
        }
        return true;
      });
      if (survivors.length === 0) pool.delete(key);
      else pool.set(key, survivors);
    }
  }, 60_000);
  evictTimer.unref?.();
}

export async function acquire(key: WarmPoolKey): Promise<WarmProcess> {
  const k = keyStr(key);
  const procs = pool.get(k) ?? [];

  // Find an idle, alive process
  for (const p of procs) {
    if (p.state === "idle") {
      p.state = "busy";
      return p;
    }
  }

  // No idle process — spawn a fresh one if under the cap
  if (procs.length < MAX_PROCESSES_PER_KEY) {
    const wp = spawnWarmProcess(key, { onExit: wakeOneWaiter });
    wp.state = "busy";
    pool.set(k, [...procs, wp]);
    startEvictLoop();
    return wp;
  }

  // At cap, all busy — wait for one to free
  await new Promise<void>((resolve) => {
    const ws = waiters.get(k) ?? [];
    ws.push(resolve);
    waiters.set(k, ws);
  });
  return acquire(key);
}

export function release(wp: WarmProcess): void {
  if (wp.state === "dead") {
    // Drop from pool; waiters will trigger respawn on next acquire
    const procs = pool.get(wp.key);
    if (procs) pool.set(wp.key, procs.filter((p) => p !== wp));
  } else {
    wp.state = "idle";
    wp.lastUsedAt = Date.now();
  }
  wakeOneWaiter(wp.key);
}

/** Test/shutdown hook — kills every warm process and clears state. */
export function shutdownWarmPool(): void {
  for (const [, procs] of pool) {
    for (const p of procs) {
      try { p.proc.kill("SIGTERM"); } catch { /* dead */ }
      p.state = "dead";
    }
  }
  pool.clear();
  waiters.clear();
  if (evictTimer) { clearInterval(evictTimer); evictTimer = null; }
}

/** Telemetry / introspection. */
export function warmPoolSnapshot(): Array<{ key: string; idle: number; busy: number; dead: number }> {
  const out: Array<{ key: string; idle: number; busy: number; dead: number }> = [];
  for (const [key, procs] of pool) {
    out.push({
      key,
      idle: procs.filter((p) => p.state === "idle").length,
      busy: procs.filter((p) => p.state === "busy").length,
      dead: procs.filter((p) => p.state === "dead").length,
    });
  }
  return out;
}
