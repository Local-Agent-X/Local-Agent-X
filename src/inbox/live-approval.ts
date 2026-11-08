// A chat's live approval card, copied into the inbox when the person it asks
// has walked away from the computer, so the phone alert (src/phone-push/,
// which hears every new inbox item) reaches them. The desktop app decides
// "walked away" (no keyboard or mouse input on the whole machine for a while,
// desktop/src/approval-presence.ts) and tells the server which card; the
// server copies the card from its own record, never from the message.
//
// The copy answers the card itself: Approve or Decline on the phone (or the
// bell) resolves the card exactly as a click in the chat would, and the copy
// closes when the card settles any other way (a click at the desk, the
// deadline, a chat reply), so the phone never offers a stale question.
//
// Unlike a parked call (approvals.ts) nothing runs from the inbox: the card's
// own turn is still waiting on the answer, and it runs the call.

import { getApprovalManager, onApprovalSettled } from "../approval-manager.js";
import { registerDesktopApprovalAwayHandler } from "../desktop-bridge.js";
import { inboxStore, postToInbox, resolveInboxWhere } from "./index.js";
import { APPROVAL_ACTIONS, type InboxActResult } from "./approvals.js";
import { clip } from "./producers.js";
import type { InboxItem } from "./types.js";

export interface LiveCard {
  approvalId: string;
  sessionId: string;
  toolName: string;
  /** The card's sentence, as the chat shows it. */
  context: string;
}

/** Copy a live card into the inbox. One item per card: a repeat updates it. */
export function inboxLiveApproval(card: LiveCard): InboxItem | null {
  return postToInbox({
    kind: "approval",
    title: `Waiting for your approval: ${card.toolName}`,
    body: [
      clip(card.context, 600),
      "",
      "Approve or Decline answers the card in the chat; the agent is waiting on it.",
    ].join("\n"),
    needsYou: true,
    key: `live-approval:${card.approvalId}`,
    link: { sessionId: card.sessionId },
    actions: APPROVAL_ACTIONS,
    liveApprovalId: card.approvalId,
  });
}

/** The live card a stored inbox item answers, if it is one. */
export function liveApprovalOf(itemId: string): string | undefined {
  return inboxStore().get(itemId)?.liveApprovalId;
}

/**
 * Answer the card from its inbox copy: claim the item (one answer wins, as for
 * a parked call), then resolve the card. `resolveCard` is the approval
 * manager's resolve; false means the card had already settled, and the user
 * is told nothing ran on this answer.
 */
export function answerLiveApproval(
  itemId: string,
  approved: boolean,
  resolveCard: (approvalId: string, approved: boolean) => boolean,
  onAnswered?: () => void,
): InboxActResult {
  const claim = inboxStore().claimApproval(itemId, approved ? "approved" : "declined");
  if (claim.kind !== "claimed") return { ok: false, refused: claim.kind };
  const approvalId = claim.item.liveApprovalId;
  if (!approvalId) return { ok: false, refused: "not-approval" };
  onAnswered?.();
  if (!resolveCard(approvalId, approved)) {
    return { ok: true, resolution: "failed", error: "That card was already answered or had expired in the chat, so this answer changed nothing." };
  }
  return { ok: true, resolution: approved ? "approved" : "declined" };
}

/** The card settled some other way: close its copy so the phone stops asking. */
export function settleLiveApproval(approvalId: string): number {
  return resolveInboxWhere((item) => item.liveApprovalId === approvalId);
}

let started = false;

/** Copy a card the desktop says its user walked away from (main's
 *  `lax:approval-away`), and close copies as their cards settle. Called once
 *  at boot, beside the phone alerts (src/server/lifecycle.ts). */
export function startLiveApprovalCopies(): void {
  if (started) return;
  started = true;
  registerDesktopApprovalAwayHandler((approvalId) => {
    const card = getApprovalManager().pendingCard(approvalId);
    if (card) inboxLiveApproval({ approvalId, ...card });
  });
  onApprovalSettled((approvalId) => { settleLiveApproval(approvalId); });
}
