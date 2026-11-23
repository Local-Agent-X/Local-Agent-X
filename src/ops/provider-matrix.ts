/**
 * The providers the scheduler knows, each with its concurrency ceiling and the
 * resource locks its ops must hold (the local model provider holds "gpu:0", so
 * two local-model runs never share the one GPU).
 *
 * Provider feature capabilities live in providers/registry.ts. A planned
 * dynamic-concurrency supervisor (halve on 429, ramp back up) and a
 * per-provider circuit breaker were implemented here but never called; they
 * were removed (2026-11-23). Retries and failover live in
 * canonical-loop/worker-adapter-retry.ts and runtime-failover.ts.
 *
 * Neutral naming per spec §9: providers identified by transport+auth
 * shape (cliOauth, httpKey, localHttp), not by vendor name in
 * source-code symbols. Vendor identity is config data only.
 */

import { createLogger } from "../logger.js";
const logger = createLogger("workers.provider-matrix");

// ── Scheduler profile ─────────────────────────────────────────────────────

export interface ProviderRuntimeProfile {
  /** Stable provider identifier. Use neutral names in code. */
  id: string;
  /** Human-friendly label for logs/UI (vendor name allowed here, it's data). */
  label: string;
  /** Hard ceiling on concurrent in-flight calls. Static config baseline. */
  maxConcurrent: number;
  /** Resource locks the provider needs (e.g. ["gpu:0"] for local models). */
  resourceLocks: string[];
}

// ── Registry ──────────────────────────────────────────────────────────────

const REGISTRY = new Map<string, ProviderRuntimeProfile>();

export function registerProvider(caps: ProviderRuntimeProfile): void {
  REGISTRY.set(caps.id, caps);
  logger.info(`[provider-matrix] registered ${caps.id} (${caps.label}, maxConcurrent=${caps.maxConcurrent})`);
}

export function getProvider(id: string): ProviderRuntimeProfile | undefined {
  return REGISTRY.get(id);
}

// ── Runtime-provider → resource-lock bridge ───────────────────────────────

/**
 * Runtime provider ids (settings namespace: "local", "anthropic", …) → the
 * provider-matrix capability id (neutral namespace: "localHttpOllama", …).
 * Only the local Ollama provider needs a mapping today — it is the one that
 * declares a resource lock (the single on-box GPU). Everything else resolves
 * straight through (a caller may already pass a matrix id) and, having no
 * declared lock, gets none.
 */
const RUNTIME_PROVIDER_TO_MATRIX_ID: Record<string, string> = {
  local: "localHttpOllama",
};

/**
 * Resource locks an op should hold when it routes to `providerId` — the single
 * bridge for the `resourceLocks` capability that `bootstrapProviderMatrix`
 * populates (e.g. ["gpu:0"] for the local model provider). The canonical-loop
 * scheduler stamps this onto ops so it can serialize contenders for a singleton
 * resource. Reads the live matrix entry (no second, drift-prone gpu list);
 * returns [] for hosted providers and for anything not in the matrix.
 *
 * Depends on `bootstrapProviderMatrix()` having run — it does, at server start
 * (server/index.ts), before any op is submitted; tests that exercise the bridge
 * bootstrap the matrix explicitly.
 */
export function resourceLocksForProvider(providerId: string | undefined): string[] {
  if (!providerId) return [];
  const matrixId = RUNTIME_PROVIDER_TO_MATRIX_ID[providerId] ?? providerId;
  return getProvider(matrixId)?.resourceLocks ?? [];
}

// ── Bootstrap defaults ────────────────────────────────────────────────────

/** Wire the providers we currently support. Called once at server start. */
export function bootstrapProviderMatrix(): void {
  registerProvider({
    id: "httpKeyOpenAi", label: "Codex / OpenAI (HTTP)",
    maxConcurrent: 8,
    resourceLocks: [],
  });
  registerProvider({
    id: "cliOauthAnthropic", label: "Claude (CLI / OAuth)",
    maxConcurrent: 10,
    resourceLocks: [],
  });
  registerProvider({
    id: "httpKeyXai", label: "Grok / xAI (HTTP)",
    maxConcurrent: 4,
    resourceLocks: [],
  });
  registerProvider({
    id: "httpKeyGemini", label: "Gemini (HTTP)",
    maxConcurrent: 4,
    resourceLocks: [],
  });
  registerProvider({
    id: "httpKeyCerebras", label: "Cerebras (HTTP)",
    maxConcurrent: 4,
    resourceLocks: [],
  });
  registerProvider({
    id: "localHttpOllama", label: "Local model (Ollama)",
    maxConcurrent: 1,
    resourceLocks: ["gpu:0"],
  });
}

/** Each provider's static profile: what the scheduler limits it to and the
 *  locks its ops take. Served by GET /api/health/providers. */
export function providerProfiles(): ProviderRuntimeProfile[] {
  return [...REGISTRY.values()].map((caps) => ({ ...caps, resourceLocks: [...caps.resourceLocks] }));
}
