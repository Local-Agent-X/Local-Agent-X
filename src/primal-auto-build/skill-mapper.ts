/**
 * Skill mapping + per-chunk task assembly.
 *
 * Class → skill:
 *   trunk → /senior-engineer
 *   leaf  → /vibe-code
 *   mixed → /senior-engineer  (handles UI fine, just with more rigor;
 *                              cheaper than splitting into two sessions)
 *
 * NOTE on architecture: the methodology body + chunk-runner discipline
 * + report format used to live in this builder's output. After the
 * canonical-agent migration, they live in the AgentDefinition's
 * systemPrompt (see src/primal-auto-build/agents/chunk-runner.ts). This
 * builder now produces ONLY the chunk-specific task text — the part
 * that varies per-invocation.
 */

import type { ParsedChunk } from "./plan-parser.js";
import type { ChunkAgentRole } from "./agents/chunk-runner.js";

export type Skill = "senior-engineer" | "vibe-code";

export function chunkSkill(klass: ParsedChunk["klass"]): Skill {
  switch (klass) {
    case "leaf": return "vibe-code";
    case "trunk":
    case "mixed":
      return "senior-engineer";
  }
}

export function chunkAgentRole(klass: ParsedChunk["klass"]): ChunkAgentRole {
  return klass === "leaf" ? "chunk-runner-leaf" : "chunk-runner-trunk";
}

export interface BuildChunkTaskOptions {
  chunk: ParsedChunk;
  /** Total chunk count for the "chunk N of T" framing. */
  totalChunks: number;
  /** Absolute path to spec/plan.md inside the project. */
  planPath: string;
  /** Sharpened context from prior chunks' learnings. */
  sharpenedContext?: string;
  /** Optional retry framing when the prior worker was push-backed. */
  retryReason?: string;
}

/**
 * Build the per-chunk TASK text — what varies per call. The agent's
 * methodology + discipline + report format live in the AgentDefinition's
 * systemPrompt (chunk-runner.ts) and don't repeat here.
 */
export function buildChunkTask(opts: BuildChunkTaskOptions): string {
  const { chunk, totalChunks, planPath, sharpenedContext, retryReason } = opts;
  const skill = chunkSkill(chunk.klass);

  const dependsOnLine = chunk.dependsOn.length > 0
    ? `Depends on: chunks ${chunk.dependsOn.join(", ")} (assumed already implemented in the working tree).`
    : `Depends on: nothing — this is a foundation chunk.`;

  const scenariosLine = chunk.scenarios && chunk.scenarios !== "—"
    ? `Scenarios this chunk touches: ${chunk.scenarios}. (Do NOT read scenarios/ files — held-out test set.)`
    : `Scenarios this chunk touches: none.`;

  const sharpenedBlock = sharpenedContext && sharpenedContext.trim()
    ? `\n## Sharpened context from earlier chunks\n\n${sharpenedContext.trim()}\n`
    : "";

  const retryBlock = retryReason && retryReason.trim()
    ? `\n## Retry — prior attempt was rejected\n\n` +
      `The previous worker on this chunk reported done but the review pass rejected it:\n\n` +
      `> ${retryReason.trim().replace(/\n/g, "\n> ")}\n\n` +
      `Address ONLY the gap the reviewer named. Do not refactor unrelated code.\n`
    : "";

  return (
    `Implement chunk ${chunk.number} of ${totalChunks} from the build plan at ${planPath}.\n\n` +
    `**Title:** ${chunk.title}\n` +
    `**Phase:** ${chunk.phase || "(unphased)"}\n` +
    `**Class:** ${chunk.klass} → /${skill}\n` +
    `${dependsOnLine}\n` +
    `${scenariosLine}\n\n` +
    `**Slice:** ${chunk.slice}\n\n` +
    `**Done when:**\n${chunk.doneWhen}\n` +
    sharpenedBlock +
    retryBlock
  );
}
