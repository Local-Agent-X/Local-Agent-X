// Provider-agnostic idle-event detector for the adapter stream. The
// orchestrator calls noteActivity() on every adapter report; if nothing
// arrives for idleMs the watchdog fires onTimeout, which is where the
// orchestrator records the stall, emits the error event, and aborts the
// adapter. Productive long turns reset the timer on every event and never
// trip this; only true stalls die.
//
// Default 600s. Used to be 120s, which killed legitimately long thinking
// + tool-prep turns (Opus on a big prompt, planning convos with the
// methodology body inlined, etc.). 10 min is still tight enough that true
// stalls die; productive turns reset the timer on every adapter event so
// they never trip it. Override via LAX_CANONICAL_IDLE_TIMEOUT_MS.

export interface IdleWatchdog {
  /** Call from the adapter report callback on every chunk/finalize/error. */
  noteActivity(): void;
  /** Call after the adapter resolves (success or abort). */
  disarm(): void;
}

export interface IdleWatchdogOptions {
  idleMs: number;
  onTimeout: () => void;
}

export function createIdleWatchdog(opts: IdleWatchdogOptions): IdleWatchdog {
  const { idleMs, onTimeout } = opts;
  let lastReportAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (Date.now() - lastReportAt < idleMs) {
        arm();
        return;
      }
      onTimeout();
    }, idleMs);
  };
  arm();
  return {
    noteActivity() { lastReportAt = Date.now(); },
    disarm() { if (timer) { clearTimeout(timer); timer = null; } },
  };
}

export function readIdleTimeoutMs(): number {
  // Guard like readChatWallClockMs (chat-runner.ts): a malformed override
  // parses to NaN, and setTimeout(cb, NaN) fires immediately while the
  // re-arm guard (Date.now() - lastReportAt < NaN) is always false — so
  // every turn would abort as 'stalled' in milliseconds. Require a finite,
  // positive value or fall back to the 600s default.
  const raw = parseInt(process.env.LAX_CANONICAL_IDLE_TIMEOUT_MS ?? "600000", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 600000;
}
