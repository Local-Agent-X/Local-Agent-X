import { stripCodeBlocks } from "./code-strip.js";
import { evaluateClaimGrounding, type EvidenceKind } from "./claim-grounding.js";

// Claims about what a running system did or why it did it need fresh
// observation. Conversation history and durable memory can provide a lead,
// but neither proves current or historical runtime state.
const OPERATIONAL_SUBJECT =
  /\b(?:ari|kernel|harness|runtime|system|server|service|session|security|firewall|sandbox|policy|permission|provider|bridge|worker|process|daemon|tool|api|database|deployment|build|ci|moderation)\b/i;
const OPERATIONAL_ASSERTION =
  /\b(?:block(?:ed|ing)?|den(?:y|ied|ies)|disable[ds]?|enable[ds]?|restrict(?:ed|ion)?|appl(?:y|ied|ies)|enforc(?:e|ed|es)|flag(?:ged|s)?|log(?:ged|s)?|caught|trigger(?:ed|s)?|caus(?:e|ed|es)|because|due to|reason|permanent(?:ly)?|current(?:ly)?|running|stopp?ed|fail(?:ed|s|ure)|allow(?:ed|s)?|reject(?:ed|s)?)\b/i;
const EXPLICIT_UNCERTAINTY =
  /\b(?:I (?:do not|don't) know|I (?:cannot|can't) verify|unverified|not verified|memory (?:only )?(?:says|suggests|indicates)|may|might|could|possibly|one possibility|working hypothesis|inference|appears to|seems to)\b/i;

const NON_DIAGNOSTIC_TOOLS = new Set([
  "memory_search",
  "memory_recall",
  "search_past_sessions",
  "remember",
  "update_fact",
  "forget",
  "tool_search",
]);

/**
 * First sentence that reads as a definitive operational-state/causality claim,
 * or null. This regex pass is a PREFILTER — it is negation- and
 * paraphrase-blind by construction ("the firewall did NOT block it" matches).
 * The middleware hands the flagged sentence to an LLM confirm before the
 * retract-grade consequence is allowed; exporting the sentence (not just a
 * boolean) is what makes that confirm precise.
 */
export function findDefinitiveOperationalClaimSentence(text: string): string | null {
  const cleaned = stripCodeBlocks(text);
  if (!cleaned) return null;
  const sentences = cleaned.split(/(?<=[.!?])\s+|\n+/);
  for (const sentence of sentences) {
    if (
      OPERATIONAL_SUBJECT.test(sentence) &&
      OPERATIONAL_ASSERTION.test(sentence) &&
      !EXPLICIT_UNCERTAINTY.test(sentence)
    ) return sentence;
  }
  return null;
}

/** True when a reply makes a definitive operational-state/causality claim. */
export function looksLikeDefinitiveOperationalClaim(text: string): boolean {
  return findDefinitiveOperationalClaimSentence(text) !== null;
}

/** Successful read/inspection tools from this op count as fresh evidence. */
export function hasFreshOperationalEvidence(toolsCalledThisOp: Set<string>): boolean {
  return runtimeCausalityEvidence(toolsCalledThisOp).includes("diagnostic-read");
}

/** Evidence adapter for the canonical claim-grounding table. Operational-claim
 * owns which tools count as fresh diagnostics; claim-grounding owns the policy
 * that runtime/causality claims require diagnostic-read evidence. */
export function runtimeCausalityEvidence(toolsCalledThisOp: Set<string>): EvidenceKind[] {
  for (const rawName of toolsCalledThisOp) {
    const name = rawName.toLowerCase();
    if (NON_DIAGNOSTIC_TOOLS.has(name) || name.startsWith("memory_")) continue;
    if (
      /(?:^|_)(?:read|grep|glob|search|query|inspect|diagnos|audit|log|status|list|fetch)(?:_|$)/.test(name) ||
      /^(?:bash|shell|browser|http_request|web_search)$/.test(name)
    ) return ["diagnostic-read"];
  }
  return [];
}

/**
 * Return a corrective when a model presents memory/speculation as observed
 * operational truth. The retry may inspect the system or answer honestly with
 * explicit uncertainty.
 */
export function checkUnsupportedOperationalClaim(
  text: string,
  toolsCalledThisOp: Set<string>,
): string | null {
  if (!looksLikeDefinitiveOperationalClaim(text)) return null;
  const verdict = evaluateClaimGrounding("runtime-causality", runtimeCausalityEvidence(toolsCalledThisOp));
  return verdict.grounded ? null : verdict.message;
}
