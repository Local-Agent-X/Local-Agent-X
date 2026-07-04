/**
 * S4 — re-gate the MERGED tree (close the semantic-conflict hole).
 *
 * S3 (parallel-waves.ts) builds same-wave sibling chunks in DISJOINT git
 * worktrees and merges them back one at a time. Each sibling built + gated in
 * ITS OWN worktree, but the COMBINED tree — both siblings merged together — is
 * NEVER built or tested by any single worktree. A merge can be textually clean
 * (git exit 0, no conflict markers) yet SEMANTICALLY broken: two independently
 * compiling changes that break when combined. S3 halts on TEXTUAL conflicts
 * only; catching the textually-clean-but-broken combination is THIS module's
 * job.
 *
 * Two additive, parallel-path-only checks live here:
 *   1. reGateMergedTree — after a wave's chunks are all merged into base, run
 *      the EXISTING build-exec gate (chunk-review/gate-build-exec) ONCE on the
 *      merged base tree. A non-zero build/test/smoke HALTS the whole build
 *      before the next wave is dispatched (same halt discipline as S3's
 *      textual-conflict halt). It no-ops cleanly when the project has no
 *      build/test script (the gate returns null).
 *   2. warnFootprintEscapes — a DIAGNOSTIC (warn, never halt): a chunk whose
 *      ACTUAL changed files escape its DECLARED footprint means the plan
 *      under-declared, which is exactly how a real parallel conflict sneaks
 *      past the disjointness assumption. The re-gate build catches the actual
 *      break; this flags the latent cause so plans improve.
 *
 * REUSE, not fork: the re-gate IS runBuildExecGate (no second build runner);
 * the footprint check IS the conflict-graph's normPath + segment-prefix match
 * via footprintEscapes (no second path matcher).
 */

import { runBuildExecGate } from "../chunk-review/gate-build-exec.js";
import { footprintEscapes } from "../conflict-graph.js";
import { appendHalt } from "../failure-recovery.js";
import type { ParsedChunk } from "../plan-parser.js";
import type { EmitFn, LoopEvent, LoopResult } from "./types.js";

/** Outcome of a per-wave integration re-gate: proceed, or halt the build. */
export type ReGateResult =
  | { kind: "ok" }
  | { kind: "halt"; result: LoopResult };

export interface ReGateInput {
  projectDir: string;
  signal?: AbortSignal;
  totalChunks: number;
  /** 0-based wave index (surfaced 1-based) — localizes WHICH wave broke. */
  waveIndex: number;
  /** Chunk number to anchor the halt on — the last chunk merged this wave. */
  lastChunkNumber: number;
  /** Chunks committed so far (carried onto the halt result unchanged). */
  chunksCommitted: number;
  emit: EmitFn;
  events: LoopEvent[];
  outcomes: LoopResult["outcomes"];
}

/**
 * Run the build-exec gate once on the MERGED base tree after a wave's merge-back
 * loop completes and BEFORE the next wave's worktrees are cut from it. Reuses the
 * existing runBuildExecGate — it runs the project's real `npm run build` +
 * `npm test` + a file:// smoke and reads ACTUAL exit codes, so a textually-clean
 * merge that breaks the combined tree is caught here.
 *
 * On a gate finding (build/test/smoke non-zero): HALT — surface a clear reason
 * naming the wave + the gate's failure output, record it in the halt history,
 * and return {kind:"halt"} so the caller stops before the next wave. Never
 * auto-fixes. A gate CRASH (thrown, not a finding) fails OPEN — same discipline
 * as the per-chunk build-exec gate — so an infra hiccup can't wedge the build.
 */
export async function reGateMergedTree(input: ReGateInput): Promise<ReGateResult> {
  const { projectDir, signal, totalChunks, waveIndex, lastChunkNumber, chunksCommitted, emit, events, outcomes } = input;
  if (signal?.aborted) return { kind: "ok" };

  let finding: Awaited<ReturnType<typeof runBuildExecGate>> = null;
  try {
    finding = await runBuildExecGate({ projectDir, signal });
  } catch (err) {
    // Fail OPEN but LOUD. A gate INFRA crash (a thrown exception — NOT a normal
    // build failure, which returns a finding and correctly halts above) must not
    // wedge an otherwise-good build (same discipline as the per-chunk gate). But
    // this is the last line of defense against semantic corruption, so we do NOT
    // swallow it silently: surface a warning that the integration gate did not
    // run and the merged tree is UNVERIFIED so the user knows to check manually.
    // No appendHalt — we still proceed. Mirrors warnFootprintEscapes' surfacing.
    const msg = (err as Error)?.message ?? String(err);
    emit({
      type: "review-result",
      chunkNumber: lastChunkNumber,
      totalChunks,
      message:
        `WARNING: integration re-gate could NOT run after wave ${waveIndex + 1} (gate crashed: ${msg.slice(0, 200)}) — ` +
        `the merged tree is UNVERIFIED. The build PROCEEDS (a gate infra crash must not wedge it), but verify the ` +
        `combined result manually: a semantic break in this wave's merge would NOT have been caught.`,
      data: { regateCrashed: true, error: msg.slice(0, 200) },
    });
    finding = null;
  }
  if (!finding) return { kind: "ok" };

  const waveLabel = waveIndex + 1;
  const reason =
    `Integration re-gate FAILED after wave ${waveLabel} merged — the combined tree (this wave's chunks merged ` +
    `together on base) builds/tests/smokes NON-ZERO even though every chunk passed in isolation. This is the ` +
    `textually-clean-but-semantically-broken merge S4 exists to catch. Build HALTED before wave ${waveLabel + 1} ` +
    `is dispatched; NOT auto-fixed. Gate: ${finding.reasoning}`;
  emit({ type: "halt", chunkNumber: lastChunkNumber, totalChunks, message: reason });
  appendHalt(projectDir, { chunk: lastChunkNumber, gate: "integration-regate", reason: reason.slice(0, 200) });
  return {
    kind: "halt",
    result: { status: "halted", lastChunk: lastChunkNumber, chunksCommitted, haltReason: reason, outcomes, events },
  };
}

/**
 * Footprint-subset DIAGNOSTIC for one just-merged chunk. Compares the chunk's
 * ACTUAL changed files (ChunkReport.changed) against its DECLARED footprint via
 * the conflict-graph's footprintEscapes (S2's exact path matching). If any
 * changed file escaped the declared footprint, emit a WARNING on the events
 * stream — NOT a halt. A chunk with an undeclared/empty footprint (serialized
 * alone by the conservative rule) never warns; footprintEscapes handles that.
 */
export function warnFootprintEscapes(args: {
  chunk: ParsedChunk;
  changed: string[];
  totalChunks: number;
  emit: EmitFn;
}): void {
  const escapes = footprintEscapes(args.chunk.footprint, args.changed);
  if (escapes.length === 0) return;
  args.emit({
    type: "review-result",
    chunkNumber: args.chunk.number,
    totalChunks: args.totalChunks,
    message:
      `WARNING: chunk ${args.chunk.number} changed ${escapes.length} file(s) OUTSIDE its declared footprint ` +
      `(${escapes.join(", ")}). The conflict-graph parallelized it against its siblings assuming disjoint ` +
      `footprints — an undeclared edit is how a real parallel conflict sneaks in. The plan under-declared this ` +
      `chunk's Files; the re-gate build catches an actual break, this flags the latent cause so the plan improves.`,
    data: { footprintEscape: escapes, declared: args.chunk.footprint ?? [] },
  });
}
