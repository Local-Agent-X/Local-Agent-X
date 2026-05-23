import { createLogger } from "../../../logger.js";
import type { SseSink } from "./types.js";

const logger = createLogger("routes.chat.slash-interceptors");

export interface ApproveResult {
  /** True when the message was a `/approve` and the turn should return. */
  handled: boolean;
}

/**
 * `/approve <reason>` short-circuit. Grants threat-engine consent for
 * this session so the model's NEXT retry of a blocked tool succeeds.
 * Returns inline to the chat, doesn't call the model. Layer B of the
 * threat-engine consent flow. See src/threat/consent-store.ts.
 */
export async function handleApproveCommand(
  message: string,
  sessionId: string,
  sseSink: SseSink,
): Promise<ApproveResult> {
  if (!/^\s*\/approve\b/i.test(message)) return { handled: false };

  const reason = (message.replace(/^\s*\/approve\s*/i, "").trim() || "user-typed-/approve").slice(0, 160);
  const { grantConsent, getLastBlockedFingerprint } = await import("../../../threat/consent-store.js");
  grantConsent(sessionId, 30 * 60_000, reason);
  // Layer C: record the last blocked pattern's fingerprint into the
  // trust ledger so future sessions auto-allow without /approve.
  let ledgerNote = "";
  const fp = getLastBlockedFingerprint(sessionId);
  if (fp) {
    const { recordApproval } = await import("../../../threat/trust-ledger.js");
    recordApproval(fp, reason);
    ledgerNote = `\n\nLearned pattern: \`${fp}\` — future sessions hitting this pattern will auto-allow without /approve.`;
  }
  logger.info(`[threat] /approve granted for sess=${sessionId.slice(0, 16)}: ${reason.slice(0, 80)}${fp ? ` (ledger fingerprint=${fp})` : ""}`);
  if (sseSink) sseSink({
    type: "stream",
    delta: `✓ Consent granted for 30 minutes. Reason: ${reason}\n\nThe agent's next retry of the blocked tool will succeed. Type the original request again or ask the agent to retry.${ledgerNote}`,
  });
  if (sseSink) sseSink({ type: "done", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
  return { handled: true };
}

/**
 * Slash-command interceptor. Runs BEFORE memory recall, history truncation,
 * or anything else that reads `message`. When the user typed `/<known-skill>`
 * (e.g. /app-build, /senior-engineer, /vibe-code), the SKILL.md body is
 * inlined as load-bearing methodology and the agent sees a rewritten
 * message. Unknown commands pass through unchanged so we don't swallow
 * legitimate slash-prefixed input. See src/slash-commands.ts.
 */
export async function expandSlash(message: string, sessionId: string): Promise<string> {
  try {
    const { expandSlashCommand } = await import("../../../slash-commands.js");
    const expanded = expandSlashCommand(message);
    if (expanded) {
      logger.info(`[slash] /${expanded.command} expanded for sess=${sessionId.slice(0, 16)}${expanded.argText ? " (with arg)" : ""}`);
      return expanded.agentMessage;
    }
  } catch (e) {
    logger.warn(`[slash] expansion failed (passing through): ${(e as Error).message}`);
  }
  return message;
}
