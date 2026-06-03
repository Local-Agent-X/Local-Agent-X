/**
 * Local Agent X — Memory Importance Scoring
 *
 * Scores a stored fact by weighted factors — confidence, emotional salience,
 * richness, reinforcement, recency — to surface the user's most important
 * memories. Pure function over the facts DB; no persistence of its own.
 */

export type { ImportanceScore } from "./types.js";
export { scoreFact } from "./scoring.js";
