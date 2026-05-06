/**
 * Soak telemetry sink for canonical-loop ops.
 *
 * Passively observes the canonical event seam (`emit`) and the stream
 * publish seam (`publishStreamChunk`); aggregates per-op metrics in a
 * memory map; appends one JSON line per terminated op to
 * `workspace/canonical-loop-soak.jsonl`.
 *
 * Pure instrumentation — never throws, never blocks adapter or loop
 * behavior. Failures are warned once and the metric is dropped.
 *
 * Behind `CANONICAL_LOOP_SOAK`. Default ON. Set to "0", "false", "no",
 * or "off" (case-insensitive) to disable without a deploy.
 *
 * Read side: `docs/issues/canonical-loop/SOAK.md`.
 */
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { readOp } from "../workers/op-store.js";
import { readLatestOpTurn } from "./store.js";
import type { CanonicalEvent } from "./types.js";

import { createLogger } from "../logger.js";
const logger = createLogger("canonical-loop.soak-metrics");

// Per-host filename so multi-machine canary data sync (via the
// AgentSync workspace mirror) doesn't last-writes-wins across hosts.
// One file per machine; the SOAK.md roll-up globs them all. Hostname
// is sanitized to filesystem-safe chars and capped.
function sanitizeHost(h: string): string {
  return (h || "unknown-host").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 64);
}
const HOST = sanitizeHost(hostname());
const SOAK_LOG_DIR = join(process.cwd(), "workspace");
const SOAK_LOG_PATH = join(SOAK_LOG_DIR, `canonical-loop-soak-${HOST}.jsonl`);
const FALSY = new Set(["0", "false", "no", "off", ""]);

interface InFlightRecord {
  opId: string;
  startedAt: number;
  leaseAcquiredAt: number | null;
  firstStreamChunkAt: number | null;
  firstAssistantMsgAt: number | null;
  turnsCommitted: number;
  lastErrorCode: string | null;
  crashRecovered: boolean;
}

const records = new Map<string, InFlightRecord>();
let warnedOnce = false;

function isEnabled(): boolean {
  // Test-mode guard: vitest runs canonical-loop tests through the real
  // seam, which would otherwise append a row per test op to the
  // production soak JSONL and inflate the daily roll-up. Short-circuit
  // here so the production canary file only ever carries real traffic.
  if (process.env.VITEST) return false;
  if (process.env.NODE_ENV === "test") return false;
  const v = (process.env.CANONICAL_LOOP_SOAK ?? "1").trim().toLowerCase();
  return !FALSY.has(v);
}

function ensureLogDir(): void {
  if (!existsSync(SOAK_LOG_DIR)) {
    try { mkdirSync(SOAK_LOG_DIR, { recursive: true, mode: 0o755 }); } catch { /* swallow */ }
  }
}

function appendLine(line: Record<string, unknown>): void {
  ensureLogDir();
  try {
    appendFileSync(SOAK_LOG_PATH, JSON.stringify(line) + "\n", { encoding: "utf-8" });
  } catch (e) {
    if (!warnedOnce) {
      warnedOnce = true;
      logger.warn(`[soak] write failed (further failures suppressed): ${(e as Error).message}`);
    }
  }
}

function classifyFailure(record: InFlightRecord, terminal: string): string | null {
  if (terminal === "succeeded") return null;
  if (terminal === "cancelled") return "abort";
  if (record.crashRecovered) return "crash_recovery";
  const code = record.lastErrorCode;
  if (!code) return "unknown";
  if (/timeout/i.test(code)) return "timeout";
  if (/parse|truncat/i.test(code)) return "parse_error";
  if (/transport|provider|api|auth/i.test(code)) return "provider_error";
  return code;
}

