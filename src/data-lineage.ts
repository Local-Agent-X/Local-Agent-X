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
 *  - data-lineage-fingerprint.ts — privacy-preserving content fingerprints
 *  - data-lineage-taint.ts       — the stateful per-session taint registry
 *  - data-lineage-paths.ts       — stateless sensitive-path & secret detection
 */

export type { TaintSource } from "./data-lineage-fingerprint.js";

export {
  recordSensitiveRead,
  checkEgressTaint,
  findTaintInPayload,
  checkEgressTaintWithPayload,
  clearSessionTaint,
  _setDeclassifyAuditTrail,
  declassifySession,
  declassifyTaintSource,
  getKernelTaintSources,
  propagateTaint,
  getTaintSummary,
} from "./data-lineage-taint.js";
export type { DeclassifyOptions, DeclassifyResult } from "./data-lineage-taint.js";

export {
  isSensitivePath,
  isSensitiveAttachmentPath,
  detectSecretsInOutput,
  redactSecretSpans,
  extractSensitivePathsFromCommand,
} from "./data-lineage-paths.js";
