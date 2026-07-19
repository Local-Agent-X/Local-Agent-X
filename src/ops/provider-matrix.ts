/**
 * Provider runtime scheduling + dynamic concurrency.
 *
 * Provider feature capabilities live in providers/registry.ts. This module
 * owns only scheduler state: concurrency, circuit health, and resource locks.
 * Per spec §13: maxConcurrent is dynamic — the supervisor halves it on
 * 429/overload, then ramps back up after a cooldown.
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

export function listProviders(): ProviderRuntimeProfile[] {
  return [...REGISTRY.values()];
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

// ── Dynamic concurrency (per spec §13) ────────────────────────────────────

interface ProviderRuntimeState {
  effectiveMaxConcurrent: number;
  inFlight: number;
  cooldownUntilTs: number;          // 0 = no cooldown
  consecutiveSuccesses: number;     // for ramp-up
  consecutiveTransientFailures: number;
}

const RUNTIME = new Map<string, ProviderRuntimeState>();

const RAMP_THRESHOLD_SUCCESSES = 3;   // ramp +1 after 3 successes post-cooldown
const HALVE_THRESHOLD_FAILURES = 2;   // halve after 2 transient errors in a row
const COOLDOWN_MS = 60_000;
const MIN_CONCURRENT = 1;

function getRuntime(id: string): ProviderRuntimeState {
  let r = RUNTIME.get(id);
  if (!r) {
    const caps = REGISTRY.get(id);
    r = {
      effectiveMaxConcurrent: caps?.maxConcurrent ?? 1,
      inFlight: 0,
      cooldownUntilTs: 0,
      consecutiveSuccesses: 0,
      consecutiveTransientFailures: 0,
    };
    RUNTIME.set(id, r);
  }
  return r;
}

/** True when the provider can accept another concurrent call right now. */
export function canDispatch(providerId: string): boolean {
  const r = getRuntime(providerId);
  if (Date.now() < r.cooldownUntilTs) return false;
  return r.inFlight < r.effectiveMaxConcurrent;
}

/** Mark an in-flight call started. Pair with markCallEnded. */
export function markCallStarted(providerId: string): void {
  getRuntime(providerId).inFlight++;
}

/**
 * Mark an in-flight call finished. outcome drives concurrency adjustments:
 *   - "success": ramp counter ++, ramp +1 if past threshold
 *   - "transient": halve maxConcurrent + cooldown
 *   - "fatal":    reset success counter (no concurrency change)
 */
export function markCallEnded(providerId: string, outcome: "success" | "transient" | "fatal"): void {
  const r = getRuntime(providerId);
  const caps = REGISTRY.get(providerId);
  const ceiling = caps?.maxConcurrent ?? 1;
  r.inFlight = Math.max(0, r.inFlight - 1);
  if (outcome === "success") {
    r.consecutiveTransientFailures = 0;
    r.consecutiveSuccesses++;
    if (r.consecutiveSuccesses >= RAMP_THRESHOLD_SUCCESSES && r.effectiveMaxConcurrent < ceiling) {
      r.effectiveMaxConcurrent = Math.min(ceiling, r.effectiveMaxConcurrent + 1);
      r.consecutiveSuccesses = 0;
      logger.info(`[provider-matrix] ${providerId} ramped concurrency to ${r.effectiveMaxConcurrent}/${ceiling}`);
    }
  } else if (outcome === "transient") {
    r.consecutiveSuccesses = 0;
    r.consecutiveTransientFailures++;
    if (r.consecutiveTransientFailures >= HALVE_THRESHOLD_FAILURES) {
      const newMax = Math.max(MIN_CONCURRENT, Math.floor(r.effectiveMaxConcurrent / 2));
      r.effectiveMaxConcurrent = newMax;
      r.cooldownUntilTs = Date.now() + COOLDOWN_MS;
      r.consecutiveTransientFailures = 0;
      logger.warn(`[provider-matrix] ${providerId} halved concurrency to ${newMax}, cooldown ${COOLDOWN_MS / 1000}s`);
    }
  } else {
    r.consecutiveSuccesses = 0;
  }
}

/** Snapshot for /api/health/providers. */
export function getProviderHealth(): Array<{
  id: string; label: string; effectiveMaxConcurrent: number;
  inFlight: number; cooldownRemainingMs: number; circuitOpen: boolean;
}> {
  const out: ReturnType<typeof getProviderHealth> = [];
  for (const caps of REGISTRY.values()) {
    const r = getRuntime(caps.id);
    out.push({
      id: caps.id,
      label: caps.label,
      effectiveMaxConcurrent: r.effectiveMaxConcurrent,
      inFlight: r.inFlight,
      cooldownRemainingMs: Math.max(0, r.cooldownUntilTs - Date.now()),
      circuitOpen: isCircuitOpenForProvider(caps.id),
    });
  }
  return out;
}

// ── Per-provider circuit breaker (separate from per-op-type one) ─────────

interface ProviderFailureBucket { failures: number[]; }
const PROVIDER_CIRCUIT_THRESHOLD = 10;
const PROVIDER_CIRCUIT_WINDOW_MS = 30 * 60 * 1000; // 30 min
const providerFailures = new Map<string, ProviderFailureBucket>();

export function recordProviderFailure(providerId: string): boolean {
  const now = Date.now();
  let b = providerFailures.get(providerId);
  if (!b) { b = { failures: [] }; providerFailures.set(providerId, b); }
  b.failures.push(now);
  b.failures = b.failures.filter(t => now - t < PROVIDER_CIRCUIT_WINDOW_MS);
  return b.failures.length >= PROVIDER_CIRCUIT_THRESHOLD;
}

export function isCircuitOpenForProvider(providerId: string): boolean {
  const b = providerFailures.get(providerId);
  if (!b) return false;
  const now = Date.now();
  const recent = b.failures.filter(t => now - t < PROVIDER_CIRCUIT_WINDOW_MS);
  return recent.length >= PROVIDER_CIRCUIT_THRESHOLD;
}

export function resetProviderCircuit(providerId: string): void {
  providerFailures.delete(providerId);
}
