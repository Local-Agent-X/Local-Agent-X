/**
 * When a missed deadline says something about the runtime, and when it only
 * says this process was not running.
 *
 * Every probe deadline is a Node timer, and a timer on a blocked event loop
 * fires the instant the loop resumes: this server has stalled 90-110 s at a
 * stretch (server/event-loop-sentinel.ts) and 8-10 s at every boot, which
 * aborts a request that never got a millisecond of service and then reports
 * the runtime down for it. On a healthy loop a timer lands within a few ms of
 * its deadline, so anything this far past its budget is a statement about
 * THIS PROCESS. A refused connection answers in microseconds either way.
 *
 * The one rule for every door to "the local runtime is not there": the
 * embedding provider's health checks (embedding-providers/ollama.ts) and the
 * runtime sweep behind the model picker (discovery.ts).
 */
import { performance } from "node:perf_hooks";

const LOOP_STARVATION_SLACK_MS = 1_000;

/** Monotonic milliseconds. Date.now() would let an NTP step or a laptop resume
 *  fabricate — or hide — a stall. Same clock the loop sentinel measures with. */
export const monotonicNowMs = (): number => Math.round(performance.now());

/**
 * True when a timed operation overran its budget by more than any healthy
 * loop's timer jitter — i.e. its deadline fired late because the loop was
 * starved, so the expiry says nothing about the endpoint.
 */
export function verdictWasStarved(elapsedMs: number, budgetMs: number): boolean {
  return elapsedMs - budgetMs >= LOOP_STARVATION_SLACK_MS;
}
