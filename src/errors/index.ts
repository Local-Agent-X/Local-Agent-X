/**
 * Errors module — single owner of error classification + recovery hints.
 * See classifier.ts for the architecture overview.
 */

export {
  FailoverReason,
  classify,
  isEmptyResultText,
  looksLikeAgentRefusal,
  isContextOverflowError,
} from "./classifier.js";

export type { ClassifiedError, RecoveryAction } from "./classifier.js";
