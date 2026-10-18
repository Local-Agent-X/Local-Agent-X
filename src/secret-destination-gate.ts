// The one ask behind ADR 0005: every channel that sends a vault secret off the
// machine (browser fill, http_request, connector_create, email_setup) consults
// SecretsStore.destinationDecision, and when the ladder ends in "ask" raises
// this card. A yes persists the (secret, destination) pair on the record, so
// the next use at that destination costs nothing.

import { getApprovalManager } from "./approval-manager.js";
import { normalizeDestination, type DestinationDecision, type SecretsStore } from "./secrets.js";
import { declined, err, needsUser } from "./tools/result-helpers.js";
import type { ServerEvent, ToolResult } from "./types.js";

export interface SecretDestinationAsk {
  store: SecretsStore;
  name: string;
  destination: string;
  /** What the secret is about to do there, for the card: "Send GITHUB_TOKEN to https://api.github.com". */
  purpose: string;
  sessionId: string;
  toolName: string;
  toolCallId?: string;
  onEvent?: (event: ServerEvent) => void;
  /** No person is watching this run (tool-execution/internal-args.ts
   *  unattendedCall): the refusal is marked for the user's inbox instead of a
   *  card being raised into a sink nobody answers. */
  unattended?: boolean;
}

export type SecretDestinationOutcome =
  | { allowed: true; decision: DestinationDecision }
  | { allowed: false; result: ToolResult };

/** The {{NAME}} placeholders a string references, each once. */
export function referencedSecretNames(input: string): string[] {
  return [...new Set([...input.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))];
}

/**
 * Raise the approval card for one (secret, destination) pair and persist a yes.
 * Without an event sink, or with no one watching the run, there is no card to
 * raise: the refusal says where the user approves it instead, marked for the
 * inbox so an unattended run parks the call (tool-execution/deferred-call.ts).
 */
export async function requestSecretDestinationApproval(ask: SecretDestinationAsk): Promise<SecretDestinationOutcome> {
  const { store, name, destination, sessionId, toolName, onEvent } = ask;
  const where = normalizeDestination(destination) ?? destination;
  if (!onEvent || ask.unattended) {
    return {
      allowed: false,
      result: needsUser(err(
        `First-use approval required for secret "${name}" at ${where}. ` +
        `This secret was not captured by the current session, has not been pre-approved, and this call has no way to ask the user.`,
        { recovery: `Ask the user to open Settings → Secrets → "${name}" and approve "${where}" (one click, persists), or to re-run this from the chat, where it asks.` },
      ), `${ask.purpose}: the first use of "${name}" at ${where} needs the user's yes.`),
    };
  }
  const asked = await getApprovalManager().requestApprovalDetailed({
    toolName,
    toolCallId: ask.toolCallId || `secret-destination-${name}`,
    sessionId,
    context: `${ask.purpose}. The value goes from the vault straight there; the agent never sees it.`,
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
  return { allowed: true, decision: "approved" };
}

/** Run the ladder for one pair and ask only when it ends in "ask". */
export async function gateSecretDestination(ask: SecretDestinationAsk): Promise<SecretDestinationOutcome> {
  const decision = ask.store.destinationDecision(ask.name, ask.destination, { sessionId: ask.sessionId });
  if (decision !== "ask") return { allowed: true, decision };
  return requestSecretDestinationApproval(ask);
}

/** The ladder for several secrets bound for one destination: one card per
 *  secret that needs it, stopping at the first refusal. */
export async function gateSecretDestinations(
  names: string[],
  ask: Omit<SecretDestinationAsk, "name" | "purpose"> & { purpose: (name: string) => string },
): Promise<SecretDestinationOutcome> {
  for (const name of names) {
    const outcome = await gateSecretDestination({ ...ask, name, purpose: ask.purpose(name) });
    if (!outcome.allowed) return outcome;
  }
  return { allowed: true, decision: "approved" };
}
