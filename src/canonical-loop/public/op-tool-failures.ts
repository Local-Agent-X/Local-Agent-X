/**
 * canonical-loop public sub-barrel: the failed tool calls of a committed op,
 * for the count of recurring problems and the failure review. Its source reads
 * the op store through the canonical row→message adapter, which is why the
 * read lives inside canonical-loop and is exported here rather than
 * re-implemented.
 */
export {
  readOpToolFailures, renderFailureEvidence,
  type FailureEvidence, type OpToolFailure,
} from "../turn-loop/op-tool-failures.js";
