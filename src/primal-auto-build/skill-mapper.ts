/**
 * Skill mapping + per-chunk prompt assembly.
 *
 * Class → skill:
 *   trunk → /senior-engineer
 *   leaf  → /vibe-code
 *   mixed → /senior-engineer  (handles UI fine, just with more rigor;
 *                              cheaper than splitting into two sessions)
 *
 * Prompt assembly: the spawned subprocess starts cold. The prompt is the
 * ONLY thing it sees. It must include:
 *   - The skill invocation (/senior-engineer or /vibe-code)
 *   - The chunk slice + done-when verbatim from the plan
 *   - The discipline anchor: "Read spec/ only. Do not read scenarios/
 *     or twins/." This protects the holdout.
 *   - Any sharpened context that prior chunks taught us (passed in by
 *     the loop — chunk 5 wires this).
 *   - The expected report format the review pass parses.
 */

import type { ParsedChunk } from "./plan-parser.js";
import { loadSkillBody } from "./skill-bodies.js";

export type Skill = "senior-engineer" | "vibe-code";

export function chunkSkill(klass: ParsedChunk["klass"]): Skill {
  switch (klass) {
    case "leaf": return "vibe-code";
    case "trunk":
    case "mixed":
      return "senior-engineer";
  }
}

export interface BuildChunkPromptOptions {
  chunk: ParsedChunk;
  /** Total chunk count for the "chunk N of T" framing. */
  totalChunks: number;
  /** Absolute path to spec/plan.md inside the project. */
  planPath: string;
  /**
   * Sharpened context from prior chunks' learnings — passed in by the
   * loop layer (chunk 5). Empty on first pass. Format: free-form
   * markdown that gets inserted before the standard discipline block.
   */
  sharpenedContext?: string;
  /**
   * Optional retry framing. When the review pass push-backs a chunk,
   * the loop fires a second subprocess with this set to the review
   * pass's reasoning (e.g. "your done-when claimed X but the report
   * shows Y — fix X without changing the rest").
   */
  retryReason?: string;
}

export function buildChunkPrompt(opts: BuildChunkPromptOptions): string {
  const { chunk, totalChunks, planPath, sharpenedContext, retryReason } = opts;
  const skill = chunkSkill(chunk.klass);
  const dependsOnLine = chunk.dependsOn.length > 0
    ? `Depends on: chunks ${chunk.dependsOn.join(", ")} (assumed already implemented in the working tree).`
    : `Depends on: nothing — this is a foundation chunk.`;

  const scenariosLine = chunk.scenarios && chunk.scenarios !== "—"
    ? `Scenarios this chunk touches: ${chunk.scenarios}. (Do NOT read scenarios/ files — they are the held-out test set.)`
    : `Scenarios this chunk touches: none.`;

  const sharpenedBlock = sharpenedContext && sharpenedContext.trim()
    ? `## Sharpened context from earlier chunks\n\n${sharpenedContext.trim()}\n\n`
    : "";

  const retryBlock = retryReason && retryReason.trim()
    ? `## Retry — prior attempt was rejected\n\n` +
      `The previous subprocess on this chunk reported done but the review pass rejected it for the following reason:\n\n` +
      `> ${retryReason.trim().replace(/\n/g, "\n> ")}\n\n` +
      `Address ONLY the gap the reviewer named. Do not refactor unrelated code, do not re-implement parts that already work.\n\n`
    : "";

  // Inline the skill's methodology body so workers don't depend on the
  // operator having `~/.claude/skills/` populated. Body is bundled in
  // `src/skills/<skill>/SKILL.md`. See skill-bodies.ts.
  const skillBody = loadSkillBody(skill);

  return (
    `# Worker methodology — /${skill}\n\n` +
    `The following is the load-bearing methodology this chunk inherits. ` +
    `Read it before you touch code; it's the discipline the review pass enforces against.\n\n` +
    `---\n\n${skillBody}\n\n---\n\n` +
    `# Chunk assignment\n\n` +
    `You are implementing chunk ${chunk.number} of ${totalChunks} from the build plan at ${planPath}.\n\n` +
    `## Chunk\n\n` +
    `**Title:** ${chunk.title}\n` +
    `**Phase:** ${chunk.phase || "(unphased)"}\n` +
    `**Class:** ${chunk.klass} → /${skill}\n` +
    `${dependsOnLine}\n` +
    `${scenariosLine}\n\n` +
    `**Slice:** ${chunk.slice}\n\n` +
    `**Done when:**\n${chunk.doneWhen}\n\n` +
    sharpenedBlock +
    retryBlock +
    `## Discipline (load-bearing — do not skip)\n\n` +
    `- **You are a non-interactive subprocess.** No human is watching this session. ` +
    `Don't pause to ask, don't request a planning conversation, don't wait for confirmation. ` +
    `If you'd normally ask the user a question, surface it in the final report's NOTE field ` +
    `(reviewer will route it) and ship the safest available choice in the meantime.\n` +
    `- **Read \`spec/\` only.** Do not read \`scenarios/\` or \`twins/\`. ` +
    `Those are the held-out test set; reading them is teaching-to-the-test and invalidates the build.\n` +
    `- **Code matches spec, never the reverse.** If the spec is unclear, STOP and surface the ambiguity in your final report rather than guessing. ` +
    `Do not weaken the done-when criteria to fit your implementation.\n` +
    `- **Minimum change.** Implement what this chunk's slice + done-when require. ` +
    `Do not refactor neighbors, do not add unrelated abstractions, do not chase improvements that aren't in scope.\n` +
    `- **Run the tests.** If the chunk's done-when names tests, those tests must pass before you report done. ` +
    `Do not mark a deferred verification as "done" — name it explicitly in your report's NOTE so the review pass can route it to launch-readiness.\n` +
    `- **Don't touch \`spec/\`.** Spec amendments are the reviewer's job; if you find a gap, surface it in NOTE, don't edit the spec yourself.\n\n` +
    `## Report format (the review pass parses this — keep it exact)\n\n` +
    `When you finish, reply with EXACTLY this block (no other text after it):\n\n` +
    `STATUS: done | blocked | partial\n` +
    `DONE_WHEN: met | deferred-to-launch-readiness | unmet\n` +
    `CHANGED: <comma-separated file paths>\n` +
    `TESTS: <pass-count>/<total-count> | n/a\n` +
    `NEW_FAILURES: <test names introduced by this chunk, or none>\n` +
    `PRE_EXISTING_FAILURES: <test names that already failed before this chunk, or none>\n` +
    `SPEC_GAPS: <constraints you found missing that should be added to spec, or none>\n` +
    `LAUNCH_READINESS: <items requiring real third-party creds / HTTPS / prod data, or none — each item must have "how to verify" steps>\n` +
    `NOTE: <anything the user needs to know>`
  );
}
