/**
 * Auto-fix push-back for scenario failures.
 *
 * When a phase-gate scoring run produces score < threshold on any
 * scenario, this module spawns a fix-worker subprocess with the failure
 * details + the constraint that it CANNOT weaken spec or constitution
 * to make the scenario pass. After the worker returns, the caller
 * re-runs scoring; if still failing, the loop halts.
 *
 * Reuses the existing worker-spawn primitive — same skill body inlined,
 * same provider routing, same subprocess discipline. The ONLY thing
 * different is the prompt framing: "fix THIS failure" rather than
 * "implement chunk N".
 *
 * Spec safety: the prompt explicitly forbids touching spec/ and tells
 * the worker that if it would need to weaken spec/constitution to pass
 * the scenario, it must HALT instead. The existing additive-diff gate
 * is the backstop — if the worker amends spec anyway, the gate catches
 * the weakening on commit.
 */

import type { ParsedChunk } from "../plan-parser.js";
import type { ScoreReport } from "./types.js";
import { spawnClaudeChunkSubprocess } from "../subprocess.js";
import { loadSkillBody } from "../skill-bodies.js";
import { gitAdd } from "../git-helpers.js";
import { commitChunk } from "../loop-effects.js";

export interface AutoFixOptions {
  projectDir: string;
  chunk: ParsedChunk;
  failedReports: ScoreReport[];
  /** All score reports including passing ones — useful context for the fix worker. */
  allReports: ScoreReport[];
  signal?: AbortSignal;
  subprocessTimeoutMs?: number;
}

export interface AutoFixResult {
  /** Did the fix worker complete and produce a report? */
  workerCompleted: boolean;
  /** Worker's stdout — the report body. */
  workerReport: string;
  /** Wall-clock duration. */
  durationMs: number;
  /** Commit SHA of the fix landing (when committed). */
  fixSha: string | null;
  /** Any error message that prevented the fix from running. */
  error?: string;
}

export async function runAutoFixWorker(opts: AutoFixOptions): Promise<AutoFixResult> {
  const startedAt = Date.now();
  const prompt = buildFixPrompt(opts.chunk, opts.failedReports, opts.allReports);

  const result = await spawnClaudeChunkSubprocess({
    cwd: opts.projectDir,
    prompt,
    timeoutMs: opts.subprocessTimeoutMs,
    signal: opts.signal,
  });

  const durationMs = Date.now() - startedAt;
  if (result.exitCode !== 0 && !result.stdout.trim()) {
    return {
      workerCompleted: false,
      workerReport: result.stderr || "(no output)",
      durationMs,
      fixSha: null,
      error: `fix worker exited with code ${result.exitCode ?? "killed"}`,
    };
  }

  // Commit whatever the worker changed. Failed scenarios are the trigger
  // even if the worker reports STATUS: blocked — we want the partial
  // attempt in git for diagnosis. The next scoring pass decides whether
  // the fix worked.
  try {
    await gitAdd(opts.projectDir, ".");
    const commit = await commitChunk(opts.projectDir, { ...opts.chunk, title: `${opts.chunk.title} — scenario auto-fix` });
    return {
      workerCompleted: true,
      workerReport: result.stdout,
      durationMs,
      fixSha: commit.committed ? commit.sha : null,
    };
  } catch (e) {
    return {
      workerCompleted: true,
      workerReport: result.stdout,
      durationMs,
      fixSha: null,
      error: `commit failed after fix-worker: ${(e as Error).message}`,
    };
  }
}

function buildFixPrompt(chunk: ParsedChunk, failed: ScoreReport[], all: ScoreReport[]): string {
  const skill = chunk.klass === "leaf" ? "vibe-code" : "senior-engineer";
  const skillBody = loadSkillBody(skill);

  const failureBlocks = failed.map(r => {
    const stepLines = r.steps.filter(s => s.status === "fail" || s.consoleErrors.length > 0 || s.networkFailures.length > 0)
      .slice(0, 6)
      .map(s => `    [${s.index}] ${s.status}: ${s.text}\n      action: ${s.action}\n      outcome: ${s.outcome}${s.consoleErrors.length ? `\n      console: ${s.consoleErrors.slice(0, 2).join(" | ")}` : ""}${s.networkFailures.length ? `\n      network: ${s.networkFailures.slice(0, 2).join(" | ")}` : ""}`)
      .join("\n");
    return (
      `### Failed scenario: ${r.scenarioTitle}\n` +
      `Score: ${r.score}/10\n` +
      `Reasoning: ${r.reasoning}\n` +
      `Failed criteria: ${r.failedCriteria.join("; ") || "(none enumerated)"}\n` +
      `Key step failures:\n${stepLines || "    (no step-level failures captured)"}`
    );
  }).join("\n\n");

  const passingBlock = all.filter(r => r.passed).length > 0
    ? `\n\n## Scenarios that DID pass (do not break these)\n${all.filter(r => r.passed).map(r => `  - ${r.scenarioTitle} (${r.score}/10)`).join("\n")}`
    : "";

  return (
    `# Worker methodology — /${skill}\n\n` +
    `${skillBody}\n\n---\n\n` +
    `# Scenario fix-up task\n\n` +
    `You are NOT implementing a new chunk. You are fixing scenario failures that surfaced after ` +
    `chunk ${chunk.number} (${chunk.title}) shipped. The build is paused at a phase-verification ` +
    `gate; if your fix recovers the failing scenarios, the loop continues. If you can't recover ` +
    `them without violating the spec/constitution, halt by reporting STATUS: blocked.\n\n` +
    `## Failing scenarios\n\n${failureBlocks}${passingBlock}\n\n` +
    `## Load-bearing constraints — DO NOT VIOLATE\n\n` +
    `1. **Code matches spec, never the reverse.** If the scenario fails because the spec is wrong, ` +
    `STOP and report STATUS: blocked with a clear SPEC_GAPS entry naming the constraint that ` +
    `would need to change. The reviewer will decide whether to amend additively.\n` +
    `2. **No spec/ edits.** You may NOT touch any file under spec/. The orchestrator owns spec changes.\n` +
    `3. **No test bypassing.** If a test fails because the code is wrong, fix the code. Do not relax ` +
    `assertions, comment out tests, or stub returns to make a test pass.\n` +
    `4. **No silent fallback.** A scenario failure that's about user-visible behavior (e.g. "page ` +
    `should show stale-data warning") gets a real fix, not a quiet swallow.\n` +
    `5. **Don't break passing scenarios.** The list above is what's currently working. Your fix ` +
    `must keep all of them passing.\n\n` +
    `## Report format — keep it exact\n\n` +
    `STATUS: done | blocked | partial\n` +
    `DONE_WHEN: met | unmet | partially-met\n` +
    `CHANGED: <comma-separated file paths>\n` +
    `TESTS: <pass-count>/<total-count> | n/a\n` +
    `NEW_FAILURES: <test names introduced, or none>\n` +
    `PRE_EXISTING_FAILURES: <test names that already failed before this fix, or none>\n` +
    `SPEC_GAPS: <constraints the spec is missing that prevent a clean fix, or none>\n` +
    `LAUNCH_READINESS: <any new items, or none>\n` +
    `NOTE: <brief explanation of the fix>`
  );
}
