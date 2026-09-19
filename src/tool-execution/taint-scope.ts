// Which taint labels does the ARI kernel get to see for THIS call?
//
// The kernel judges an egress-class write on session-scoped taint: read one
// email with token-shaped content and every later browser write is denied and
// the run quarantined, on any site, carrying any bytes. LAX front-runs that
// where it can answer the narrower question the kernel cannot — do these
// specific bytes come from the tainted source? — and hands the kernel a label
// set that reflects the answer.
//
// The shell twin of this decision lives in shell-block-guidance.ts and has
// worked this way since the whole-run brick it removed; this module is the
// browser half. Enforcement is unchanged either way: the kernel still owns
// grants, approvals and every non-taint rule, and a write that DOES carry
// tainted bytes keeps its labels and is denied exactly as before.

import { checkEgressTaintWithPayload, detectSecretsInOutput } from "../data-lineage/index.js";
import { payloadFingerprints } from "../data-lineage/fingerprint.js";
import { BROWSER_WRITE_ACTIONS } from "./ari-action-map.js";
import { egressPayload } from "./egress-gates.js";

/**
 * The kernel's taint vocabulary is only "web" | "rag" | "user-provided"
 * (KERNEL_TAINT_SOURCE in data-lineage/taint.ts), and it is lossy: a web read
 * arrives as "web", while memory, sensitive-file AND SECRET reads all arrive
 * as "rag". So clearing "rag" clears a secret read too — which is why a payload
 * carrying secret-shaped content is refused outright below, the same way the
 * shell gate refuses one.
 *
 * ("email" appears in the shell gate's copy of this set and is dead — nothing
 * maps to it. Left alone here rather than fixed in passing.)
 */
const UNTRUSTED_CONTENT_SOURCES: ReadonlySet<string> = new Set(["web", "rag"]);

/**
 * May the kernel judge this browser write WITHOUT the session's
 * untrusted-content taint?
 *
 * The kernel denies a tainted browser write on session state alone: read one
 * email with token-shaped content, and every later click/fill/select is denied
 * and the run quarantined — on any site, carrying any bytes. A user setting up
 * an OAuth app after asking about their inbox lost the rest of the conversation
 * to it (2026-09-18).
 *
 * So ask the question the kernel cannot: do THESE bytes come from the tainted
 * source? `checkEgressTaintWithPayload` answers it conservatively — it clears
 * only when the payload contains no tainted bytes in any decoded view AND every
 * active taint entry is fully fingerprinted, so an entry whose content we never
 * captured keeps the presence floor and this returns false.
 *
 * Clearing here hides the untrusted-content labels from this ONE call. The
 * payload secret scan, canary tripwire and host allowlist all still run
 * downstream, and a write that DOES carry tainted bytes keeps its labels and is
 * denied exactly as before. Directly mirrors the shell gate (shell-block-guidance.ts), which has
 * front-run the kernel this way since the whole-run brick it removed.
 *
 * Pure + exported for the contract test.
 */
export function browserWriteIsTaintFree(
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
  taintLabels: readonly string[],
): boolean {
  if (toolName !== "browser") return false;
  if (!taintLabels.some((s) => UNTRUSTED_CONTENT_SOURCES.has(s))) return false;
  if (!BROWSER_WRITE_ACTIONS.has(String(args.action ?? "").toLowerCase())) return false;
  const { text } = egressPayload(toolName, args);
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

/** The labels to hand the kernel once a browser write has proven itself clean. */
export function withoutUntrustedContent(taintLabels: readonly string[]): string[] {
  return taintLabels.filter((s) => !UNTRUSTED_CONTENT_SOURCES.has(s));
}
