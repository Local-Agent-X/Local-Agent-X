// "Tell me when X happens" on a call's camera. The user asks ("tell me when the water
// boils"), the agent starts a watch (camera_watch), and from then on the camera's
// frames are checked against the condition on the side: no turn per frame, nothing in
// the chat. When a check sees it, the agent says so on the call and the watch ends.
//
// A watch also ends, and says why, when the camera closes, the frames stop coming, the
// checks keep failing, or its time runs out. The user cancelling it ends it quietly: the
// agent's own reply to "stop watching" is what they hear. The call ending ends it too;
// nothing can be said then, so it is noted in the chat (setCameraWatchNoter).
//
// One watch per call. The turn machine owns it (turn-runner.ts), feeds it every frame,
// and closes it with the call; the tool reaches it by the call's session id.

import { createLogger } from "../../logger.js";
import { CAMERA_FRESH_MS } from "./utterance-media.js";

const logger = createLogger("voice.camera-watch");

/** How often a frame is checked. The phone sends one every 2.5 s; checking each would
 *  be ~24 model calls a minute for a pot that takes minutes to boil. One every 10 s
 *  answers within ~10-15 s of it happening at a quarter of the calls (the cost is in
 *  camera-watch-check.ts). */
export const WATCH_CHECK_EVERY_MS = 10_000;
export const WATCH_DEFAULT_MINUTES = 10;
export const WATCH_MAX_MINUTES = 30;
/** No frame for this long while the camera is meant to be open: the phone slept, left
 *  the app or lost the link, and the watch is blind. */
export const WATCH_FRAMES_LOST_MS = 20_000;
/** Checks that fail in a row (no answer from the model) before the watch gives up. */
export const WATCH_MAX_FAILED_CHECKS = 3;
const HEARTBEAT_MS = 5_000;

/** A check's answer: whether the condition shows in the frame, and the line to say. */
export interface WatchVerdict {
  seen: boolean;
  line: string;
}
/** Ask a model whether the frame shows the condition; null when no answer came. */
export type WatchCheck = (frame: string, condition: string, signal: AbortSignal) => Promise<WatchVerdict | null>;

export type WatchStart =
  | { ok: true; minutes: number; replaced: string | null }
  | { ok: false; reason: string };

export interface CameraWatch {
  /** Start watching for `condition`, replacing any watch already running. */
  start(condition: string, minutes?: number): WatchStart;
  /** The user cancelled it: ends quietly. Returns what it was watching for, or null. */
  cancel(): string | null;
  /** What it is watching for, or how the last watch ended. */
  status(): string;
  /** The camera's latest frame (a data:image URL); null when it closed. */
  onFrame(frame: string | null): void;
  /** The call ended. */
  close(): void;
}

export interface CameraWatchDeps {
  /** Say a line on the call (the turn machine's proactive speaker). */
  say(text: string): void;
  check: WatchCheck;
  /** Note a line in the chat when nothing can be said (the call ended). */
  note?(text: string): void;
  now?: () => number;
}

interface Running {
  condition: string;
  startedAt: number;
  deadline: ReturnType<typeof setTimeout>;
  heartbeat: ReturnType<typeof setInterval>;
  checking: AbortController | null;
  lastCheckAt: number;
  failedChecks: number;
}

