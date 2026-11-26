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
 * State lives at `<project_dir>/.lax-build-history.json` — alongside
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

export const STATE_FILENAME = ".lax-build-history.json";
/** Pre-rename filename — read when the new one is absent. Writes go to the new name. */
const LEGACY_STATE_FILENAME = ".primal-build-state.json";
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

/**
 * A chunk a run set aside, for the next run to pick up from: the branch its
 * work was kept on and what the reviews found, oldest first. Each resume used
 * to rebuild a set-aside chunk from nothing, so it lost the last run's fixes
 * and met a new finding every time: label-check's chunk 3 was set aside in
 * four runs, on six branches (2026-11-22). Cleared when the chunk lands.
 */
export interface SetAsideRecord {
  branch?: string;
  findings: string[];
  /** A chunk paused mid-build (orchestrator/run-control.ts): the fix round it
   *  was on, so it goes on from that round. Absent for a chunk set aside after
   *  its rounds, which a later run gives a full budget. */
  round?: number;
}

/**
 * A phase whose closing chunk landed while the phase's verification gate was
 * still unscored, because another chunk of the phase had not landed (it was
 * set aside). The gate is only reached through the closing chunk's review, so
 * a later run that builds just the set-aside chunk never came back to it and
 * the phase went unscored for good. The record brings it back: the phase is
 * scored once all its chunks have landed (loop/phase-gate-pause.ts).
 */
export interface OwedPhaseGate {
  /** The chunk that closes the phase: the one its gate is scored for. */
  chunk: number;
  /** The gate's own words from that chunk's review. */
  reasoning: string;
}

/**
 * A check that should have run on what landed and could not run on this
 * machine: owed to the owner, never a reason to send work back to a worker.
 * One list for every check, kept here so a restart does not lose it. Until
 * 2026-11-26 it was a string on a chunk's review outcome, which the lead's
 * "owed" overwrote, a resume dropped, and five checks never wrote at all (a
 * skeptic that did not run, a judge that crashed, an unscored phase gate, the
 * wall probe, the merged re-gate).
 */
export interface OwedCheck {
  /** The chunk it was owed on; absent for a check of the whole build. */
  chunk?: number;
  /** Which check, in a few words: "build and tests", "skeptic review". */
  check: string;
  /** Why it could not run, as a sentence the owner reads. */
  why: string;
}

export interface BuildState {
  haltHistory: HaltRecord[];
  /** Keyed by chunk number. */
  setAside?: Record<string, SetAsideRecord>;
  /** Keyed by phase name. */
  owedPhaseGates?: Record<string, OwedPhaseGate>;
  owed?: OwedCheck[];
}

const MAX_CARRIED_FINDINGS = 8;
const CARRIED_FINDING_CHARS = 1_500;

export function statePath(projectDir: string): string {
  return join(projectDir, STATE_FILENAME);
}

export function readBuildState(projectDir: string): BuildState {
  let p = statePath(projectDir);
  if (!existsSync(p)) p = join(projectDir, LEGACY_STATE_FILENAME);
  if (!existsSync(p)) return { haltHistory: [] };
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<BuildState>;
    const history = Array.isArray(raw.haltHistory) ? raw.haltHistory : [];
    const setAside = raw.setAside && typeof raw.setAside === "object" ? raw.setAside : undefined;
    const owedPhaseGates = raw.owedPhaseGates && typeof raw.owedPhaseGates === "object" ? raw.owedPhaseGates : undefined;
    const owed = Array.isArray(raw.owed) ? raw.owed : undefined;
    return { haltHistory: history.slice(-MAX_HISTORY), ...(setAside ? { setAside } : {}), ...(owedPhaseGates ? { owedPhaseGates } : {}), ...(owed ? { owed } : {}) };
  } catch {
    return { haltHistory: [] };
  }
}

function writeBuildState(projectDir: string, state: BuildState): void {
  try {
    writeFileSync(statePath(projectDir), JSON.stringify(state, null, 2));
  } catch {
    // Best-effort — recovery state is auxiliary, not load-bearing.
  }
}

