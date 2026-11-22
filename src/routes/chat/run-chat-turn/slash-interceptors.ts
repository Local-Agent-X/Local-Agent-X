import { createLogger } from "../../../logger.js";
import type { ServerEvent } from "../../../types.js";
import type { SseSink } from "./types.js";
import { isUserChat, sendAppMessageWhenIdle } from "../../../chat-ws/app-message.js";

const logger = createLogger("routes.chat.slash-interceptors");

export interface ApproveResult {
  /** True when the message was a `/approve` and the turn should return. */
  handled: boolean;
}

/** Text the agent is sent after the user typed /approve, as the app's. */
export function approvedRetryMessage(reason: string): string {
  return [
    `(Sent by the app, not typed by the user: the user typed /approve "${reason}", so the step that was blocked may run now, for 30 minutes.)`,
    "Retry the call that was blocked and carry on with what the user asked. If nothing is waiting on that approval any more, say so in one line.",
  ].join("\n");
}

/**
 * `/approve <reason>` short-circuit. Grants threat-engine consent for
 * this session so the model's NEXT retry of a blocked tool succeeds. Layer B
 * of the threat-engine consent flow (src/threat/consent-store.ts).
 *
 * The reply goes out on `emit`, the transport the turn is live on: the chat
 * socket gave this function no sink, so on the desktop the confirmation and
 * the turn's end went nowhere and the chat waited forever (2026-11-22). Then
 * `wakeAgent` (when given) tells the agent to retry: the agent had already
 * said it was waiting on this approval, and the user had to type the request
 * a second time.
 */
export async function handleApproveCommand(
  message: string,
  sessionId: string,
  emit: (event: ServerEvent) => void,
  wakeAgent?: (message: string) => void,
): Promise<ApproveResult> {
  if (!/^\s*\/approve\b/i.test(message)) return { handled: false };

  const reason = (message.replace(/^\s*\/approve\s*/i, "").trim() || "user-typed-/approve").slice(0, 160);
  const { grantConsent, getLastBlockedFingerprint } = await import("../../../threat/consent-store.js");
  grantConsent(sessionId, 30 * 60_000, reason);
  // Confirmed-breach (canary) recovery. A tripped canary latches the session
  // restricted and, unlike an exfil/loop block, the trust-budget model cannot
  // decay it away — only an explicit user authorization lifts it. recoverSessionBreach
  // is self-gated: it clears the session breach signal, mints FRESH canaries (the
  // leaked tokens are known to the model, worthless as a tripwire — this replaces
  // the exact set the egress gate reads), and writes a tamper-evident recovery
  // event; it is a no-op returning false when no breach latch is live, so an
  // ordinary /approve is unchanged.
  const { recoverSessionBreach } = await import("../../../threat/canaries.js");
  const breachRecovered = recoverSessionBreach(sessionId, reason);
  const breachNote = breachRecovered
    ? `\n\nConfirmed-breach (canary) restriction lifted by your authorization, and this session's canary tripwires were re-minted.`
    : "";
  // Layer C: record the last blocked pattern's fingerprint into the
  // trust ledger so future sessions auto-allow without /approve.
  let ledgerNote = "";
  const fp = getLastBlockedFingerprint(sessionId);
  if (fp) {
    const { recordApproval } = await import("../../../threat/trust-ledger.js");
    recordApproval(fp, reason);
    ledgerNote = `\n\nLearned pattern: \`${fp}\` — future sessions hitting this pattern will auto-allow without /approve.`;
  }
  logger.info(`[threat] /approve granted for sess=${sessionId.slice(0, 16)}: ${reason.slice(0, 80)}${breachRecovered ? " (canary breach recovered)" : ""}${fp ? ` (ledger fingerprint=${fp})` : ""}`);
  emit({
    type: "stream",
    delta: `✓ Consent granted for 30 minutes. Reason: ${reason}\n\n${wakeAgent ? "The agent is retrying the blocked step now." : "The agent's next retry of the blocked tool will succeed. Type the original request again or ask the agent to retry."}${breachNote}${ledgerNote}`,
  } as ServerEvent);
  emit({ type: "done", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } } as ServerEvent);
  wakeAgent?.(approvedRetryMessage(reason));
  return { handled: true };
}

/**
 * A chat turn's `/approve`: the reply goes out on the transport the turn is
 * live on (the HTTP route's sink, else the chat socket, which passes none),
 * and in a chat a person is in on the web, its agent retries at once.
 */
export function handleApproveInTurn(
  message: string,
  sessionId: string,
  live: { sseSink: SseSink; channel: string; emitToChat: (event: ServerEvent) => void },
): Promise<ApproveResult> {
  const emit = (event: ServerEvent) => (live.sseSink ? live.sseSink(event) : live.emitToChat(event));
  const wake = live.channel === "web" && isUserChat(sessionId)
    ? (text: string) => { sendAppMessageWhenIdle(sessionId, () => text); }
    : undefined;
  return handleApproveCommand(message, sessionId, emit, wake);
}

/**
 * Slash-command interceptor. Runs BEFORE memory recall, history truncation,
 * or anything else that reads `message`. When the user typed `/<known-skill>`
 * (e.g. /greenfield, /senior-engineer, /vibe-code), the SKILL.md body is
 * inlined as load-bearing methodology and the agent sees a rewritten
 * message. Unknown commands pass through unchanged so we don't swallow
 * legitimate slash-prefixed input. See src/slash-commands.ts.
 */
export async function expandSlash(message: string, sessionId: string): Promise<string> {
  try {
    const { expandSlashCommand } = await import("../../../slash-commands.js");
    const expanded = expandSlashCommand(message);
    if (expanded) {
      logger.info(`[slash] ${expanded.commands.map((c) => `/${c}`).join(" ")} expanded for sess=${sessionId.slice(0, 16)}${expanded.argText ? " (with arg)" : ""}`);
      return expanded.agentMessage;
    }
  } catch (e) {
    logger.warn(`[slash] expansion failed (passing through): ${(e as Error).message}`);
  }
  return message;
}
