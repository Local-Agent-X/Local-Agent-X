/**
 * Proactive Memory — surfaces relevant memories and patterns before
 * the user asks. Learns interaction habits, topic associations, and
 * time-based routines to offer timely, natural suggestions.
 *
 * Persists patterns to ~/.lax/proactive-patterns.json.
 */

export type {
  ProactiveSuggestion,
  InteractionPattern,
} from "./types.js";

export { ProactiveMemory } from "./memory.js";
