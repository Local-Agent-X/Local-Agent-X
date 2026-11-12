/**
 * What makes two failed tool calls "the same failure".
 *
 * Two readers key on it. Inside one run, the constraint ledger
 * (canonical-loop/turn-loop/constraint-ledger.ts) recognizes a refusal it has
 * already met. Across runs, the tool-usage log (tool-execution/failure-record.ts)
 * stamps every failed call with the signature, so the same failure in several
 * chats is counted as one pattern and a lesson the user kept for it is found
 * again the moment it recurs. One normalizer for both: a second one would
 * count as two failures what the first calls one.
 *
 * Leaf: no imports beyond the result header helper and node:crypto.
 */
import { createHash } from "node:crypto";
import { withoutResultHeader } from "./result-helpers.js";

/** Longest slice of a failure's first line that is kept. */
export const MAX_FAILURE_REASON_CHARS = 200;

/**
 * Collapse the incidental parts of a refusal so two instances of the SAME gate
 * match even though they name different files.
 *
 * The recorded run renamed its scratch harness every lap (`_mt.html`,
 * `_prod.html`, `_h.html`), so a raw-string key would have recorded fourteen
 * distinct "constraints" and recognized none of them. Quoted spans, path-like
 * runs, and digits are the parts that varied; the gate's own sentence is what
 * stayed constant.
 */
export function normalizeReason(reason: string): string {
  return reason
    .toLowerCase()
    .replace(/["'`][^"'`]*["'`]/g, "<q>")           // quoted values
    .replace(/[a-z]:[\\/][^\s,;)]+/g, "<path>")      // windows absolute paths
    .replace(/(?:[\w.-]*[\\/])+[\w.-]+/g, "<path>")  // any other path-like run
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

/** The first line of a failed result that says anything: what a person would
 *  quote as "the error". The status header, when the text carries one, is not it. */
export function failureReason(content: string): string {
  const line = withoutResultHeader(content).split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.trim().slice(0, MAX_FAILURE_REASON_CHARS);
}

export interface FailureIdentity {
  tool: string;
  /** `args.action` of a one-tool-many-actions family (browser, protocol, office). */
  action?: string;
  /** error | blocked | timeout. */
  status: string;
  /** The gate that refused a blocked call (BLOCK_LAYERS). */
  layer?: string;
  /** The failure's first line, verbatim. */
  reason: string;
}

/**
 * A short stable id for a failure. Args are deliberately not part of it:
 * varying the payload against the same broken precondition is still the same
 * failure. Sixteen hex characters, so it can sit in a URL and a JSON key.
 */
export function failureSignature(f: FailureIdentity): string {
  const key = [f.tool, f.action ?? "", f.status, f.layer ?? "", normalizeReason(f.reason)].join("\u0000");
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}
