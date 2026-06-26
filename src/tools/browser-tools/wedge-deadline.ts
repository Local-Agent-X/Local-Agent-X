import type { ToolResult } from "../../types.js";

/** Sentinel: the browser action exceeded its deadline and the session was reset. */
export const WEDGED = Symbol("browser-wedged");

/**
 * Race a browser action against a hang-recovery deadline.
 *
 * `observe()` / `snapshot()` have no internal timeout, so a wedged CDP
 * connection can hang an action forever. The outer per-tool timeout
 * (tool-timeout.ts) only ABANDONS the call — `Promise.race`, no cancellation —
 * leaving the wedged Chrome to be reused by the next call until LAX restarts.
 * We fire just before that abandon and run `reset` (force-kill Chrome + drop
 * the session) so the NEXT call re-acquires a fresh Chrome: in-process
 * recovery, no restart.
 *
 * `deadlineMs <= 0` means no deadline (the operator set the browser tool
 * unbounded) — return the op untouched. `reset` is injected so this stays
 * unit-testable without spawning a real browser.
 */
export async function raceWedgeDeadline(
  op: Promise<ToolResult>,
  deadlineMs: number,
  reset: () => void,
): Promise<ToolResult | typeof WEDGED> {
  if (deadlineMs <= 0) return op;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof WEDGED>((resolve) => {
    timer = setTimeout(() => resolve(WEDGED), deadlineMs);
    timer.unref?.();
  });

  try {
    const r = await Promise.race([op, deadline]);
    if (r === WEDGED) {
      reset();
      // The hung op keeps running until reset() drops the connection; swallow
      // its eventual rejection so it isn't an unhandled rejection.
      op.catch(() => { /* expected once the connection is force-dropped */ });
    }
    return r;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
