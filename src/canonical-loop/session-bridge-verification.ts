/**
 * What the user and the agent see of the verification tier — which is
 * almost nothing. A verification pass and the correction that may follow it
 * are the harness checking and fixing its own work, so neither is a worker in
 * front of the user: no AGENTS card, no progress line, no inbox item, no "that
 * op just finished". session-bridge-observer.ts routes both op types here
 * instead of through its worker surfaces.
 *
 * What does come out is one note on the reply whose deliverables were
 * checked (figure-check-note.ts), saved with the chat and updated in place:
 *   - a DISCREPANCIES verdict marks it "correcting" and submits a correction
 *     (verification-correct.ts); if none can be submitted, the note says the
 *     figures do not match and asks, and the agent gets a rework instruction
 *     (the pending notification carries the verifier's table);
 *   - a finished correction marks it "corrected", and tells the agent so it
 *     can say what changed if asked;
 *   - a correction that did not finish falls back to the rework instruction;
 *   - a confirmed pass marks it "match"; an unverifiable, stopped or failed
 *     one, "couldn't check".
 * The agent's notifications are marked as already told, so it does not
 * announce them again, and no separate idle-time chat line is posted.
 */
import { getTaskForOp, proactiveSpeakToSession, releaseOpFromSession } from "../ops/session-bridge.js";
import { pushPendingNotification } from "../ops/pending-notifications.js";
import { figureCheckUpdate } from "./figure-check-note.js";
import { resolveTerminalOpStatus } from "./checkpoint-stop.js";
import { extractFinalAssistantText, verificationReport } from "./session-bridge-extractors.js";
import { attemptDeliverableCorrection, correctedCount, correctionContextOf } from "./verification-correct.js";
import { figureBatchEnded, type FigureCheckOutcome } from "./figure-check-run.js";
import { followCorrection } from "./figure-check-ledger.js";
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
  const verdict = verificationReport(summary).verdict;
  logger.info(`verification pass ${event.opId} ended ${to}${verdict ? ` (${verdict})` : ""}`);
  // A pass of a run of several (figure-check-run.ts) waits for the others;
  // the run's outcome is settled once, when the last one ends.
  void figureBatchEnded(event.opId, summary).then((ended) => {
    if (ended === "pending") return;
    settleFigureCheck(sessionId, task, ended === "not-a-run" ? singlePass(event.opId, summary) : ended);
  }).catch((e) => {
    logger.warn(`figures check for ${sessionId} could not settle: ${(e as Error).message}`);
    figureCheckUpdate(sessionId, "unchecked");
  });
}

/** A pass that is not part of a run: its own verdict is the outcome. */
function singlePass(opId: string, summary: string): FigureCheckOutcome {
  const r = verificationReport(summary);
  return {
    verdict: r.verdict, table: summary, checked: r.checked, mismatched: r.mismatched,
    ...(r.verdict === "DISCREPANCIES" ? { discrepantOpId: opId } : {}), discrepantFiles: [],
  };
}

function settleFigureCheck(sessionId: string, task: string, o: FigureCheckOutcome): void {
  if (o.verdict !== "DISCREPANCIES" || !o.discrepantOpId) {
    figureCheckUpdate(sessionId, o.verdict === "CONFIRMED" ? "confirmed" : "unchecked", 0, o.coverage);
    return;
  }
  const opId = o.discrepantOpId;
  logger.info(`figures check for ${sessionId}: discrepancies on ${o.mismatched} of ${o.checked} values — correcting`);
  figureCheckUpdate(sessionId, "correcting", o.mismatched, o.coverage);
  void attemptDeliverableCorrection({
    verificationOpId: opId, sessionId, verdictText: o.table, mismatched: o.mismatched, checked: o.checked,
    ...(o.discrepantFiles.length ? { deliverables: o.discrepantFiles } : {}),
  }).then((submitted) => {
    if (!submitted) surfaceRework(sessionId, opId, task, o.table, o.mismatched, o.checked);
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
  // What the correction says it changed, not that it stopped: a run that ends
  // COULD NOT CORRECT also ends "succeeded".
  const corrected = Math.min(correctedCount(summary), mismatched || Infinity);
  if (corrected === 0) {
    surfaceRework(sessionId, event.opId, task, `${summary}\n\n${context?.table ?? ""}`.trim(), mismatched, checked);
    return;
  }
  if (mismatched && corrected < mismatched) {
    surfaceRework(sessionId, event.opId, task, `${summary}\n\n${context?.table ?? ""}`.trim(), mismatched - corrected, checked);
    return;
  }
  // The user's record is the note on the reply; the agent's is the pending
  // notification, marked as already told so it does not announce it again.
  pushPendingNotification(sessionId, {
    opId: event.opId, status: "completed", summary, filesChanged: [], task, completedAt: Date.now(),
    verification: { mismatched, checked, corrected: true }, surfacedViaNudge: true,
  });
  // The correction's own edit: what the check recorded per figure carries over.
  for (const path of context?.deliverables ?? []) {
    try { followCorrection(path); } catch (e) { logger.warn(`could not carry the figures record over the correction of ${path}: ${(e as Error).message}`); }
  }
  figureCheckUpdate(sessionId, "corrected", corrected);
  proactiveSpeakToSession(sessionId, `Verification finished: I corrected ${corrected} value${corrected === 1 ? "" : "s"} that did not match their sources.`);
}

/** The agent corrects it on its next turn if asked; the note on the reply asks the user. */
function surfaceRework(sessionId: string, opId: string, task: string, table: string, mismatched: number, checked: number): void {
  pushPendingNotification(sessionId, {
    opId, status: "completed", summary: table, filesChanged: [], task, completedAt: Date.now(),
    verification: { mismatched, checked, corrected: false }, surfacedViaNudge: true,
  });
  figureCheckUpdate(sessionId, "mismatch", mismatched);
  proactiveSpeakToSession(sessionId, `Verification finished: ${mismatched} value${mismatched === 1 ? "" : "s"} did not match their sources and could not be corrected automatically.`);
}
