/**
 * Data Lineage Tracker
 *
 * Tracks the flow of data through tool calls within a session.
 * When data is read from a sensitive source, it gets a taint label.
 * If that tainted data flows into an egress channel (http, browser),
 * the call is blocked — even if the data was transformed (base64, chunked, etc).
 *
 * Unlike regex-based detection, this tracks by CALL SEQUENCE:
 *   read(sensitive_file) → bash(any_transform) → http_request = BLOCKED
 *
 * The key insight: any data that entered the LLM context from a sensitive
 * source is tainted for the rest of the run. The LLM can't "un-see" it.
 *
 * This module is a re-export barrel. The implementation lives in:
 *  - fingerprint.ts — privacy-preserving content fingerprints
 *  - taint.ts       — the stateful per-session taint registry
 *  - paths.ts       — stateless sensitive-path & secret detection
 */

export type { TaintSource } from "./fingerprint.js";

export {
  recordSensitiveRead,
  retractProvisionalTaint,
  checkEgressTaint,
  findTaintInPayload,
  findTaintInEntries,
  subscribeTaintChanges,
  checkEgressTaintWithPayload,
  setForwardedSessionTaint,
  clearSessionTaint,
  getKernelTaintSources,
  propagateTaint,
  getTaintSummary,
} from "./taint.js";

export {
  _setDeclassifyAuditTrail,
  declassifySession,
  declassifyTaintSource,
} from "./declassify.js";
export type { DeclassifyOptions, DeclassifyResult } from "./declassify.js";

export {
  isSensitivePath,
  isSensitiveAttachmentPath,
  detectSecretsInOutput,
  redactSecretSpans,
  extractSensitivePathsFromCommand,
} from "./paths.js";
