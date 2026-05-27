/**
 * Provider health tracking — minimal surface kept after AUDIT Critical #5.
 *
 * What was here: a full circuit-breaker + retry orchestrator (withFallback)
 * with backoff calculation and provider chain building. None of it was
 * wired in — the audit confirmed `withFallback`, `recordSuccess`,
 * `recordFailure`, `buildFallbackChain`, `getBackoffMs`, and
 * `isProviderAvailable` had zero callers. Gutted in P3.C3.
 *
 * What's live now: a tiny health-display layer used by the settings UI
 * and the providers/health API endpoint. `getProviderHealthStatus` reads
 * from disk; `resetProviderHealth` lets the user manually clear a stuck
 * entry. recordSuccess/recordFailure are gone, so the persisted file is
 * effectively a museum — kept for the UI to read existing entries until
 * something starts writing it again.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createLogger } from "./logger.js";
import type { ProviderId } from "./providers/provider-ids.js";
import { getLaxDir } from "./lax-data-dir.js";
export type { ProviderId };
const logger = createLogger("model-fallback");

const LAX_DIR = getLaxDir();
const HEALTH_FILE = join(LAX_DIR, "provider-health.json");

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
  circuitOpen: boolean;
  circuitOpensAt: number;
  circuitRetriesAt: number;
}

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
    writeFileSync(HEALTH_FILE, JSON.stringify([...healthMap.values()], null, 2));
  } catch {}
}

function getHealth(id: ProviderId): ProviderHealth {
  if (!healthMap.has(id)) {
    healthMap.set(id, {
      id,
      healthy: true,
      consecutiveFailures: 0,
      lastFailure: 0,
      lastSuccess: 0,
      lastError: "",
      totalRequests: 0,
      totalFailures: 0,
      avgLatencyMs: 0,
      circuitOpen: false,
      circuitOpensAt: 0,
      circuitRetriesAt: 0,
    });
  }
  return healthMap.get(id)!;
}

loadHealth();

/** Snapshot of every known provider's health for the settings UI. */
export function getProviderHealthStatus(): ProviderHealth[] {
  return Array.from(healthMap.values()).sort((a, b) => {
    if (a.healthy !== b.healthy) return a.healthy ? -1 : 1;
    return a.avgLatencyMs - b.avgLatencyMs;
  });
}

/** Manual recovery — clear a stuck provider entry. */
export function resetProviderHealth(provider: ProviderId): void {
  const h = getHealth(provider);
  h.healthy = true;
  h.consecutiveFailures = 0;
  h.circuitOpen = false;
  h.lastError = "";
  saveHealth();
  logger.info(`[provider-health] reset for ${provider}`);
}
