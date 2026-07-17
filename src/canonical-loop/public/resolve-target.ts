/**
 * canonical-loop public sub-barrel: provider endpoint resolution.
 *
 * resolveOpenAICompatTarget is the one seam that maps (provider, model) to
 * a concrete baseURL/apiKey — including the per-model local-runtime lookup.
 * local-runtimes tests and tooling need it to prove routing end-to-end, and
 * local-runtimes sits inside canonical-loop's own runtime graph (discovery
 * cache ← resolve-target), so the heavy index barrel would mint a cycle;
 * resolve-target.js is a leaf, so this barrel adds no reachability beyond
 * the old deep import.
 */
export { resolveOpenAICompatTarget } from "../adapters/openai-compat/resolve-target.js";
