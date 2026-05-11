/**
 * Failure-recovery state — tracks halt history across invocations so the
 * tool can surface a "systemic issue" warning when the same gate fires
 * three times in a row.
 *
 * The loop itself handles single-invocation retry-once (chunk 5). This
 * module covers the cross-invocation pattern from the design memo's
 * failure-recovery table: "Three consecutive halts: escalate as
 * 'systemic issue,' request user investigation."
 *
 * State lives at `<project_dir>/.primal-build-state.json` — alongside
 * the build, not in the user's home, so different projects keep
 * independent halt histories. The file is intentionally small: a list
 * of the last ~10 halts with {chunk, gate, reason, when}. The tool
 * reads it on invocation start and writes to it on halt.
 *
 * Best-effort: any read/write failure falls back to "no history" — we
 * never block the tool on state-file errors.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STATE_FILENAME = ".primal-build-state.json";
const MAX_HISTORY = 10;
const SYSTEMIC_THRESHOLD = 3;

export interface HaltRecord {
  /** ISO timestamp. */
  at: string;
  chunk: number;
  /** Which gate fired. Empty if the halt happened outside the gate machinery (e.g. git failure). */
  gate: string;
  /** Short reason — first ~200 chars of the halt reasoning. */
  reason: string;
}

export interface BuildState {
  haltHistory: HaltRecord[];
}

export function statePath(projectDir: string): string {
  return join(projectDir, STATE_FILENAME);
}

export function readBuildState(projectDir: string): BuildState {
  const p = statePath(projectDir);
  if (!existsSync(p)) return { haltHistory: [] };
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<BuildState>;
    const history = Array.isArray(raw.haltHistory) ? raw.haltHistory : [];
    return { haltHistory: history.slice(-MAX_HISTORY) };
  } catch {
    return { haltHistory: [] };
  }
}

export function appendHalt(projectDir: string, record: Omit<HaltRecord, "at">): void {
  try {
    const state = readBuildState(projectDir);
    state.haltHistory.push({ at: new Date().toISOString(), ...record });
    if (state.haltHistory.length > MAX_HISTORY) state.haltHistory = state.haltHistory.slice(-MAX_HISTORY);
    writeFileSync(statePath(projectDir), JSON.stringify(state, null, 2));
  } catch {
    // Best-effort — recovery state is auxiliary, not load-bearing.
  }
}

export interface SystemicCheckResult {
  systemic: boolean;
  /** When systemic, the gate name that fired ≥3 times consecutively. */
  gate?: string;
  /** Count of consecutive halts on that gate at the tail of history. */
  count?: number;
  /** Human-readable advice surfaced to the user. */
  advice?: string;
}

/**
 * Check whether the trailing halts share a gate. If the last N >= 3
 * halts (in time order) all reference the same gate, surface a
 * systemic-issue warning. Empty-gate halts (git failures, plan parse
 * errors) don't count toward the streak — those are infrastructure
 * issues, not review-pass patterns.
 */
export function checkSystemic(state: BuildState): SystemicCheckResult {
  const history = state.haltHistory;
  if (history.length < SYSTEMIC_THRESHOLD) return { systemic: false };

  const tail = history.slice(-SYSTEMIC_THRESHOLD);
  const firstGate = tail[0].gate;
  if (!firstGate) return { systemic: false };
  if (!tail.every(h => h.gate === firstGate)) return { systemic: false };

  return {
    systemic: true,
    gate: firstGate,
    count: SYSTEMIC_THRESHOLD,
    advice:
      `Systemic issue detected: the last ${SYSTEMIC_THRESHOLD} halts all fired on the "${firstGate}" gate. ` +
      `Before resuming, investigate the underlying cause — repeatedly tripping the same gate usually means the ` +
      `spec or the agent skill is mismatched to this kind of chunk, not that each chunk is independently buggy. ` +
      `Resume only after deciding: (a) is the spec ambiguous in a way that triggers this gate? (b) is the ` +
      `worker skill insufficient for these chunks? Fix the root cause; don't keep retrying.`,
  };
}
