/**
 * Time a tool call spent waiting for a HUMAN, excluded from the tool's own
 * deadline.
 *
 * An approval card is raised from inside `tool.execute`, and the runner wraps
 * that same execute in a per-tool timeout (tool-execution/tool-timeout.ts).
 * The two budgets knew nothing about each other: the browser tool is bounded at
 * 30s and its cards last 5 minutes, so every sensitive-page action died half a
 * minute in however fast the user clicked, the model retried, and the prompts
 * stacked up unanswerable (live 2026-09-16, Google Cloud console — twelve
 * minutes of 30s timeouts in one op's side-effect journal).
 *
 * THE SCOPE IS THE CALL, not an id someone remembers to pass. Keying this by
 * toolCallId looked simpler and was quietly wrong: `args._toolCallId` is
 * injected for five tools only, and every approval site carries a
 * `|| "fallback-id"` — so any mismatch silently restores the bug with nothing
 * failing. An AsyncLocalStorage scope opened by the runner covers whatever the
 * execute awaits, however deep, whatever it calls itself.
 */
import { AsyncLocalStorage } from "node:async_hooks";

interface WaitScope {
  settledMs: number;
  /** Start instants of asks still on screen. The IN-FLIGHT wait has to count:
   *  the deadline arrives WHILE the card is unanswered — that is the whole
   *  failure — so a ledger that only banks finished waits still times the call
   *  out mid-decision. */
  pendingSince: number[];
}

const scope = new AsyncLocalStorage<WaitScope>();

/** Run one tool execution inside its own wait scope. */
export function runInApprovalWaitScope<T>(fn: () => Promise<T>): Promise<T> {
  return scope.run({ settledMs: 0, pendingSince: [] }, fn);
}

/**
 * Mark the start of a wait for a human; the returned function ends it. Outside
 * a scope (a pre-dispatch gate, a server route) both are no-ops: those waits
 * are not inside any tool deadline.
 */
export function beginApprovalWait(): () => void {
  const current = scope.getStore();
  if (!current) return () => {};
  const startedAt = Date.now();
  current.pendingSince.push(startedAt);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const at = current.pendingSince.indexOf(startedAt);
    if (at >= 0) current.pendingSince.splice(at, 1);
    current.settledMs += Date.now() - startedAt;
  };
}

/** What the current call has spent waiting on a human, answered or not. */
export function currentApprovalWaitMs(): number {
  const current = scope.getStore();
  if (!current) return 0;
  const now = Date.now();
  let pending = 0;
  for (const startedAt of current.pendingSince) pending += now - startedAt;
  return current.settledMs + pending;
}
