/**
 * Auto-fix push-back for scenario failures.
 *
 * When a phase-gate scoring run produces score < threshold on any
 * scenario, this module dispatches a fix-worker via the canonical
 * agent path (the "scenario-fix" role). The role's systemPrompt is
 * the source of truth for scenario-fix constraints (no spec touch, no
 * test bypass, no silent fallback, don't break passing scenarios).
 *
 * After the worker returns, the caller re-runs scoring; if still
 * failing, the loop halts.
 */

import type { ParsedChunk } from "../plan-parser.js";
import type { ScoreReport } from "./types.js";
import { runChunkAgent } from "../agents/chunk-runner.js";
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
  parentSessionId?: string;
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
  const task = buildFixTask(opts.chunk, opts.failedReports, opts.allReports);

  const result = await runChunkAgent({
    role: "scenario-fix",
    task,
    timeoutMs: opts.subprocessTimeoutMs,
    signal: opts.signal,
    parentSessionId: opts.parentSessionId,
  });

  const durationMs = Date.now() - startedAt;
  if (result.exitCode !== 0 && !result.stdout.trim()) {
    return {
      workerCompleted: false,
      workerReport: result.error || "(no output)",
      durationMs,
      fixSha: null,
      error: `fix worker exited with code ${result.exitCode}${result.error ? `: ${result.error}` : ""}`,
    };
  }

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

function buildFixTask(chunk: ParsedChunk, failed: ScoreReport[], all: ScoreReport[]): string {
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

  const passing = all.filter(r => r.passed);
  const passingBlock = passing.length > 0
    ? `\n\n## Scenarios that DID pass (do not break these)\n${passing.map(r => `  - ${r.scenarioTitle} (${r.score}/10)`).join("\n")}`
    : "";

  return (
    `Fix scenario failures that surfaced after chunk ${chunk.number} (${chunk.title}) shipped. ` +
    `The build is paused at a phase-verification gate; if your fix recovers the failing scenarios, ` +
    `the loop continues. If you can't recover them without violating spec/constitution, halt by ` +
    `reporting STATUS: blocked.\n\n` +
    `## Failing scenarios\n\n${failureBlocks}${passingBlock}`
  );
}
