/**
 * Orchestrator state — persists the live state of an in-flight build run
 * so it can resume after a LAX server restart.
 *
 * Why this exists: `primal_run_build_plan` runs for hours. LAX gets
 * restarted unexpectedly (AV quarantine, OOM, port conflict, user
 * triggers a reboot). Without persistence, every restart loses 4 hours
 * of progress. The state file IS the contract for resumability.
 *
 * Location: `<project_dir>/.primal-orchestrator-state.json`. Per-project
 * so different concurrent builds keep independent state. Best-effort:
 * file write failures don't halt the build; resume just won't work.
 *
 * Distinct from `.primal-build-state.json` (failure-recovery halt
 * history). That file accumulates across runs; this one is per-run.
 *
 * On every chunk boundary the orchestrator manager rewrites this file
 * atomically. On LAX boot, a scanner reads it and decides whether to
 * resume.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export const ORCHESTRATOR_STATE_FILENAME = ".primal-orchestrator-state.json";
const STATE_FILE_VERSION = 1;

export type OrchestratorPhase =
  | "starting"      // orchestrator just registered, no chunk has run yet
  | "running"       // mid-chunk or between chunks
  | "halted"        // halted with a reason (user must intervene)
  | "complete"      // all chunks shipped + final phase gate passed
  | "abandoned";    // server restarted and we couldn't resume cleanly

export interface OrchestratorState {
  /** Schema version — bump when fields change. */
  version: number;
  /** Identifier for this orchestrator run. Maps to the chat opId. */
  opId: string;
  /** Chat session that owns this run — for routing completion narration. */
  sessionId: string;
  /** Absolute path to project_dir. */
  projectDir: string;
  /** Absolute path to spec/plan.md. */
  planPath: string;
  /** Total chunk count in plan. */
  totalChunks: number;
  /** 1-indexed chunk the orchestrator is currently working on (or last completed if phase==halted/complete). */
  currentChunk: number;
  /** Chunk number to resume at after a restart. = lastCommitted + 1 for proceed flows. */
  resumeAtChunk: number;
  /** Number of chunks committed so far. */
  chunksCommitted: number;
  /** Current orchestrator phase. */
  phase: OrchestratorPhase;
  /** Halt reason when phase==halted. Empty otherwise. */
  haltReason: string;
  /** Gate that fired the halt — null when not halted. */
  haltGate: string | null;
  /** ISO timestamps. */
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  /** Optional starting chunk override (when resuming or running a partial range). */
  startingChunkOverride: number | null;
  /** Optional cap on chunks for this invocation. */
  maxChunks: number | null;
}

export function statePath(projectDir: string): string {
  return join(projectDir, ORCHESTRATOR_STATE_FILENAME);
}

export function exists(projectDir: string): boolean {
  return existsSync(statePath(projectDir));
}

/**
 * Read the orchestrator state file. Returns null if missing OR malformed
 * (rather than throwing) — callers treat "no state" as "no in-flight run."
 * Version-mismatch returns null too; we don't try to migrate.
 */
export function read(projectDir: string): OrchestratorState | null {
  const p = statePath(projectDir);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<OrchestratorState>;
    if (raw.version !== STATE_FILE_VERSION) return null;
    if (!raw.opId || !raw.projectDir || !raw.phase) return null;
    return raw as OrchestratorState;
  } catch {
    return null;
  }
}

/**
 * Atomic write: write to a `.tmp` sibling, then rename. Prevents a partial
 * file from being read mid-write if the process dies. Best-effort: on any
 * IO error we log to stderr and return false; the orchestrator continues.
 */
export function write(state: OrchestratorState): boolean {
  const final = statePath(state.projectDir);
  const tmp = final + ".tmp";
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, final);
    return true;
  } catch (e) {
    process.stderr.write(`[orchestrator-state] write failed: ${(e as Error).message}\n`);
    return false;
  }
}

/**
 * Delete the state file. Called on clean completion AND on user-explicit
 * abandon. Resume logic relies on the file's presence to detect in-flight
 * runs; leaving a complete file would cause spurious resume attempts.
 */
export function clear(projectDir: string): void {
  const p = statePath(projectDir);
  try {
    if (existsSync(p)) unlinkSync(p);
  } catch {
    /* best-effort */
  }
}

export function makeInitial(opts: {
  opId: string;
  sessionId: string;
  projectDir: string;
  planPath: string;
  totalChunks: number;
  startingChunk: number;
  maxChunks?: number;
}): OrchestratorState {
  const now = new Date().toISOString();
  return {
    version: STATE_FILE_VERSION,
    opId: opts.opId,
    sessionId: opts.sessionId,
    projectDir: opts.projectDir,
    planPath: opts.planPath,
    totalChunks: opts.totalChunks,
    currentChunk: opts.startingChunk,
    resumeAtChunk: opts.startingChunk,
    chunksCommitted: 0,
    phase: "starting",
    haltReason: "",
    haltGate: null,
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    startingChunkOverride: opts.startingChunk,
    maxChunks: opts.maxChunks ?? null,
  };
}

export function markChunkStarted(state: OrchestratorState, chunkNumber: number): OrchestratorState {
  return {
    ...state,
    phase: "running",
    currentChunk: chunkNumber,
    updatedAt: new Date().toISOString(),
  };
}

export function markChunkCommitted(state: OrchestratorState, chunkNumber: number): OrchestratorState {
  return {
    ...state,
    phase: "running",
    currentChunk: chunkNumber,
    resumeAtChunk: chunkNumber + 1,
    chunksCommitted: state.chunksCommitted + 1,
    updatedAt: new Date().toISOString(),
  };
}

export function markHalted(state: OrchestratorState, chunkNumber: number, gate: string, reason: string): OrchestratorState {
  return {
    ...state,
    phase: "halted",
    currentChunk: chunkNumber,
    haltGate: gate,
    haltReason: reason,
    updatedAt: new Date().toISOString(),
  };
}

export function markComplete(state: OrchestratorState): OrchestratorState {
  const now = new Date().toISOString();
  return {
    ...state,
    phase: "complete",
    updatedAt: now,
    completedAt: now,
  };
}

export function markAbandoned(state: OrchestratorState, reason: string): OrchestratorState {
  return {
    ...state,
    phase: "abandoned",
    haltReason: reason,
    haltGate: "abandoned-on-restart",
    updatedAt: new Date().toISOString(),
  };
}
