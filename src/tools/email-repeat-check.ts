// Before an email goes out: is it the same message again to someone who has
// not answered? Then the user is asked first (email_send's confirmWithUser →
// tool-execution/ask-user-gates.ts: a card in a chat, a spoken question in a
// voice chat, the inbox when no one is there).
//
// Code narrows it, a model judges it. Code finds the candidate: LAX emailed
// one of these recipients in the last two days (email-sent-log.ts, which every
// chat and channel shares, so a restarted chat still sees the first send), this
// email is not answering a different message, and the mailbox holds nothing
// from them since. Back-and-forth fails those tests, so a conversation is never
// asked about. Only then a model reads both emails (classifiers/same-email-again.ts)
// and "something new" sends without a question. An identical email skips the
// model; a model that cannot answer asks rather than send twice.
//
// Replaced the tool's 5-minute exact-match skip (2026-11-16): two reworded
// versions of one job reply went out after a voice chat was restarted and the
// request repeated, and an exact-match skip would also swallow a re-send the
// user had just approved here.

import type { ComposedEmail } from "./email-send-tool.js";
import { addressesIn, lastSentTo, type SentEmail } from "./email-sent-log.js";
import { getImapConfig } from "./email-config.js";
import { searchMessages } from "./email-imap.js";
import { describeAge } from "./idempotency.js";
import { sameEmailAgain } from "../classifiers/same-email-again.js";
import { createLogger } from "../logger.js";

const logger = createLogger("tools.email-repeat-check");
const REPLY_LOOKUP_MS = 8000;

export interface RepeatCheckDeps {
  /** True when a mail from one of these addresses arrived after `since`; null when it cannot tell. */
  repliedSince(addresses: string[], since: number): Promise<boolean | null>;
  judge: typeof sameEmailAgain;
}

/** Whether the mailbox holds a mail from them after `since`. Null without
 *  IMAP, or when the lookup fails or is slow: the model then decides alone. */
async function imapRepliedSince(addresses: string[], since: number): Promise<boolean | null> {
  const cfg = getImapConfig();
  if (typeof cfg === "string") return null;
  const lookup = searchMessages(cfg, "INBOX", { anyOf: addresses.map((from) => ({ from })), since: new Date(since) }, 20)
    .then((page) => page.messages.some((m) => Date.parse(m.date) > since))
    .catch((e: Error) => { logger.warn(`[email] reply lookup failed: ${e.message}`); return null; });
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), REPLY_LOOKUP_MS).unref());
  return Promise.race([lookup, timeout]);
}

const DEFAULT_DEPS: RepeatCheckDeps = { repliedSince: imapRepliedSince, judge: sameEmailAgain };

/** True when the draft answers a message other than the one the earlier
 *  email answered (or the earlier email itself): a reply in a conversation. */
function answersSomethingElse(draft: ComposedEmail, prior: SentEmail): boolean {
  if (!draft.inReplyTo) return false;
  return draft.inReplyTo !== prior.inReplyTo && draft.inReplyTo !== prior.messageId;
}

function reason(prior: SentEmail, recipients: string[], why: string): string {
  const who = prior.recipients.find((r) => recipients.includes(r)) ?? prior.recipients[0];
  const excerpt = prior.excerpt.replace(/\s+/g, " ").slice(0, 160);
  return `This looks like a repeat: LAX already emailed ${who} ${describeAge(Date.now() - prior.at)} ` +
    `("${prior.subject}": "${excerpt}${prior.excerpt.length > 160 ? "…" : ""}"), they have not replied since, and ${why} ` +
    "Approve only if they should get this one too; if not, tell the user the first email already went";
}

/** Why this send needs the user's yes, or null to send it. */
export async function repeatSendReason(draft: ComposedEmail, fingerprint: string, deps: RepeatCheckDeps = DEFAULT_DEPS): Promise<string | null> {
  const recipients = addressesIn([draft.to, draft.cc, draft.bcc].join(", "));
  if (recipients.length === 0) return null;
  const prior = lastSentTo(recipients);
  if (!prior || answersSomethingElse(draft, prior)) return null;
  if (prior.fingerprint === fingerprint) return reason(prior, recipients, "this email is identical to it.");
  if (await deps.repliedSince(recipients, prior.at)) return null;
  const verdict = await deps.judge({ subject: prior.subject, text: prior.excerpt }, { subject: draft.subject, text: draft.text });
  if (verdict?.verdict === "new") return null;
  return reason(prior, recipients, verdict ? `this one says the same thing again (${verdict.why.replace(/[.\s]+$/, "")}).` : "the check that compares them could not run.");
}
