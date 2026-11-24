// An app asking to talk to the user's agents. An app the agent built can start
// chat turns of its own (src/routes/app-chat.ts), and those turns run with the
// user's powers, so the first time an app tries, it is refused and this card
// is posted. The answer is the user's, once per app, remembered by whoever
// keeps the grants (src/app-runtime/chat-grants.ts, through `apply`).
//
// Nothing runs on the answer: Approve only lets the app's later calls through.
// The item is claimed like every approval, so of two answers exactly one
// counts. The title and body name the app by its id, never by anything the
// app's page sent, so a page cannot word its own request.

import { inboxStore, postToInbox } from "./index.js";
import { APPROVAL_ACTIONS, type InboxActResult } from "./approvals.js";
import type { InboxItem } from "./types.js";

/** What approving opens the user to, as the card says it. The long form is
 *  docs/app-chat-security.md. */
const WHAT_YOU_ALLOW = [
  "If you approve, this app can start conversations with your agents by itself:",
  "- Those conversations run with your full powers: reading and changing files, running commands, using the web, under your usual approval settings.",
  "- The agent treats what the app's page sends as a request from you. You did not type it, and the page may carry text it loaded from the web or another service, which can steer the agent.",
  "- The app's page reads every reply, including file contents or memories the agent quotes.",
  "- It can do this while you are away. Actions that need your approval wait in this inbox; the rest run.",
  "- The permission lasts until you remove it on the Apps page.",
  "",
  "Approve only an app you asked for and trust. Decline blocks it; you can change either answer on the Apps page.",
];

/** Ask the user about one app. One item per app: a repeat while it waits
 *  changes nothing. Null when the inbox could not record it. */
export function inboxAppChatRequest(appId: string): InboxItem | null {
  return postToInbox({
    kind: "approval",
    title: `The app "${appId}" wants to talk to your agents`,
    body: [`App: ${appId} (/apps/${appId}/)`, "", ...WHAT_YOU_ALLOW].join("\n"),
    needsYou: true,
    key: `app-chat:${appId}`,
    link: { url: `/apps/${appId}/` },
    actions: APPROVAL_ACTIONS,
    appChatRequest: { appId },
  });
}

/** The app a stored inbox item asks about, if it is such a request. */
export function appChatRequestOf(itemId: string): string | undefined {
  return inboxStore().get(itemId)?.appChatRequest?.appId;
}

/**
 * Answer the request: claim the item (one answer wins), then record the
 * user's yes or no through `apply`.
 */
export function answerAppChatRequest(
  itemId: string,
  approved: boolean,
  apply: (appId: string, approved: boolean) => void,
  onAnswered?: () => void,
): InboxActResult {
  const claim = inboxStore().claimApproval(itemId, approved ? "approved" : "declined");
  if (claim.kind !== "claimed") return { ok: false, refused: claim.kind };
  const appId = claim.item.appChatRequest?.appId;
  if (!appId) return { ok: false, refused: "not-approval" };
  apply(appId, approved);
  onAnswered?.();
  return { ok: true, resolution: approved ? "approved" : "declined" };
}
