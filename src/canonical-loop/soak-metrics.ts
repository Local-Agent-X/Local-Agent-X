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
import { readOp } from "../ops/op-store.js";
import { readLatestOpTurn, readOpTurns } from "./store.js";
import { schedulerSnapshot } from "./scheduler.js";
import { getPricing } from "../cost-tracker.js";
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
  lastErrorMessage: string | null;
  crashRecovered: boolean;
  /** Scheduler queue depth at the moment this op was queued. Captured
   *  from `schedulerSnapshot()` on the first state_changed event. */
  queueDepthAtSubmit: number | null;
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
  const sessionId = op?.canonical?.sessionId ?? null;

  const finishedAt = Date.now();
  const firstContent = r.firstStreamChunkAt ?? r.firstAssistantMsgAt;
  const firstContentLatencyMs = firstContent !== null ? firstContent - r.startedAt : null;

  // Aggregate per-turn metadata across ALL rounds. Earlier we only read
  // the latest op_turn, which lost token + tool data from earlier rounds
  // in multi-round ops (chat with tool chains regularly hit 2-5 rounds).
  let adapter: string | null = null;
  let adapterVersion: string | null = null;
  let usageInputTokens = 0;
  let usageOutputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreateTokens = 0;
  let modelMs = 0;
  let toolDispatchMs = 0;
  const toolsCalledSet = new Set<string>();
  let sawAnyUsage = false;
  let sawAnyCache = false;
  let sawAnyModelMs = false;
  let sawAnyToolDispatchMs = false;
  try {
    const turns = readOpTurns(opId);
    for (const t of turns) {
      // adapter identity from the LAST turn that has it (Codex+Anthropic
      // both stamp every turn, but use last-wins for safety).
      const ps = t.providerState;
      if (ps && typeof ps.adapterName === "string") adapter = ps.adapterName;
      if (ps && typeof ps.adapterVersion === "string") adapterVersion = ps.adapterVersion;
      const payload = ps?.providerPayload as Record<string, unknown> | undefined;
      if (payload) {
        const ui = payload.usageInputTokens;
        const uo = payload.usageOutputTokens;
        const cr = payload.cacheReadTokens;
        const cc = payload.cacheCreateTokens;
        if (typeof ui === "number") { usageInputTokens += ui; sawAnyUsage = true; }
        if (typeof uo === "number") { usageOutputTokens += uo; sawAnyUsage = true; }
        if (typeof cr === "number") { cacheReadTokens += cr; sawAnyCache = true; }
        if (typeof cc === "number") { cacheCreateTokens += cc; sawAnyCache = true; }
      }
      if (typeof t.modelMs === "number") { modelMs += t.modelMs; sawAnyModelMs = true; }
      if (typeof t.toolDispatchMs === "number") { toolDispatchMs += t.toolDispatchMs; sawAnyToolDispatchMs = true; }
      for (const tc of t.toolCallSummary ?? []) {
        if (tc.tool) toolsCalledSet.add(tc.tool);
      }
    }
  } catch { /* swallow */ }

  // Cost estimate from the model + tokens. Cache-aware when we saw
  // cache fields (Anthropic), otherwise plain input × rate.
  const model = (op?.contextPack?.routing as Record<string, unknown> | undefined)?.preferredModel as string | undefined
    ?? (readLatestOpTurn(opId)?.providerState?.providerPayload as Record<string, unknown> | undefined)?.model as string | undefined
    ?? null;
  let estimatedCostUsd: number | null = null;
  if (sawAnyUsage && model) {
    try {
      const pricing = getPricing(model);
      // Anthropic cache: cache reads are ~10% of input rate, cache writes ~125%.
      const billableInput = sawAnyCache
        ? Math.max(0, usageInputTokens - cacheReadTokens - cacheCreateTokens)
        : usageInputTokens;
      const cost =
        (billableInput * pricing.input) / 1_000_000 +
        (cacheReadTokens * pricing.input * 0.10) / 1_000_000 +
        (cacheCreateTokens * pricing.input * 1.25) / 1_000_000 +
        (usageOutputTokens * pricing.output) / 1_000_000;
      estimatedCostUsd = Math.round(cost * 1_000_000) / 1_000_000;
    } catch { /* swallow — pricing table miss; cost stays null */ }
  }

  appendLine({
    opId,
    sessionId,
    provider,
    adapter,
    adapterVersion,
    lane,
    startedAt: new Date(r.startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs: finishedAt - r.startedAt,
    terminal,
    failureClass: classifyFailure(r, terminal),
    failureCode: r.lastErrorCode,
    failureMessage: r.lastErrorMessage,
    rounds: r.turnsCommitted,
    firstContentLatencyMs,
    modelMs: sawAnyModelMs ? modelMs : null,
    toolDispatchMs: sawAnyToolDispatchMs ? toolDispatchMs : null,
    usageInputTokens: sawAnyUsage ? usageInputTokens : null,
    usageOutputTokens: sawAnyUsage ? usageOutputTokens : null,
    cacheReadTokens: sawAnyCache ? cacheReadTokens : null,
    cacheCreateTokens: sawAnyCache ? cacheCreateTokens : null,
    estimatedCostUsd,
    toolsCalled: toolsCalledSet.size > 0 ? [...toolsCalledSet].sort() : null,
    queueDepthAtSubmit: r.queueDepthAtSubmit,
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
            // Capture scheduler queue depth at submit-time. Best-effort:
            // schedulerSnapshot is sync and cheap; on failure we log null.
            let queueDepth: number | null = null;
            try {
              queueDepth = schedulerSnapshot().queueDepth;
            } catch { /* ignore — null is acceptable */ }
            records.set(opId, {
              opId,
              startedAt: Date.now(),
              leaseAcquiredAt: null,
              firstStreamChunkAt: null,
              firstAssistantMsgAt: null,
              turnsCommitted: 0,
              lastErrorCode: null,
              lastErrorMessage: null,
              crashRecovered: false,
              queueDepthAtSubmit: queueDepth,
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
        const message = b.message as string | undefined;
        const r = records.get(opId);
        if (r) {
          if (code) r.lastErrorCode = code;
          // Truncate + scrub-light to keep soak rows compact.
          if (message && !r.lastErrorMessage) {
            r.lastErrorMessage = message.replace(/\s+/g, " ").trim().slice(0, 300);
          }
        }
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
