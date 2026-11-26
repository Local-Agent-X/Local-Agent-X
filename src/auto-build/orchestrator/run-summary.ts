/**
 * What a build run ended with, for the chat's summary card (bg_op_completed
 * with metadata.kind = "build-run-summary"): its state, each chunk's verdict,
 * and the files it changed.
 */
import type { LoopResult } from "../loop.js";
import { chunkJudgingSummary } from "../chunk-review/chunk-verdict.js";
import type { OrchestratorState } from "./state.js";

export function buildSummaryText(s: OrchestratorState, result: LoopResult): string {
  const lines: string[] = [];
  lines.push(`Status: ${s.phase}`);
  lines.push(`Chunks: ${s.chunksCommitted}/${s.totalChunks} committed (last: chunk ${s.currentChunk})`);
  if (s.haltReason) lines.push(`Halt reason: ${s.haltReason}`);
  if (s.phase === "halted") {
    lines.push(`Resume with: build_plan_resume({project_dir: "${s.projectDir.replace(/\\/g, "/")}"})`);
  } else if (s.phase === "complete") {
    lines.push(`Build complete. Review LAUNCH_READINESS.md before deploying.`);
    if (result.openItems?.length) lines.push(``, `Open after the finish checks:`, ...result.openItems.map((item) => `  - ${item}`));
  }
  if (result.outcomes.length > 0) {
    lines.push(``);
    lines.push(`Per-chunk verdicts:`);
    for (const o of result.outcomes) {
      const judged = o.outcome.judging ? ` — ${chunkJudgingSummary(o.outcome.judging)}` : "";
      const unverified = o.outcome.unverified ? ` — unverified: ${o.outcome.unverified}` : "";
      lines.push(`  chunk ${o.chunkNumber}: ${o.action}${judged}${unverified}`);
    }
  }
  return lines.join("\n");
}

export function buildSummaryMetadata(s: OrchestratorState, result: LoopResult): Record<string, unknown> {
  return {
    kind: "build-run-summary",
    project_dir: s.projectDir,
    project_name: s.projectDir.split(/[\\/]/).pop() || "project",
    phase: s.phase,
    chunks_committed: s.chunksCommitted,
    total_chunks: s.totalChunks,
    current_chunk: s.currentChunk,
    resume_at_chunk: s.resumeAtChunk,
    halt_gate: s.haltGate,
    halt_reason: s.haltReason,
    started_at: s.startedAt,
    updated_at: s.updatedAt,
    completed_at: s.completedAt,
    resumable: s.phase === "halted" || s.phase === "abandoned" || s.phase === "paused",
    per_chunk_verdicts: result.outcomes.map(o => ({ chunk: o.chunkNumber, action: o.action })),
  };
}

export function collectChangedFiles(result: LoopResult): string[] {
  const set = new Set<string>();
  for (const o of result.outcomes) {
    for (const f of o.outcome.report.changed) set.add(f);
  }
  return Array.from(set);
}
