/**
 * Provider capability matrix + dynamic concurrency.
 *
 * Per spec §2: each provider declares its capabilities once at registration.
 * Routing is explicit (filter by required caps, pick by latency/cost),
 * not vibes-based. Per spec §13: maxConcurrent is dynamic — supervisor
 * halves on 429/overload, ramps back up after a cooldown.
 *
 * Neutral naming per spec §9: providers identified by transport+auth
 * shape (cliOauth, httpKey, localHttp), not by vendor name in
 * source-code symbols. Vendor identity is config data only.
 */

import { createLogger } from "../logger.js";
const logger = createLogger("workers.provider-matrix");

// ── Capability schema ─────────────────────────────────────────────────────

export interface ProviderCapabilities {
  /** Stable provider identifier. Use neutral names in code. */
  id: string;
  /** Human-friendly label for logs/UI (vendor name allowed here, it's data). */
  label: string;
  /** Transport+auth shape: cliOauth | httpKey | localHttp | etc. */
  transport: "cliOauth" | "httpKey" | "localHttp" | "custom";
  supportsTools: boolean;
  supportsVision: boolean;
  supportsLongContext: boolean;     // >100K tokens
  supportsStreaming: boolean;
  supportsJsonMode: boolean;
  supportsLocalFiles: boolean;       // CLI providers can read disk natively
  /** Hard ceiling on concurrent in-flight calls. Static config baseline. */
  maxConcurrent: number;
  costTier: "cheap" | "standard" | "premium";
  latencyTier: "fast" | "medium" | "slow";
  /** Resource locks the provider needs (e.g. ["gpu:0"] for local models). */
  resourceLocks: string[];
}

// ── Registry ──────────────────────────────────────────────────────────────

const REGISTRY = new Map<string, ProviderCapabilities>();

export function registerProvider(caps: ProviderCapabilities): void {
  REGISTRY.set(caps.id, caps);
  logger.info(`[provider-matrix] registered ${caps.id} (${caps.label}, transport=${caps.transport}, maxConcurrent=${caps.maxConcurrent})`);
}

export function listProviders(): ProviderCapabilities[] {
  return [...REGISTRY.values()];
}

export function getProvider(id: string): ProviderCapabilities | undefined {
  return REGISTRY.get(id);
}

// ── Bootstrap defaults ────────────────────────────────────────────────────

/** Wire the providers we currently support. Called once at server start. */
export function bootstrapProviderMatrix(): void {
  registerProvider({
    id: "httpKeyOpenAi", label: "Codex / OpenAI (HTTP)",
    transport: "httpKey",
    supportsTools: true, supportsVision: true, supportsLongContext: true,
    supportsStreaming: true, supportsJsonMode: true, supportsLocalFiles: false,
    maxConcurrent: 8, costTier: "standard", latencyTier: "medium",
    resourceLocks: [],
  });
  registerProvider({
    id: "cliOauthAnthropic", label: "Claude (CLI / OAuth)",
    transport: "cliOauth",
    supportsTools: true, supportsVision: true, supportsLongContext: true,
    supportsStreaming: true, supportsJsonMode: false, supportsLocalFiles: true,
    maxConcurrent: 10, costTier: "premium", latencyTier: "medium",
    resourceLocks: [],
  });
  registerProvider({
    id: "httpKeyXai", label: "Grok / xAI (HTTP)",
    transport: "httpKey",
    supportsTools: true, supportsVision: false, supportsLongContext: true,
    supportsStreaming: true, supportsJsonMode: true, supportsLocalFiles: false,
    maxConcurrent: 4, costTier: "standard", latencyTier: "medium",
    resourceLocks: [],
  });
  registerProvider({
    id: "httpKeyGemini", label: "Gemini (HTTP)",
    transport: "httpKey",
    supportsTools: true, supportsVision: true, supportsLongContext: true,
    supportsStreaming: true, supportsJsonMode: true, supportsLocalFiles: false,
    maxConcurrent: 4, costTier: "standard", latencyTier: "medium",
    resourceLocks: [],
  });
  registerProvider({
    id: "httpKeyCerebras", label: "Cerebras (HTTP)",
    transport: "httpKey",
    supportsTools: true, supportsVision: false, supportsLongContext: false,
    supportsStreaming: true, supportsJsonMode: true, supportsLocalFiles: false,
    maxConcurrent: 4, costTier: "cheap", latencyTier: "fast",
    resourceLocks: [],
  });
  registerProvider({
    id: "localHttpOllama", label: "Local model (Ollama)",
    transport: "localHttp",
    supportsTools: false, supportsVision: false, supportsLongContext: false,
    supportsStreaming: true, supportsJsonMode: false, supportsLocalFiles: false,
    maxConcurrent: 1, costTier: "cheap", latencyTier: "slow",
    resourceLocks: ["gpu:0"],
  });
}

// ── Capability matching (routing) ─────────────────────────────────────────

import type { ProviderCapabilityRequirement } from "./types.js";

export interface MatchOptions {
  /** Hard requirements — provider must satisfy ALL. */
  requirements?: ProviderCapabilityRequirement;
  /** Optional explicit preference (still must satisfy requirements). */
  preferredId?: string;
  /** Cost/latency tier preferences for tie-breaking. */
  preferCheap?: boolean;
  preferFast?: boolean;
}

/** Return providers matching all requirements, sorted by preference. */
export function matchProviders(opts: MatchOptions = {}): ProviderCapabilities[] {
  const req = opts.requirements ?? {};
  let candidates = listProviders().filter(p => {
    if (req.needsTools && !p.supportsTools) return false;
    if (req.needsVision && !p.supportsVision) return false;
    if (req.needsLongContext && !p.supportsLongContext) return false;
    if (req.needsStreaming && !p.supportsStreaming) return false;
    if (req.needsJsonMode && !p.supportsJsonMode) return false;
    if (req.needsLocalFiles && !p.supportsLocalFiles) return false;
    if (isCircuitOpenForProvider(p.id)) return false;
    return true;
  });

  if (opts.preferredId) {
    const preferred = candidates.find(p => p.id === opts.preferredId);
    if (preferred) candidates = [preferred, ...candidates.filter(p => p.id !== opts.preferredId)];
  }

  candidates.sort((a, b) => {
    if (opts.preferFast && a.latencyTier !== b.latencyTier) {
      const order = { fast: 0, medium: 1, slow: 2 };
      return order[a.latencyTier] - order[b.latencyTier];
    }
    if (opts.preferCheap && a.costTier !== b.costTier) {
      const order = { cheap: 0, standard: 1, premium: 2 };
      return order[a.costTier] - order[b.costTier];
    }
    return 0;
  });

  return candidates;
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

// ── Classification helper for callers ────────────────────────────────────

/** Map a thrown error to outcome category for markCallEnded(). */
export function classifyProviderError(err: unknown): "transient" | "fatal" {
  const msg = String((err as { message?: string })?.message || err || "").toLowerCase();
  if (
    msg.includes("rate limit") || msg.includes("429") ||
    msg.includes("overload") || msg.includes("503") || msg.includes("529") ||
    msg.includes("timeout") || msg.includes("etimedout") ||
    msg.includes("econnreset") || msg.includes("econnrefused")
  ) {
    return "transient";
  }
  return "fatal";
}