function finalize(opId: string, terminal: "succeeded" | "failed" | "cancelled"): void {
  const r = records.get(opId);
  if (!r) return;
  records.delete(opId);

  const op = readOp(opId);
  const lane = op?.lane ?? null;
  const provider = op?.contextPack?.routing?.preferredProvider ?? null;

  const finishedAt = Date.now();
  const firstContent = r.firstStreamChunkAt ?? r.firstAssistantMsgAt;
  const firstContentLatencyMs = firstContent !== null ? firstContent - r.startedAt : null;

  // Best-effort metadata from latest op_turn provider_state. The
  // `adapter` / `adapterVersion` fields identify which adapter
  // actually served the op (e.g. "anthropic" today, "codex" when
  // v1.1 lands) — distinct from `provider` above which mirrors the
  // routing hint. Token usage stays best-effort: adapters that
  // surface usage in providerPayload populate it; others leave null.
  let adapter: string | null = null;
  let adapterVersion: string | null = null;
  let usageInputTokens: number | null = null;
  let usageOutputTokens: number | null = null;
  try {
    const last = readLatestOpTurn(opId);
    const ps = last?.providerState;
    if (ps && typeof ps.adapterName === "string") adapter = ps.adapterName;
    if (ps && typeof ps.adapterVersion === "string") adapterVersion = ps.adapterVersion;
    const payload = ps?.providerPayload as Record<string, unknown> | undefined;
    if (payload) {
      const ui = payload.usageInputTokens;
      const uo = payload.usageOutputTokens;
      if (typeof ui === "number") usageInputTokens = ui;
      if (typeof uo === "number") usageOutputTokens = uo;
    }
  } catch { /* swallow */ }

  appendLine({
    opId,
    provider,
    adapter,
    adapterVersion,
    lane,
    startedAt: new Date(r.startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs: finishedAt - r.startedAt,
    terminal,
    failureClass: classifyFailure(r, terminal),
    rounds: r.turnsCommitted,
    firstContentLatencyMs,
    usageInputTokens,
    usageOutputTokens,
    crashRecovered: r.crashRecovered,
  });
}

/**
 * Hook into the canonical emit() seam. Observer only — never throws.
 */
export function recordCanonicalEvent(event: CanonicalEvent): void {
  if (!isEnabled()) return;
  try {
    const { opId, type, body } = event;
    const b = (body ?? {}) as Record<string, unknown>;

    switch (type) {
      case "state_changed": {
        const from = (b.from ?? null) as string | null;
        const to = b.to as string | undefined;
        if (from === null && to === "queued") {
          if (!records.has(opId)) {
            records.set(opId, {
              opId,
              startedAt: Date.now(),
              leaseAcquiredAt: null,
              firstStreamChunkAt: null,
              firstAssistantMsgAt: null,
              turnsCommitted: 0,
              lastErrorCode: null,
              crashRecovered: false,
            });
          }
        } else if (to === "succeeded" || to === "failed" || to === "cancelled") {
          finalize(opId, to);
        }
        break;
      }
      case "lease_acquired": {
        const r = records.get(opId);
        if (r && r.leaseAcquiredAt === null) r.leaseAcquiredAt = Date.now();
        break;
      }
      case "lease_lost": {
        if ((b.reason as string | undefined) === "expired") {
          const r = records.get(opId);
          if (r) r.crashRecovered = true;
        }
        break;
      }
      case "turn_committed": {
        const r = records.get(opId);
        if (r) r.turnsCommitted += 1;
        break;
      }
      case "message_appended": {
        if ((b.role as string | undefined) === "assistant") {
          const r = records.get(opId);
          if (r && r.firstAssistantMsgAt === null) r.firstAssistantMsgAt = Date.now();
        }
        break;
      }
      case "error": {
        const code = b.code as string | undefined;
        const r = records.get(opId);
        if (r && code) r.lastErrorCode = code;
        break;
      }
    }
  } catch (e) {
    if (!warnedOnce) {
      warnedOnce = true;
      logger.warn(`[soak] event hook failed (further suppressed): ${(e as Error).message}`);
    }
  }
}

/** Hook into publishStreamChunk to capture first-content latency. */
export function recordStreamChunk(opId: string): void {
  if (!isEnabled()) return;
  const r = records.get(opId);
  if (r && r.firstStreamChunkAt === null) r.firstStreamChunkAt = Date.now();
}

/** Test-only: clear in-memory state. Does not touch the JSONL file. */
export function _resetSoakMetricsForTests(): void {
  records.clear();
  warnedOnce = false;
}
