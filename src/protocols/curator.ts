/**
 * Protocol curator — periodic catalog maintenance pass.
 *
 * What it does (in order):
 *   1. Run automatic lifecycle transitions (stale→archived, archived→purged).
 *   2. Survey the catalog: pull per-protocol stats, search misses, embedding
 *      clusters of likely-redundant protocols.
 *   3. Ask a cheap auxiliary model (Haiku by default, falls back to whatever
 *      llm-dispatch picks) for two judgments:
 *        - which clusters could be consolidated into a single umbrella, and
 *        - which search misses signal genuine catalog gaps worth a new protocol.
 *   4. Write a structured report to workspace/protocols/.curator/reports/<ts>.md
 *      and update workspace/protocols/.curator/state.json with the run timestamp.
 *
 * Dry-run by default. The curator never modifies the catalog beyond the
 * lifecycle transitions in step 1 — consolidation/new-protocol suggestions are
 * advisory, surfaced for the agent/user to act on via protocol_create /
 * protocol_archive_bulk on a later turn.
 *
 * Soft dependencies:
 *   - llm-dispatch (auxiliary-model call) — if no provider is available, the
 *     LLM-judgment section is skipped and the report still ships with the
 *     mechanical sections (transitions + raw signals).
 *   - embedding provider — drives cluster detection. If absent, clusters
 *     section is skipped; transitions still run.
 */
export type { CuratorReport, RunCuratorOpts } from "./curator/types.js";
export { loadCuratorState, shouldCurate } from "./curator/state.js";
export { runCurator } from "./curator/run.js";
export { createCuratorTools } from "./curator/tools.js";
