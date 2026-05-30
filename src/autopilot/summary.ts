/**
 * End-of-shift summary for an autopilot run.
 *
 * Aggregates per-round results into a user-facing report and a structured
 * AutopilotRunSummary returned by the API. The pretty rendering is what the
 * chat agent surfaces back to the user.
 */

import type {
  AutopilotConfig,
  AutopilotRunSummary,
  AutopilotState,
  BootProof,
  RoundResult,
} from "./types.js";

export interface BuildSummaryInput {
  opId: string;
  state: AutopilotState;
  config: AutopilotConfig;
  rounds: RoundResult[];
  startedAt: string;
  selfEditCalls: number;
  /** End-of-shift bind+smoke verdict, if the boot proof ran. */
  bootProof?: BootProof;
}

export function buildRunSummary(input: BuildSummaryInput): AutopilotRunSummary {
  const finishedAt = new Date().toISOString();
  const startMs = new Date(input.startedAt).getTime();
  const finishMs = new Date(finishedAt).getTime();

  const passed = input.rounds.filter(r => r.outcome === "passed");
  const noop = input.rounds.filter(r => r.outcome === "noop");
  const failed = input.rounds.filter(r => r.outcome.startsWith("failed-") || r.outcome === "agent-error");

  // Aggregate file changes from PASSED rounds only — failed rounds were reverted.
  const inScopeSet = new Set<string>();
  const outOfScopeSet = new Set<string>();
  for (const r of passed) {
    for (const f of r.filesInScope) inScopeSet.add(f);
    for (const f of r.filesOutOfScope) outOfScopeSet.add(f);
  }

  // Build status: did the most recent passed round have a passing build?
  // (validateRound only returns "passed" if build passed, so any passed round = green.)
  const buildStatus: "passing" | "failing" | "skipped" =
    input.config.buildCommand === null ? "skipped"
    : passed.length > 0 ? "passing"
    : (input.rounds.some(r => r.outcome === "failed-build") ? "failing" : "skipped");

  return {
    opId: input.opId,
    state: input.state,
    topic: input.config.topic,
    scope: input.config.scope,
    startedAt: input.startedAt,
    finishedAt,
    durationMs: finishMs - startMs,
    totalRounds: input.rounds.length,
    passedRounds: passed.length,
    noopRounds: noop.length,
    failedRounds: failed.length,
    selfEditCalls: input.selfEditCalls,
    branchName: input.config.branchName,
    baseBranch: input.config.baseBranch,
    filesChangedInScope: [...inScopeSet],
    filesChangedOutOfScope: [...outOfScopeSet],
    buildStatus,
    bootProof: input.bootProof,
    rounds: input.rounds,
  };
}

/** Render an AutopilotRunSummary as the chat-agent-facing markdown summary. */
export function renderSummaryMarkdown(summary: AutopilotRunSummary): string {
  const minutes = Math.round(summary.durationMs / 60_000);
  const stateLabel: Record<AutopilotState, string> = {
    "running": "Still running",
    "completed": `Complete (agent self-terminated)`,
    "deadline": "Stopped (time budget)",
    "max-rounds": "Stopped (max rounds)",
    "no-progress": "Stopped (no-op rounds)",
    "interrupted": "Stopped (user interrupt)",
    "error": "Stopped (error)",
  };

  const roundLines = summary.rounds.map(r => {
    const icon = r.outcome === "passed" ? "[OK]"
      : r.outcome === "noop" ? "[--]"
      : "[XX]";
    return `  ${r.round}. ${icon} ${r.summary.split("\n")[0].slice(0, 80)}`;
  }).join("\n");

  const inScope = summary.filesChangedInScope.length > 0 ? summary.filesChangedInScope.join(", ") : "(none)";
  const outOfScope = summary.filesChangedOutOfScope.length > 0 ? summary.filesChangedOutOfScope.join(", ") : "(none)";

  // Boot proof: explicit signal so the human merging knows whether the
  // committed code actually boots. "not run" is honest about the gap rather
  // than implying a green boot when none happened.
  const bp = summary.bootProof;
  const bootLine = bp
    ? `**Boot proof:** ${bp.status === "passed" ? "✅ passed" : "❌ FAILED"} — ${bp.detail}`
    : `**Boot proof:** not run (no committed rounds, build disabled, or run interrupted)`;

  return [
    `## Autopilot ${stateLabel[summary.state]} (${summary.totalRounds} rounds, ${minutes}m)`,
    `**Branch:** \`${summary.branchName}\``,
    ``,
    `**Topic:** ${summary.topic}`,
    ``,
    `**Rounds:**`,
    roundLines || "  (no rounds)",
    ``,
    `**Files changed (in scope):** ${inScope}`,
    `**Files changed (out of scope):** ${outOfScope}`,
    `**Build:** ${summary.buildStatus}  |  **self_edit calls:** ${summary.selfEditCalls}`,
    bootLine,
    ``,
    `**Review:** \`git diff ${summary.baseBranch}...${summary.branchName}\``,
    `**Merge:** \`git checkout ${summary.baseBranch} && git merge ${summary.branchName}\``,
  ].join("\n");
}
