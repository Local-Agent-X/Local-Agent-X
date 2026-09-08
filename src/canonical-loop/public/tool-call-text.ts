/**
 * canonical-loop public sub-barrel: the tool-call text recognizer.
 *
 * The ONE recognizer of tool-call syntax leaked into model text lives in
 * adapters/tool-call-text-*.ts. Consumers outside canonical-loop — delivery
 * and persist hygiene (providers/output-sanitize.ts) and the history-rebuild
 * / streaming filters (anthropic-client/parse.ts) — must not deep-import
 * adapter internals, and index.js is a heavy barrel that would mint cycles
 * from those leaves. This barrel is the light pass-through: recognition,
 * masking, and the tag vocabulary, nothing else.
 */
export {
  findTextToolCallRanges,
  maskCodeSpans,
  resolveCandidateName,
  scanTextToolCallSyntaxes,
  type ScanOptions,
  type SyntaxCandidate,
  type SyntaxHit,
  type TextToolCallRange,
} from "../adapters/tool-call-text-syntaxes.js";
export { segmentCodeSpans, type CodeSegment } from "../adapters/tool-call-text-mask.js";
export { WRAPPER_TAGS, closerRegex, openerRegex } from "../adapters/tool-call-text-tags.js";
