/**
 * canonical-loop public sub-barrel: a committed op rendered as reviewable
 * plain text, for the post-turn skill-review fork. Its source reads the op
 * store through the canonical row→message adapter, which is why the render
 * lives inside canonical-loop and is exported here rather than re-implemented.
 */
export { renderOpTranscript, TRANSCRIPT_CHAR_CAP } from "../turn-loop/op-transcript.js";
