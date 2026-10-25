/**
 * What the user and the agent see of the verification tier — which is
 * almost nothing. A verification pass and the correction that may follow it
 * are the harness checking and fixing its own work, so neither is a worker in
 * front of the user: no AGENTS card, no progress line, no inbox item, no "that
 * op just finished". session-bridge-observer.ts routes both op types here
 * instead of through its worker surfaces.
 *
 * What does come out:
 *   - a DISCREPANCIES verdict submits a correction (verification-correct.ts);
 *     if none can be submitted, the agent gets a rework instruction (the
 *     pending notification carries the verifier's table) and the user one
 *     idle-time line asking whether to go through them;
 *   - a finished correction tells the user, in one idle-time line, that the
 *     figures were corrected, and tells the agent so it can say what changed
 *     if asked;
 *   - a correction that did not finish falls back to the rework instruction;
 *   - a confirmed, unverifiable, stopped or failed pass is logged and nothing
 *     more.
 */
import { getTaskForOp, proactiveSpeakToSession, releaseOpFromSession } from "../ops/session-bridge.js";
import { pushPendingNotification } from "../ops/pending-notifications.js";
import { scheduleIdleNudge } from "../ops/idle-nudge.js";
import { resolveTerminalOpStatus } from "./checkpoint-stop.js";
import { extractFinalAssistantText, verificationReport } from "./session-bridge-extractors.js";
import { attemptDeliverableCorrection, correctionContextOf } from "./verification-correct.js";
import type { CanonicalEvent } from "./types.js";

import { createLogger } from "../logger.js";
const logger = createLogger("canonical-loop.session-bridge-verification");

function terminalOf(event: CanonicalEvent): "succeeded" | "failed" | "cancelled" | null {
  if (event.type !== "state_changed") return null;
  const to = (event.body as Record<string, unknown> | undefined)?.to;
  return to === "succeeded" || to === "failed" || to === "cancelled" ? to : null;
}

export function recordVerificationEvent(event: CanonicalEvent, core: boolean, sessionId: string, op: { task: string }): void {
  const to = terminalOf(event);
  if (!to || !core) return;
  // The task label dies with the session binding: read it before the release.
  const task = getTaskForOp(event.opId) ?? op.task;
  releaseOpFromSession(event.opId);
  const summary = to === "succeeded" ? extractFinalAssistantText(event.opId) : "";
  const report = verificationReport(summary);
  if (report.verdict !== "DISCREPANCIES") {
    logger.info(`verification pass ${event.opId} ended ${to}${report.verdict ? ` (${report.verdict})` : ""} — nothing to surface`);
    return;
  }
  logger.info(`verification pass ${event.opId}: discrepancies on ${report.mismatched} of ${report.checked} values — correcting`);
  void attemptDeliverableCorrection({
    verificationOpId: event.opId, sessionId, verdictText: summary, mismatched: report.mismatched, checked: report.checked,
  }).then((submitted) => {
    if (!submitted) surfaceRework(sessionId, event.opId, task, summary, report.mismatched, report.checked);
  });
}

export function recordCorrectionEvent(event: CanonicalEvent, core: boolean, sessionId: string, op: { task: string }): void {
  const to = terminalOf(event);
  if (!to || !core) return;
  const context = correctionContextOf(event.opId);
  const task = context?.parentTask ?? getTaskForOp(event.opId) ?? op.task;
  releaseOpFromSession(event.opId);
  const mismatched = context?.mismatched ?? 0;
  const checked = context?.checked ?? 0;
  const done = to === "succeeded" && resolveTerminalOpStatus(event.opId, to).status === "completed";
  if (!done) {
    logger.info(`correction ${event.opId} ended ${to} without finishing — the agent is told to correct instead`);
    surfaceRework(sessionId, event.opId, task, context?.table ?? "", mismatched, checked);
    return;
  }
  const summary = extractFinalAssistantText(event.opId);
  logger.info(`correction ${event.opId} finished: ${summary.split("\n")[0]?.slice(0, 120) ?? ""}`);
  pushPendingNotification(sessionId, {
    opId: event.opId, status: "completed", summary, filesChanged: [], task, completedAt: Date.now(),
    verification: { mismatched, checked, corrected: true },
  });
  proactiveSpeakToSession(sessionId, `Verification finished: I corrected ${mismatched} value${mismatched === 1 ? "" : "s"} that did not match their sources.`);
  scheduleIdleNudge(sessionId, task);
}

/** The agent corrects it on its next turn; the user is asked once the chat is idle. */
function surfaceRework(sessionId: string, opId: string, task: string, table: string, mismatched: number, checked: number): void {
  pushPendingNotification(sessionId, {
    opId, status: "completed", summary: table, filesChanged: [], task, completedAt: Date.now(),
    verification: { mismatched, checked, corrected: false },
  });
  proactiveSpeakToSession(sessionId, `Verification finished: ${mismatched} value${mismatched === 1 ? "" : "s"} did not match their sources and could not be corrected automatically.`);
  scheduleIdleNudge(sessionId, task);
}
