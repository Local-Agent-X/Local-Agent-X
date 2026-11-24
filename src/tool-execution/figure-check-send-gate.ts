/**
 * A deliverable whose figures are still being checked, or did not match their
 * sources and could not be corrected, does not leave the machine without the
 * user's yes. The figures check (canonical-loop/figure-check-note.ts) now runs
 * before a turn says it is done, but a send can still land while one runs (a
 * build and an email in the same breath, or a check past its wait), and a
 * deck emailed then is beyond any later correction (2026-11-24).
 *
 * One of the gates that ask instead of refuse (ask-user-gates.ts): attended,
 * the approval card says what is unchecked and the user decides; unattended,
 * the call is parked for them, never sent. Which calls are sends and what
 * files they attach are the private-content gate's own answers (sendsOffBox,
 * egressPayload's attachmentPaths), so the two cannot disagree about a send.
 */
import { basename } from "node:path";
import { figureCheckOf } from "../canonical-loop/public/verification-pass.js";
import { resolveAgentPath } from "../workspace/paths.js";
import { addApprovalReason } from "./approval-card-text.js";
import { egressPayload } from "./egress-payload.js";
import { sendsOffBox } from "./private-content-destinations.js";
import type { ToolCallContext } from "./context.js";

export function figureCheckSendGate(ctx: Pick<ToolCallContext, "tc" | "args" | "sessionId" | "policyApprovalReason">): void {
  if (!sendsOffBox(ctx.tc.name)) return;
  const running: string[] = [];
  const wrong: string[] = [];
  for (const raw of egressPayload(ctx.tc.name, ctx.args).attachmentPaths) {
    if (typeof raw !== "string" || !raw) continue;
    const state = figureCheckOf(resolveAgentPath(raw, ctx.sessionId || "default"));
    if (state === "checking" || state === "correcting") running.push(basename(raw));
    else if (state === "mismatch") wrong.push(basename(raw));
  }
  if (running.length === 0 && wrong.length === 0) return;
  const parts = [
    running.length ? `the figures in ${running.join(", ")} are still being checked against their sources` : "",
    wrong.length ? `${wrong.join(", ")} ${wrong.length === 1 ? "has" : "have"} figures that don't match their sources and weren't corrected` : "",
  ].filter(Boolean);
  const what = parts.join("; ");
  addApprovalReason(ctx, `Send it anyway? ${what[0].toUpperCase()}${what.slice(1)}. Once it is sent, a later correction cannot reach the copy that went out.`);
}
