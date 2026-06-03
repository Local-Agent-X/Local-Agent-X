/**
 * Local Agent X — Memory Importance Scoring
 *
 * Scores a memory by weighted factors: recency, frequency, user feedback,
 * content richness, emotional weight.
 */

export type { ImportanceScore } from "./types.js";

export { MemoryImportance } from "./importance.js";

import { MemoryImportance } from "./importance.js";
export default MemoryImportance.getInstance();
