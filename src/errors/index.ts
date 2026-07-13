/**
 * Errors module — single owner of error classification + recovery hints.
 * See classifier.ts for the architecture overview.
 */

export {
  FailoverReason,
  classify,
  isEmptyResultText,
} from "./classifier.js";

export type { ClassifiedError, RecoveryAction } from "./classifier.js";
