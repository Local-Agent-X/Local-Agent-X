// The one ask behind ADR 0005: every channel that sends a vault secret off the
// machine (browser fill, http_request, connector_create, email_setup) consults
// SecretsStore.destinationDecision, and when the ladder ends in "ask" this
// gate gets the user's yes for the pair. A yes persists the (secret,
// destination) pair on the record, so the next use at that destination costs
// nothing.
//
// How the yes is got depends on who is watching the run, which the gate reads
// off the call's own stamps (tool-execution/internal-args.ts), never off a flag
// each caller has to remember to pass. In the chat: a card per pair. With no
// one watching (a scheduled job, a background op) or no card sink: one
// needs-you refusal naming every pair the call needs, which an unattended run
// parks in the user's inbox (tool-execution/deferred-call.ts parkNeedsUser).
// The user's Approve there re-runs this exact call carrying `_userGrant`,
// which stands in for the cards for those pairs and is kept the way a card's
// yes is.

import { getApprovalManager } from "./approval-manager.js";
import { normalizeDestination, type SecretsStore } from "./secrets.js";
import { declined, err, needsUser } from "./tools/result-helpers.js";
import { onEventOf, toolCallIdOf, unattendedCall, userGrantOf } from "./tool-execution/internal-args.js";
import type { ToolResult } from "./types.js";

export interface SecretDestinationCall {
  store: SecretsStore;
  sessionId: string;
  toolName: string;
  /** The tool call's arguments, stamps included: the card's id and event
   *  sink, whether anyone is watching, and the user's yes from the inbox. */
  call: Record<string, unknown>;
}

export interface SecretDestinationPair {
  name: string;
  destination: string;
  /** What the secret is about to do there, for the card: "Send GITHUB_TOKEN to https://api.github.com". */
  purpose: string;
}

export type SecretDestinationOutcome =
  | { allowed: true }
  | { allowed: false; result: ToolResult };

/** The {{NAME}} placeholders a string references, each once. */
export function referencedSecretNames(input: string): string[] {
  return [...new Set([...input.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))];
}

const shown = (destination: string): string => normalizeDestination(destination) ?? destination;

/** No card can be raised: the refusal says where the user approves each pair,
 *  marked for the inbox so an unattended run parks the call. */
function nobodyToAsk(pairs: SecretDestinationPair[]): ToolResult {
  const named = pairs.map((p) => `secret "${p.name}" at ${shown(p.destination)}`).join(" and ");
  const where = pairs.map((p) => `Settings → Secrets → "${p.name}" and approve "${shown(p.destination)}"`).join(", then ");
  const one = pairs.length === 1;
  return needsUser(err(
    `First-use approval required for ${named}. ` +
    `${one ? "This secret was" : "These secrets were"} not captured by the current session, ${one ? "has" : "have"} not been pre-approved, and this call has no way to ask the user.`,
    { recovery: `Ask the user to open ${where} (one click, persists), or to re-run this from the chat, where it asks.` },
  ), pairs.map((p) => `${p.purpose}: the first use of "${p.name}" at ${shown(p.destination)} needs the user's yes.`).join(" "));
}

/**
 * Get the user's yes for each pair and persist it: their inbox yes to this
 * exact call if it carries one, else a card per pair in the chat (stopping at
 * the first no), else a needs-you refusal naming them all.
 */
export async function requestSecretDestinationApprovals(
  pairs: SecretDestinationPair[],
  ask: SecretDestinationCall,
): Promise<SecretDestinationOutcome> {
  if (pairs.length === 0) return { allowed: true };
  const { store, sessionId, toolName, call } = ask;
  if (userGrantOf(call)) {
    for (const pair of pairs) store.approveDestination(pair.name, pair.destination);
    return { allowed: true };
  }
  const onEvent = onEventOf(call);
  if (!onEvent || unattendedCall(call)) return { allowed: false, result: nobodyToAsk(pairs) };
  for (const { name, destination, purpose } of pairs) {
    const where = shown(destination);
    const asked = await getApprovalManager().requestApprovalDetailed({
      toolName,
      toolCallId: toolCallIdOf(call) || `secret-destination-${name}`,
      sessionId,
      context: `${purpose}. The value goes from the vault straight there; the agent never sees it.`,
      args: { name, destination: where },
      alwaysAsk: true,
      emit: onEvent,
    });
    if (!asked.approved) {
      return {
        allowed: false,
        result: declined(
          `The user did not approve sending "${name}" to ${where}.`,
          { recovery: "Do not retry this destination unchanged. Ask the user how they want to proceed, and continue with the rest of the request." },
        ),
      };
    }
    store.approveDestination(name, destination);
  }
  return { allowed: true };
}

/** Run the ladder for every pair a call binds, and ask only about the pairs
 *  where it ends in "ask". */
export async function gateSecretDestinations(
  pairs: SecretDestinationPair[],
  ask: SecretDestinationCall,
): Promise<SecretDestinationOutcome> {
  const pending = pairs.filter((p) => ask.store.destinationDecision(p.name, p.destination, { sessionId: ask.sessionId }) === "ask");
  return requestSecretDestinationApprovals(pending, ask);
}
