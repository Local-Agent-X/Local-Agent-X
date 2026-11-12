/**
 * Recurring problems in Settings → Memory: tool calls that failed the same way
 * in several chats (cognition/cross-session-learning/failure-patterns.ts), the
 * lessons the failure review wrote for them and the user's answer to each
 * (known-failures.ts), and the things a review found the agent could not do
 * with its own tools (capability-gaps.ts), which until now were written and
 * never shown.
 *
 *   GET  /api/memory/problems
 *   POST /api/memory/problems/:signature/action   { action: "keep" | "discard" }   operator only
 */
import type { RouteHandler } from "../server-context.js";
import { jsonResponse, safeParseBody } from "../server-utils.js";
import { readToolFailures } from "../tool-execution/tool-usage-telemetry.js";
import {
  failureWindowStart, recurringFailures, FAILURE_WINDOW_DAYS, type FailurePattern,
} from "../cognition/cross-session-learning/failure-patterns.js";
import { readCapabilityGaps, type CapabilityGap } from "../cognition/cross-session-learning/capability-gaps.js";
import {
  decideLesson, listKnownFailures, type KnownFailure, type LessonDecision,
} from "../cognition/cross-session-learning/known-failures.js";

/** Gaps listed, newest first. */
const MAX_GAPS_SHOWN = 30;
const SIGNATURE = /^[0-9a-f]{16}$/;

/** What the Settings list shows for one problem: the count, not the run ids,
 *  and what the review made of it when it has looked. */
export function problemView(p: FailurePattern, known: KnownFailure | undefined): Record<string, unknown> {
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
    review: known ? { verdict: known.verdict, why: known.why } : null,
  };
}

/** A lesson, whether or not its failure is still happening: one that has
 *  stopped recurring is the lesson working. */
export function lessonView(k: KnownFailure): Record<string, unknown> {
  return {
    signature: k.signature,
    tool: k.tool,
    action: k.action ?? null,
    reason: k.reason,
    lesson: k.lesson,
    state: k.state,
    sessions: k.sessions,
    reviewedAt: k.reviewedAt,
    shown: k.shown,
    recovered: k.recovered,
  };
}

function gapView(g: CapabilityGap): Record<string, unknown> {
  return { at: g.timestamp, summary: g.summary, toolsTried: g.toolsTried, workaround: g.workaround ?? null };
}

function decisionOf(body: Record<string, unknown> | null): LessonDecision | null {
  return body && (body.action === "keep" || body.action === "discard") ? body.action : null;
}

export const handleMemoryProblemRoutes: RouteHandler = async (method, url, req, res, ctx, requestRole) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  if (url.pathname === "/api/memory/problems") {
    if (method !== "GET") { json(405, { error: "GET only" }); return true; }
    try {
      const now = Date.now();
      const known = listKnownFailures();
      const bySignature = new Map(known.map((k) => [k.signature, k]));
      const problems = recurringFailures(await readToolFailures(failureWindowStart(now)), now);
      const gaps = readCapabilityGaps().slice(-MAX_GAPS_SHOWN).reverse();
      json(200, {
        windowDays: FAILURE_WINDOW_DAYS,
        problems: problems.map((p) => problemView(p, bySignature.get(p.signature))),
        lessons: known.filter((k) => k.verdict === "lesson").reverse().map(lessonView),
        gaps: gaps.map(gapView),
      });
    } catch {
      json(500, { error: "Recurring problems request failed" });
    }
    return true;
  }

  const action = url.pathname.match(/^\/api\/memory\/problems\/([^/]+)\/action$/);
  if (!action) return false;
  if (method !== "POST") { json(405, { error: "POST only" }); return true; }
  if (requestRole !== "operator") { json(403, { error: "Operator role required" }); return true; }
  if (!SIGNATURE.test(action[1])) { json(400, { error: "Invalid problem id" }); return true; }
  let body: Record<string, unknown> | null;
  try { body = await safeParseBody(req); } catch { body = null; }
  const decision = decisionOf(body);
  if (!decision) { json(400, { error: "Invalid action" }); return true; }
  const lesson = decideLesson(action[1], decision);
  if (!lesson) { json(404, { error: "No lesson for that problem" }); return true; }
  ctx.broadcastAll({ type: "settings_changed", settings: { recurringProblems: true } });
  json(200, { lesson: lessonView(lesson) });
  return true;
};
