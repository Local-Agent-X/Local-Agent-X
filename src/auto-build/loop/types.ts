import type { ParsedPlan } from "../plan-parser.js";
import type { ChunkReviewOutcome, ReviewAction } from "../chunk-review/index.js";
import type { JudgmentHook } from "../chunk-review/judgment-hook.js";
import type { ChunkJudge } from "../chunk-review/chunk-verdict.js";

export type LoopEventType =
  | "git-baseline"
  | "preflight"
  | "chunk-start"
  | "subprocess-spawned"
  | "subprocess-returned"
  | "review-result"
  | "commit"
  | "chunk-landed"
  | "spec-amended"
  | "launch-readiness-emitted"
  | "push-back"
  /** A chunk was set aside, or left waiting on one that was (loop/set-aside.ts).
   *  The build goes on: unlike "halt", it does not mark the run stopped. */
  | "chunk-set-aside"
  | "halt"
  | "complete";

export interface LoopEvent {
  type: LoopEventType;
  chunkNumber: number;
  totalChunks: number;
  message: string;
  data?: Record<string, unknown>;
  /** Wall-clock ms since loop start. */
  elapsedMs: number;
}

export interface LoopOptions {
  projectDir: string;
  planPath: string;
  plan: ParsedPlan;
  startingChunk: number;
  maxChunks?: number;
  signal?: AbortSignal;
  /** Optional per-event sink. Chunk 8 wires this to the LAX UI. */
  onEvent?: (event: LoopEvent) => void;
  /** Chunks inside this run's window that are already on the base branch: a
   *  build that set a chunk aside lands the ones after it, so what has landed
   *  is not always a prefix. They are skipped, and count as landed for the
   *  chunks that depend on them (orchestrator/state.ts landedChunks). */
  landedChunks?: number[];
  /** How long a chunk worker may go silent (no output, no tool call) before it
   *  is ended as hung (agents/chunk-runner.ts silenceLimitMs; default 30 min).
   *  Not a cap on a run that is working. */
  subprocessTimeoutMs?: number;
  /** Chat session that owns this orchestration — propagated to chunk-worker
   *  agents so the UI can thread their activity back to the right chat. */
  parentSessionId?: string;
  /** Orchestrator run's op id (manager.ts `orch.opId`) — the id the AGENTS-panel
   *  orchestrator card carries (bg_op_started.opId). Threaded down as each chunk
   *  worker's spawn PARENT (invokeDefinition parentAgentId) so the panel nests
   *  the chunk-runner cards UNDER the orchestrator card. Undefined for non-
   *  orchestrator callers (tests, direct runBuildLoop) → workers render as
   *  roots, exactly as before. */
  parentOpId?: string;
  /**
   * Optional LLM judgment hook. When set, fires after the mechanical
   * gates return "proceed" to catch chunk-12-style implicit-spec
   * violations. Defaults to undefined — tests pass a mock; the tool
   * passes {@link defaultJudgmentHook} from chunk-review/judgment-hook.
   * Pure no-op when undefined; never downgrades a halt/push_back/amend_spec.
   */
  judgmentHook?: JudgmentHook;
  /**
   * Optional chunk judge (chunk-review/chunk-judge.ts): once a chunk's build
   * and tests pass, score its held-out scenarios and set a skeptic on it; a
   * failure is a push_back. The build tools pass {@link defaultChunkJudge};
   * undefined → chunks are not judged (tests, other callers).
   */
  chunkJudge?: ChunkJudge;
  /**
   * Max chunks to build IN PARALLEL within this orchestration (S3). Optional
   * override for {@link LAXConfig.maxConcurrentChunks}; when omitted, run.ts
   * reads the config value (default 1). 1 → the serial loop is taken and the
   * behaviour is byte-identical to pre-S3. >1 → the parallel-worktree wave
   * path (see loop/parallel-waves.ts). Clamped to [1,12] in run.ts.
   */
  maxConcurrentChunks?: number;
  /** Run the finish gates (finish-gates/run.ts) when the run lands the plan's
   *  last chunk. The build tools pass true; tests and other callers leave it out. */
  finishGates?: boolean;
  /** The finish gates' own fix chunks: the judge was proven when the build
   *  started, so the wall probe (loop/wall-probe.ts) is not run again. */
  skipWallProbe?: boolean;
}

export interface LoopResult {
  status: "complete" | "halted";
  /** 1-indexed chunk where the loop ended. For "complete", this is the last chunk run. */
  lastChunk: number;
  /** Total chunks committed (proceed + amend_spec actions). */
  chunksCommitted: number;
  /** Halt reasoning when status === "halted". Empty when complete. */
  haltReason: string;
  /** All per-chunk review outcomes, in order. Useful for surfacing the full punch list. */
  outcomes: Array<{ chunkNumber: number; outcome: ChunkReviewOutcome; action: ReviewAction }>;
  events: LoopEvent[];
  /** What the finish gates left open: unfixed findings, scenarios still
   *  failing or unjudged, and the checks only a person can make. */
  openItems?: string[];
}

export type EmitFn = (e: Omit<LoopEvent, "elapsedMs">) => void;

export function haltedResult(
  reason: string,
  lastChunk: number,
  outcomes: LoopResult["outcomes"],
  events: LoopEvent[],
): LoopResult {
  return { status: "halted", lastChunk, chunksCommitted: 0, haltReason: reason, outcomes, events };
}

export async function safeGet<T>(
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try { return { ok: true, value: await fn() }; }
  catch (e) { return { ok: false, error: (e as Error).message }; }
}
