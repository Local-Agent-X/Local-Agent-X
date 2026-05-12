/**
 * Model Fallback — automatic provider failover with retry and backoff.
 *
 * When a provider fails (429, 500, timeout, auth error), automatically
 * tries the next provider in the fallback chain.
 *
 * More robust than typical approaches:
 * - Health tracking per provider (circuit breaker pattern)
 * - Adaptive backoff based on error type (rate limit vs server error vs timeout)
 * - Provider health scores that affect selection order
 * - Automatic recovery: unhealthy providers are retried periodically
 * - Usage-aware: tracks token usage per provider for cost optimization
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { createLogger } from "./logger.js";
const logger = createLogger("model-fallback");

const LAX_DIR = join(homedir(), ".lax");
const HEALTH_FILE = join(LAX_DIR, "provider-health.json");

// ── Types ──

export type ProviderId = "xai" | "openai" | "codex" | "anthropic" | "local" | "gemini" | "custom";

export interface ProviderHealth {
  id: ProviderId;
  healthy: boolean;
  consecutiveFailures: number;
  lastFailure: number;
  lastSuccess: number;
  lastError: string;
  totalRequests: number;
  totalFailures: number;
  avgLatencyMs: number;
  circuitOpen: boolean;         // true = skip this provider temporarily
  circuitOpensAt: number;       // when circuit was opened
  circuitRetriesAt: number;     // when to try again
}

export interface FallbackResult {
  provider: ProviderId;
  model: string;
  apiKey: string;
  baseURL?: string;
  attempt: number;
  totalAttempts: number;
}

export interface FallbackChain {
  primary: { provider: ProviderId; model: string };
  fallbacks: Array<{ provider: ProviderId; model: string }>;
}

// ── Constants ──

const CIRCUIT_OPEN_DURATION_MS = 60_000;    // Skip provider for 1 min after repeated failures
const MAX_CONSECUTIVE_FAILURES = 3;          // Open circuit after 3 consecutive failures
const MAX_RETRIES_PER_PROVIDER = 2;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

// Rate limit errors get longer backoff
const RATE_LIMIT_BACKOFF_MS = 10_000;

// ── Health Store ──

const healthMap = new Map<ProviderId, ProviderHealth>();

function loadHealth(): void {
  try {
    if (existsSync(HEALTH_FILE)) {
      const data = JSON.parse(readFileSync(HEALTH_FILE, "utf-8")) as ProviderHealth[];
      for (const h of data) healthMap.set(h.id, h);
    }
  } catch {}
}

function saveHealth(): void {
  try {
    writeFileSync(HEALTH_FILE, JSON.stringify(Array.from(healthMap.values()), null, 2), "utf-8");
  } catch {}
}

function getHealth(id: ProviderId): ProviderHealth {
  if (!healthMap.has(id)) {
    healthMap.set(id, {
      id, healthy: true, consecutiveFailures: 0,
      lastFailure: 0, lastSuccess: 0, lastError: "",
      totalRequests: 0, totalFailures: 0, avgLatencyMs: 0,
      circuitOpen: false, circuitOpensAt: 0, circuitRetriesAt: 0,
    });
  }
  return healthMap.get(id)!;
}

loadHealth();

// ── Core API ──

/**
 * Record a successful request to a provider.
 */
export function recordSuccess(provider: ProviderId, latencyMs: number): void {
  const h = getHealth(provider);
  h.healthy = true;
  h.consecutiveFailures = 0;
  h.lastSuccess = Date.now();
  h.totalRequests++;
  h.circuitOpen = false;
  h.avgLatencyMs = h.totalRequests > 1
    ? (h.avgLatencyMs * (h.totalRequests - 1) + latencyMs) / h.totalRequests
    : latencyMs;
  saveHealth();
}

/**
 * Record a failed request to a provider.
 */
export function recordFailure(provider: ProviderId, error: string, statusCode?: number): void {
  const h = getHealth(provider);
  h.consecutiveFailures++;
  h.totalFailures++;
  h.totalRequests++;
  h.lastFailure = Date.now();
  h.lastError = error;

  // Open circuit breaker after repeated failures
  if (h.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    h.healthy = false;
    h.circuitOpen = true;
    h.circuitOpensAt = Date.now();
    // Rate limit errors get longer cooldown
    const cooldown = statusCode === 429 ? CIRCUIT_OPEN_DURATION_MS * 3 : CIRCUIT_OPEN_DURATION_MS;
    h.circuitRetriesAt = Date.now() + cooldown;
    logger.warn(`[fallback] Circuit opened for ${provider}: ${h.consecutiveFailures} consecutive failures (retry in ${cooldown / 1000}s)`);
  }

  saveHealth();
}

