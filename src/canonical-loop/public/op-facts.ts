/**
 * canonical-loop public sub-barrel: leaf-module facts about ops.
 *
 * Small predicates and types (dispatch-status discrimination, terminal
 * states, model capability lookups) needed by modules that canonical-loop's
 * own runtime graph imports back (ollama-cloud, tool files registered in the
 * tool-registry, ops/, memory ingest). Those consumers cannot import the
 * heavy index barrel without minting cycles; every source module here is a
 * leaf, so this barrel adds no reachability beyond what the old deep imports
 * had.
 *
 * index.ts also exports these symbols, so they remain part of the front-door
 * API for out-of-orbit callers.
 */
export { isDispatchFailure } from "../types.js";
export type {
	CanonicalLane,
	CanonicalOpFields,
	ToolDispatchStatus,
} from "../types.js";

export type { TerminalState } from "../terminal-states.js";

export { isEmbeddingModel } from "../model-capabilities.js";
