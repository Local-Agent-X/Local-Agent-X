/**
 * canonical-loop public sub-barrel: nudge identity constants.
 *
 * `context/rule-registry.ts` pairs each prompt rule with the nudge id that
 * enforces it, and canonical-loop imports the rule registry back through the
 * prompt builder — so it cannot reach the heavy index barrel without minting a
 * cycle. The source module (turn-loop/nudge-ids.ts) is a leaf with no imports
 * at all, so this barrel adds no reachability whatsoever.
 *
 * Not re-exported from index.ts: that barrel sits at the 400-LOC source-hygiene
 * ceiling, and this sub-barrel is already a public surface under the seal.
 */
export { WIRE_FORMAT_NUDGE_ID, WIRE_FORMAT_NUDGE } from "../turn-loop/nudge-ids.js";
