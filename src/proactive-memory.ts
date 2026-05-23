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
} from "./proactive-memory/types.js";

export { ProactiveMemory } from "./proactive-memory/memory.js";
