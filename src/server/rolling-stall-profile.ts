/**
 * A CPU profile that is already recording when the event loop stalls.
 *
 * The sentinel's own capture starts only once the loop is back, so it records
 * the aftermath. Periodic 5–9s stalls during a muse polyglot run (2026-09-17)
 * left two aftermath profiles that were all idle time. With
 * LAX_LOOP_SENTINEL_ROLLING=1 a sampling profile runs in fixed windows; the
 * last finished window is kept in memory, and a stall writes both it and the
 * window it interrupted. A blocked loop cannot roll the window, so the stall
 * itself is always inside one of the two. Off by default (it costs a profiler);
 * the eval servers turn it on.
 */
import { mkdirSync, writeFile } from "node:fs";
import { join } from "node:path";
import { Session } from "node:inspector";
import { getLaxDir } from "../lax-data-dir.js";
import type { StallLogger as Logger } from "./event-loop-sentinel.js";
import { captureStallProfile } from "./event-loop-sentinel.js";

const WINDOW_MS = 30_000;
/** Microseconds between samples: coarse enough to be cheap over a long run. */
const SAMPLING_INTERVAL_US = 5_000;

type Capture = (lagMs: number) => string;

interface Rolling { flush: Capture }

let rolling: Rolling | null = null;

function startRolling(log: Logger): Rolling | null {
  let session: Session;
  try {
    session = new Session();
    session.connect();
  } catch (e) {
    log.warn(`[loop-sentinel] rolling profile unavailable: ${(e as Error).message}`);
    return null;
  }
  let previous: unknown = null;
  let busy = false;
  const post = (method: string, params?: object) =>
    new Promise<any>((resolve, reject) => session.post(method, params ?? {}, (err, res) => (err ? reject(err) : resolve(res))));
  const restart = async (): Promise<unknown> => {
    const { profile } = await post("Profiler.stop");
    await post("Profiler.start");
    return profile;
  };
  void (async () => {
    await post("Profiler.enable");
    await post("Profiler.setSamplingInterval", { interval: SAMPLING_INTERVAL_US });
    await post("Profiler.start");
  })().catch((e) => log.warn(`[loop-sentinel] rolling profile failed to start: ${(e as Error).message}`));
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    restart().then((p) => { previous = p; }).catch(() => {}).finally(() => { busy = false; });
  }, WINDOW_MS);
  timer.unref();
  return {
    flush(lagMs) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const dir = join(getLaxDir(), "logs");
      const path = join(dir, `loop-stall-${stamp}.cpuprofile`);
      try { mkdirSync(dir, { recursive: true }); } catch { /* the write reports it */ }
      const earlier = previous;
      busy = true;
      restart()
        .then((current) => {
          previous = null;
          // Two files: the window the stall ended in, and the one before it.
          writeFile(path, JSON.stringify(current), (e) => { if (e) log.warn(`[loop-sentinel] rolling profile write failed: ${e.message}`); });
          if (earlier) writeFile(path.replace(".cpuprofile", "-prev.cpuprofile"), JSON.stringify(earlier), () => {});
          log.error(`[loop-sentinel] rolling CPU profile covering the ${lagMs}ms stall written to ${path}`);
        })
        .catch((e) => log.warn(`[loop-sentinel] rolling profile flush failed: ${(e as Error).message}`))
        .finally(() => { busy = false; });
      return path;
    },
  };
}

/** The sentinel's profile capture: rolling when enabled, the post-stall one otherwise. */
export function defaultStallCapture(log: Logger): Capture {
  if (process.env.LAX_LOOP_SENTINEL_ROLLING === "1") {
    rolling ??= startRolling(log);
    if (rolling) return rolling.flush;
  }
  return (lagMs) => captureStallProfile(lagMs, log);
}
