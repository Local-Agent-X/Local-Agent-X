/**
 * AUTOPILOT_NUDGE — system prompt for each round agent.
 *
 * Tells the agent: you're in autopilot mode, here's the topic, here's the
 * scope hint (NOT enforcement), here's how much budget remains, and here's
 * how to bow out cleanly when there's nothing useful left to do.
 */

import type { AutopilotConfig } from "./types.js";

export interface NudgeContext {
  config: AutopilotConfig;
  /** 1-indexed round number we're about to start. */
  round: number;
  /** Time remaining in ms. */
  timeRemainingMs: number;
  /** Rounds completed so far. */
  roundsCompleted: number;
  /** Self-edit calls used so far. */
  selfEditUsed: number;
  /** Last round's outcome + summary, if any. */
  lastRound?: { outcome: string; summary: string; buildError?: string };
}

export function buildAutopilotNudge(ctx: NudgeContext): string {
  const { config, round, timeRemainingMs, roundsCompleted, selfEditUsed, lastRound } = ctx;
  const minsLeft = Math.max(0, Math.round(timeRemainingMs / 60_000));
  const scopeBlock = config.scope.length > 0
    ? `\n## Primary focus\n${config.scope.map(s => `  - ${s}`).join("\n")}\n\nYou MAY touch related files if needed for the fix to actually work — but every change must be a real improvement, not refactoring for its own sake.`
    : "";

  const lastRoundBlock = lastRound
    ? `\n## Previous round (round ${roundsCompleted})\nOutcome: ${lastRound.outcome}\nSummary: ${lastRound.summary}${lastRound.buildError ? `\n\nBUILD ERROR (you must fix this round):\n\`\`\`\n${lastRound.buildError.slice(0, 1500)}\n\`\`\`` : ""}\n`
    : "";

  return `You are in AUTOPILOT mode.

## Your topic
${config.topic}
${scopeBlock}
${lastRoundBlock}
## Budget
- Round ${round} of max ${config.maxRounds}
- Time remaining: ~${minsLeft} min
- self_edit calls used: ${selfEditUsed} / ${config.maxSelfEditCalls}
- Rounds completed: ${roundsCompleted}

## Your job this round
Find the next highest-impact improvement related to the topic and ship it. ONE focused change per round — don't try to do everything at once.

The system will validate your work after this round:
1. \`git status\` — empty diff = no-op round (don't burn rounds doing nothing)
2. \`${config.buildCommand || "npm run build"}\` — build must pass; if it fails, your changes are reverted and you'll see the error next round
3. File-size delta — don't push any file FROM ≤${config.fileSizeLimit} LOC TO >${config.fileSizeLimit}; existing larger files are fine to edit
${config.withTests ? `4. \`${config.testCommand}\` — tests must pass\n` : ""}

Use the read/edit/write/bash/grep/glob tools directly. self_edit is also available for harder edits but counts toward your ceiling.

## When to stop
If you find nothing useful left to do (tried everything sensible, or further changes would be over-engineering), reply EXACTLY this on its own line:

  AUTOPILOT_DONE: <one-line reason>

…and the system will end the run cleanly. Don't keep editing for the sake of editing.

## What NOT to do
- Don't restate the plan — act.
- Don't ask the user for approval — you have it.
- Don't try to commit or push — the system handles round-commits after validation.
- Don't edit files outside the worktree — your tools are scoped to the worktree path automatically.`;
}
