// Which taint labels does the ARI kernel get to see for THIS call?
//
// LAX is the one adjudicator of data flow: at every sink it asks whether these
// specific outbound bytes come from a tainted source (fingerprint overlap,
// registered-secret scan, canaries), and the kernel runs with
// RunStatePolicy.hostAdjudicatesDataFlow so it no longer re-derives that from
// run history. What the kernel does get, per call, is the label set that
// reflects LAX's answer: a payload proven clean is handed over without the
// untrusted-content labels, so the kernel's taint-keyed policy rules (deny a
// tainted http write) fire only on a write that is not proven clean.
//
// The shell twin of this decision lives in shell-block-guidance.ts. The kernel
// still owns grants, approvals and every rule that is not about data flow.

import { checkEgressTaintWithPayload, detectSecretsInOutput } from "../data-lineage/index.js";
import { payloadFingerprints } from "../data-lineage/fingerprint.js";
import { hasCapability } from "../tool-registry.js";
import { deriveAriAction } from "./ari-action-map.js";
import { egressPayload } from "./egress-gates.js";

/**
 * The kernel's taint vocabulary is only "web" | "rag" | "user-provided"
 * (KERNEL_TAINT_SOURCE in data-lineage/taint.ts), and it is lossy: a web read
 * arrives as "web", while memory, sensitive-file AND SECRET reads all arrive
 * as "rag". So clearing "rag" clears a secret read too — which is why a payload
 * carrying secret-shaped content is refused outright below, the same way the
 * shell gate refuses one.
 */
const UNTRUSTED_CONTENT_SOURCES: ReadonlySet<string> = new Set(["web", "rag"]);

/**
 * May the kernel judge this outbound call WITHOUT the session's
 * untrusted-content taint? One predicate for every egress-capable tool —
 * browser writes, http writes, email, messaging, calendar, clipboard, typed
 * input — because the question is the same for all of them: do THESE bytes
 * come from the tainted source? A deny on session state alone is what bricked
 * sessions: one sensitive read and every later write on any site, carrying any
 * bytes, was refused (2026-09-18, an OAuth setup after an inbox question).
 *
 * `checkEgressTaintWithPayload` answers conservatively — it clears only when
 * the payload contains no tainted bytes in any decoded view AND every active
 * taint entry is fully fingerprinted. Reads (the kernel's "get") are not judged
 * on taint by any policy rule, so they are left as they are.
 *
 * Pure + exported for the contract tests.
 */
export function outboundIsTaintFree(
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
  taintLabels: readonly string[],
): boolean {
  if (!hasCapability(toolName, "egress")) return false;
  if (!taintLabels.some((s) => UNTRUSTED_CONTENT_SOURCES.has(s))) return false;
  if (deriveAriAction(toolName, args) === "get") return false;
  const { text, attachmentPaths } = egressPayload(toolName, args);
  // A file that leaves with the call is judged by the attachment scan
  // downstream; this predicate only clears what it can read.
  if (attachmentPaths.length > 0) return false;
  // Nothing to carry: a click/act with no payload cannot exfiltrate, exactly as
  // a mouse move cannot (see the `computer` case in egressPayload). Provably
  // clean, not merely unproven.
  if (text.trim() === "") return true;
  // Too short to be provable. Overlap is detected on SHINGLE_WIDTH-character
  // windows, so a payload below that produces no fingerprints at all — absence
  // of evidence here is not evidence of absence, and this is exactly the range
  // a short secret lives in (a 2FA code, a recovery token). Keep the block: the
  // user can still authorize it on the card.
  if (payloadFingerprints(text).size === 0) return false;
  // Secret-shaped content never clears, whatever its provenance: "rag" covers
  // secret reads, and a payload that looks like a credential is not something
  // to wave through on the strength of a fingerprint miss.
  if (detectSecretsInOutput(text).structured) return false;
  return !checkEgressTaintWithPayload(sessionId, text).blocked;
}

/** The labels to hand the kernel once a write has proven itself clean. */
export function withoutUntrustedContent(taintLabels: readonly string[]): string[] {
  return taintLabels.filter((s) => !UNTRUSTED_CONTENT_SOURCES.has(s));
}
