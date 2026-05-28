/**
 * Associative Recall — contextual web-based memory recall.
 *
 * Links memories to surrounding context (time, topic, project, entities,
 * emotion, tools) and retrieves them through multi-channel association
 * scoring rather than flat keyword search.
 *
 * Persists to ~/.lax/associative-memory.json.
 */

export type {
  AssociationContext,
  AssociativeResult,
  AssociationWeb,
} from "./types.js";

export { AssociativeMemory } from "./memory.js";
