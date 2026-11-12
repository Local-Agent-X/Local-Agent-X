/**
 * Recurring problems in Settings → Memory: tool calls that failed the same way
 * in several chats (cognition/cross-session-learning/failure-patterns.ts), and
 * the things a review found the agent could not do with its own tools
 * (capability-gaps.ts), which until now were written and never shown.
 *
 *   GET /api/memory/problems
 */
import type { RouteHandler } from "../server-context.js";
import { jsonResponse } from "../server-utils.js";
import { readToolFailures } from "../tool-execution/tool-usage-telemetry.js";
import {
  failureWindowStart, recurringFailures, FAILURE_WINDOW_DAYS, type FailurePattern,
} from "../cognition/cross-session-learning/failure-patterns.js";
import { readCapabilityGaps, type CapabilityGap } from "../cognition/cross-session-learning/capability-gaps.js";

/** Gaps listed, newest first. */
const MAX_GAPS_SHOWN = 30;

/** What the Settings list shows for one problem: the count, not the run ids. */
export function problemView(p: FailurePattern): Record<string, unknown> {
  return {
    signature: p.signature,
    tool: p.tool,
    action: p.action ?? null,
    status: p.status,
    layer: p.layer ?? null,
    reason: p.reason,
    count: p.count,
    sessions: p.sessions,
    days: p.days,
    firstSeen: p.firstSeen,
    lastSeen: p.lastSeen,
  };
}

function gapView(g: CapabilityGap): Record<string, unknown> {
  return { at: g.timestamp, summary: g.summary, toolsTried: g.toolsTried, workaround: g.workaround ?? null };
}

export const handleMemoryProblemRoutes: RouteHandler = async (method, url, req, res) => {
  if (url.pathname !== "/api/memory/problems") return false;
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);
  if (method !== "GET") { json(405, { error: "GET only" }); return true; }
  try {
    const now = Date.now();
    const problems = recurringFailures(await readToolFailures(failureWindowStart(now)), now);
    const gaps = readCapabilityGaps().slice(-MAX_GAPS_SHOWN).reverse();
    json(200, { windowDays: FAILURE_WINDOW_DAYS, problems: problems.map(problemView), gaps: gaps.map(gapView) });
  } catch {
    json(500, { error: "Recurring problems request failed" });
  }
  return true;
};