export function clampWatchMinutes(minutes: number | undefined): number {
  if (minutes === undefined || !Number.isFinite(minutes) || minutes <= 0) return WATCH_DEFAULT_MINUTES;
  return Math.min(Math.max(minutes, 1), WATCH_MAX_MINUTES);
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function createCameraWatch(deps: CameraWatchDeps): CameraWatch {
  const now = deps.now ?? Date.now;
  let frame: { data: string; at: number } | null = null;
  let running: Running | null = null;
  let lastOutcome = "";
  let closed = false;

  function finish(outcome: string, line: string | null): void {
    const w = running;
    if (!w) return;
    running = null;
    clearTimeout(w.deadline);
    clearInterval(w.heartbeat);
    w.checking?.abort();
    lastOutcome = `${outcome} (${clock(now())})`;
    logger.info(`[camera-watch] ended: ${outcome}`);
    if (line) deps.say(line);
  }

  function maybeCheck(): void {
    const w = running;
    if (!w || w.checking || !frame || now() - w.lastCheckAt < WATCH_CHECK_EVERY_MS) return;
    const ac = new AbortController();
    w.checking = ac;
    w.lastCheckAt = now();
    const shown = frame.data;
    void deps.check(shown, w.condition, ac.signal)
      .catch((e: Error) => {
        logger.warn(`[camera-watch] check threw: ${e.message}`);
        return null;
      })
      .then((verdict) => onVerdict(w, ac, verdict));
  }

  function onVerdict(w: Running, ac: AbortController, verdict: WatchVerdict | null): void {
    if (running !== w || ac.signal.aborted) return;
    w.checking = null;
    if (verdict === null) {
      w.failedChecks += 1;
      if (w.failedChecks >= WATCH_MAX_FAILED_CHECKS) {
        finish(`stopped: the model did not answer ${w.failedChecks} checks in a row`,
          `I can't check the camera right now, so I've stopped watching for ${w.condition}.`);
      }
      return;
    }
    w.failedChecks = 0;
    if (verdict.seen) {
      finish(`saw it: ${verdict.line}`, verdict.line || `Heads up: ${w.condition}.`);
      return;
    }
    maybeCheck();
  }

  function heartbeat(): void {
    const w = running;
    if (!w) return;
    const since = frame ? now() - frame.at : Infinity;
    if (since > WATCH_FRAMES_LOST_MS) {
      finish("stopped: the camera stopped sending pictures",
        `I've stopped getting pictures from the camera, so I've stopped watching for ${w.condition}.`);
      return;
    }
    maybeCheck();
  }

  return {
    start(condition, minutes) {
      const c = condition.trim();
      if (closed) return { ok: false, reason: "The call has ended." };
      if (!c) return { ok: false, reason: "Say what to watch for (condition)." };
      if (!frame || now() - frame.at >= CAMERA_FRESH_MS) {
        return { ok: false, reason: "The camera isn't open on this call. Ask the user to open it (the camera button on the call) and point it at what to watch, then start the watch." };
      }
      const replaced = running?.condition ?? null;
      if (running) finish(`replaced by a watch for ${c}`, null);
      const mins = clampWatchMinutes(minutes);
      const w: Running = {
        condition: c,
        startedAt: now(),
        deadline: setTimeout(() => finish(`timed out after ${mins} min`,
          `I watched for ${mins} minute${mins === 1 ? "" : "s"} and didn't see ${c}, so I've stopped watching.`), mins * 60_000),
        heartbeat: setInterval(heartbeat, HEARTBEAT_MS),
        checking: null,
        lastCheckAt: 0,
        failedChecks: 0,
      };
      running = w;
      logger.info(`[camera-watch] watching for "${c.slice(0, 80)}" up to ${mins} min`);
      maybeCheck();
      return { ok: true, minutes: mins, replaced };
    },

    cancel() {
      const c = running?.condition ?? null;
      if (c) finish("cancelled by the user", null);
      return c;
    },

    status() {
      if (running) {
        const mins = Math.round((now() - running.startedAt) / 60_000);
        return `Watching for ${running.condition} (started ${mins} min ago).`;
      }
      return lastOutcome ? `Not watching. The last watch ${lastOutcome}.` : "Not watching anything.";
    },

    onFrame(next) {
      if (closed) return;
      frame = next === null ? null : { data: next, at: now() };
      if (next === null) {
        const c = running?.condition;
        if (c) finish("stopped: the camera closed", `The camera closed, so I've stopped watching for ${c}.`);
        return;
      }
      maybeCheck();
    },

    close() {
      if (closed) return;
      closed = true;
      const c = running?.condition;
      if (!c) return;
      finish("stopped: the call ended", null);
      deps.note?.(`I stopped watching for ${c}: the call ended.`);
    },
  };
}

// The tool reaches a call's watch by its session id: the chat thread the call joined.
const watches = new Map<string, CameraWatch>();
let noter: ((sessionId: string, text: string) => void) | null = null;

export function registerCameraWatch(sessionId: string, watch: CameraWatch): void {
  if (sessionId) watches.set(sessionId, watch);
}

export function unregisterCameraWatch(sessionId: string, watch: CameraWatch): void {
  if (watches.get(sessionId) === watch) watches.delete(sessionId);
}

export function cameraWatchFor(sessionId: string): CameraWatch | undefined {
  return sessionId ? watches.get(sessionId) : undefined;
}

/** Where a watch notes a line in the chat when the call it ran on ended (server wiring). */
export function setCameraWatchNoter(fn: ((sessionId: string, text: string) => void) | null): void {
  noter = fn;
}

export function noteInChat(sessionId: string, text: string): void {
  try {
    noter?.(sessionId, text);
  } catch (e) {
    logger.warn(`[camera-watch] note failed: ${(e as Error).message}`);
  }
}