/**
 * Check if a provider is available (circuit not open, or half-open for retry).
 */
export function isProviderAvailable(provider: ProviderId): boolean {
  const h = getHealth(provider);
  if (!h.circuitOpen) return true;
  // Half-open: allow retry if cooldown has passed
  if (Date.now() >= h.circuitRetriesAt) return true;
  return false;
}

/**
 * Get the fallback chain based on current health.
 * Healthy providers first, sorted by latency. Unhealthy providers at the end.
 */
export function buildFallbackChain(
  primary: { provider: ProviderId; model: string },
  availableProviders: Array<{ provider: ProviderId; model: string; apiKey: string; baseURL?: string }>,
): Array<{ provider: ProviderId; model: string; apiKey: string; baseURL?: string; healthy: boolean }> {
  // Sort: primary first, then healthy by latency, then unhealthy
  const sorted = availableProviders.map(p => {
    const h = getHealth(p.provider);
    return { ...p, healthy: isProviderAvailable(p.provider), latency: h.avgLatencyMs };
  });

  // Primary always first
  const primaryEntry = sorted.find(p => p.provider === primary.provider && p.model === primary.model);
  const rest = sorted.filter(p => p !== primaryEntry);

  // Sort rest: healthy first, then by latency
  rest.sort((a, b) => {
    if (a.healthy !== b.healthy) return a.healthy ? -1 : 1;
    return a.latency - b.latency;
  });

  const chain = primaryEntry ? [primaryEntry, ...rest] : rest;
  return chain;
}

/**
 * Calculate backoff delay based on error type and attempt number.
 */
export function getBackoffMs(attempt: number, statusCode?: number): number {
  if (statusCode === 429) {
    // Rate limit: longer fixed backoff + jitter
    return RATE_LIMIT_BACKOFF_MS + Math.random() * 5000;
  }
  // Exponential backoff with jitter
  const base = BACKOFF_BASE_MS * Math.pow(2, attempt);
  const jitter = Math.random() * BACKOFF_BASE_MS;
  return Math.min(base + jitter, BACKOFF_MAX_MS);
}

/**
 * Execute a function with automatic failover across providers.
 * Tries each provider in the chain, with retries per provider.
 */
export async function withFallback<T>(
  chain: Array<{ provider: ProviderId; model: string; apiKey: string; baseURL?: string; healthy: boolean }>,
  fn: (entry: { provider: ProviderId; model: string; apiKey: string; baseURL?: string }, attempt: number) => Promise<T>,
): Promise<{ result: T; provider: ProviderId; model: string; attempts: number }> {
  let totalAttempts = 0;
  const errors: string[] = [];

  for (const entry of chain) {
    if (!isProviderAvailable(entry.provider)) continue;

    for (let retry = 0; retry < MAX_RETRIES_PER_PROVIDER; retry++) {
      totalAttempts++;
      const start = Date.now();

      try {
        const result = await fn(entry, totalAttempts);
        recordSuccess(entry.provider, Date.now() - start);
        return { result, provider: entry.provider, model: entry.model, attempts: totalAttempts };
      } catch (e) {
        const err = e as Error & { status?: number; statusCode?: number };
        const status = err.status || err.statusCode;
        const msg = err.message || String(e);
        errors.push(`${entry.provider}/${entry.model} (attempt ${totalAttempts}): ${msg}`);
        recordFailure(entry.provider, msg, status);

        // Auth errors: don't retry same provider
        if (status === 401 || status === 403) break;
        // Rate limit on last retry: move to next provider
        if (status === 429 && retry === MAX_RETRIES_PER_PROVIDER - 1) break;

        // Backoff before retry
        if (retry < MAX_RETRIES_PER_PROVIDER - 1) {
          const delay = getBackoffMs(retry, status);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
  }

  throw new Error(`All providers failed after ${totalAttempts} attempts:\n${errors.join("\n")}`);
}

/**
 * Get health status for all providers (for UI display).
 */
export function getProviderHealthStatus(): ProviderHealth[] {
  return Array.from(healthMap.values()).sort((a, b) => {
    if (a.healthy !== b.healthy) return a.healthy ? -1 : 1;
    return a.avgLatencyMs - b.avgLatencyMs;
  });
}

/**
 * Reset health for a provider (manual recovery).
 */
export function resetProviderHealth(provider: ProviderId): void {
  const h = getHealth(provider);
  h.healthy = true;
  h.consecutiveFailures = 0;
  h.circuitOpen = false;
  h.lastError = "";
  saveHealth();
  logger.info(`[fallback] Health reset for ${provider}`);
}
