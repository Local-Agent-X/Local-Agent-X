/**
 * Commit a passed autopilot round inside the worktree.
 *
 * Always uses `git add -A` then `git commit` (not `git commit -am`) so newly
 * created files get included.
 */

import { commitInWorktree } from "../agency/worktree.js";

import { createLogger } from "../logger.js";
const logger = createLogger("autopilot.commit");

export interface RoundCommitInput {
  worktreeName: string;
  round: number;
  topic: string;
  /** Agent's one-line summary, truncated to keep the commit subject readable. */
  agentSummary: string;
}

/** Commit the round. Returns the commit SHA, or null if there was nothing to commit. */
export function commitRound(input: RoundCommitInput): string | null {
  const subject = buildCommitSubject(input.round, input.agentSummary);
  const body = buildCommitBody(input.topic, input.agentSummary);
  const message = `${subject}\n\n${body}`;
  try {
    const sha = commitInWorktree(input.worktreeName, message);
    if (sha) {
      logger.info(`[autopilot.commit] round ${input.round} committed: ${sha.slice(0, 8)}`);
    } else {
      logger.warn(`[autopilot.commit] round ${input.round} had nothing to commit`);
    }
    return sha;
  } catch (e) {
    logger.error(`[autopilot.commit] round ${input.round} commit failed: ${(e as Error).message}`);
    return null;
  }
}

function buildCommitSubject(round: number, agentSummary: string): string {
  // Subject ≤72 chars per git convention. "Autopilot round 12: " is 20 chars,
  // leaving 52 for summary.
  const oneLine = agentSummary.split("\n")[0]?.trim() || "(no summary)";
  const trimmed = oneLine.length > 52 ? oneLine.slice(0, 49) + "..." : oneLine;
  return `Autopilot round ${round}: ${trimmed}`;
}

function buildCommitBody(topic: string, agentSummary: string): string {
  return `Topic: ${topic}\n\nAgent summary:\n${agentSummary}`;
}
