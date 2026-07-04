import type { ParsedPlan } from "../plan-parser.js";
import type { ChunkReviewOutcome, ReviewAction } from "../chunk-review/index.js";
import type { JudgmentHook } from "../chunk-review/judgment-hook.js";

export type LoopEventType =
  | "git-baseline"
  | "preflight"
  | "chunk-start"
  | "subprocess-spawned"
  | "subprocess-returned"
  | "review-result"
  | "commit"
  | "spec-amended"
  | "launch-readiness-emitted"
  | "push-back"
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
  /** Optional override for subprocess timeout per chunk. */
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
   * Max chunks to build IN PARALLEL within this orchestration (S3). Optional
   * override for {@link LAXConfig.maxConcurrentChunks}; when omitted, run.ts
   * reads the config value (default 1). 1 → the serial loop is taken and the
   * behaviour is byte-identical to pre-S3. >1 → the parallel-worktree wave
   * path (see loop/parallel-waves.ts). Clamped to [1,12] in run.ts.
   */
  maxConcurrentChunks?: number;
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