/** Record that `chunk` was set aside: where its work is kept and what was found. */
export function recordSetAside(projectDir: string, chunk: number, branch: string | undefined, finding: string | string[], round?: number): void {
  const state = readBuildState(projectDir);
  const prior = state.setAside?.[chunk];
  let findings = prior?.findings ?? [];
  for (const one of Array.isArray(finding) ? finding : [finding]) {
    const text = one.trim().slice(0, CARRIED_FINDING_CHARS);
    if (text && !findings.includes(text)) findings = [...findings, text];
  }
  findings = findings.slice(-MAX_CARRIED_FINDINGS);
  // A run that wrote nothing new keeps the branch the earlier work is on.
  const kept = branch ?? prior?.branch;
  state.setAside = { ...state.setAside, [chunk]: { ...(kept ? { branch: kept } : {}), findings, ...(round != null ? { round } : {}) } };
  writeBuildState(projectDir, state);
}

/** What an earlier run left for `chunk`, if it set the chunk aside. */
export function setAsideRecordFor(projectDir: string, chunk: number): SetAsideRecord | undefined {
  return readBuildState(projectDir).setAside?.[chunk];
}

/**
 * A chunk landed: nothing of it is left to carry, and the checks that could
 * not run on it are what the owner is owed for it now (a chunk built again
 * replaces what an earlier landing left).
 */
export function recordLanded(projectDir: string, chunk: number, owed: readonly Omit<OwedCheck, "chunk">[] = []): void {
  const state = readBuildState(projectDir);
  const had = (state.owed ?? []).some((o) => o.chunk === chunk);
  if (!state.setAside?.[chunk] && !had && owed.length === 0) return;
  if (state.setAside?.[chunk]) {
    const { [chunk]: _landed, ...rest } = state.setAside;
    state.setAside = rest;
  }
  state.owed = [...(state.owed ?? []).filter((o) => o.chunk !== chunk), ...owed.map((o) => ({ chunk, check: o.check, why: o.why.slice(0, CARRIED_FINDING_CHARS) }))];
  writeBuildState(projectDir, state);
}

/** A check of the whole build (a phase's gate, the judge's own check) that could not run. */
export function recordOwed(projectDir: string, owed: OwedCheck): void {
  const state = readBuildState(projectDir);
  const same = (o: OwedCheck) => o.chunk === owed.chunk && o.check === owed.check;
  state.owed = [...(state.owed ?? []).filter((o) => !same(o)), { ...owed, why: owed.why.slice(0, CARRIED_FINDING_CHARS) }];
  writeBuildState(projectDir, state);
}

/** Every check owed to the owner on what has landed, oldest first. */
export function owedChecks(projectDir: string): OwedCheck[] {
  return readBuildState(projectDir).owed ?? [];
}

/** Record that `phase` still owes its gate: its closing chunk landed unscored. */
export function recordOwedPhaseGate(projectDir: string, phase: string, gate: OwedPhaseGate): void {
  const state = readBuildState(projectDir);
  state.owedPhaseGates = { ...state.owedPhaseGates, [phase]: { chunk: gate.chunk, reasoning: gate.reasoning.slice(0, CARRIED_FINDING_CHARS) } };
  writeBuildState(projectDir, state);
}

/** The phases that still owe their gate, by name. */
export function owedPhaseGates(projectDir: string): Record<string, OwedPhaseGate> {
  return readBuildState(projectDir).owedPhaseGates ?? {};
}

/** `phase`'s gate was reached: scored, or handed to a person. */
export function clearOwedPhaseGate(projectDir: string, phase: string): void {
  const state = readBuildState(projectDir);
  if (!state.owedPhaseGates?.[phase]) return;
  const { [phase]: _reached, ...rest } = state.owedPhaseGates;
  state.owedPhaseGates = rest;
  writeBuildState(projectDir, state);
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
