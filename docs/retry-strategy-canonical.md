# Canonical Retry Strategy — Design

**Status:** Design. P3.C3 (dead-code deletion) executes inline. P3.C2 (caller migration) BLOCKED on P4 (same dependency as P2 — adapter unification).
**Scope:** AUDIT Critical #5. Replaces 4-6 stacked retry layers with one shared budget + correlationId.
**Companion:** [AUDIT.md Critical #5](../AUDIT.md), [AUDIT-PLAN.md P3](../AUDIT-PLAN.md).

---

## Problem

A single 429 currently triggers retries at up to six layers, none knowing about each other:

| Layer | Location | What it retries | Budget | Correlation |
|---|---|---|---|---|
| L1 | `tool-executor.ts:withRetry` | Tool call (per call) | Per-invocation only | None |
| L2 | `agent-codex/run-http.ts` stream-error handler | Codex stream → forceCompact + continue | Per-turn | None |
| L3 | `providers/run-anthropic.ts` stream-error handler | Anthropic stream → forceCompact + continue | Per-turn | None |
| L4 | `providers/run-standard.ts` stream-error handler | OpenAI/xAI/Gemini stream | Per-turn | None |
| L5 | `routes/chat.ts:525-580` provider cascade | Failover to next provider | Per-request | None |
| L6 | Warm-pool subprocess retry | Anthropic CLI process | Per-spawn | None |

Plus two **dead** retry orchestrators that ship in the bundle:
- `src/model-fallback.ts:withFallback` (~266 LOC of circuit-breaker + provider chain) — 0 callers.
- `src/provider-fallback.ts:ProviderChain` (~183 LOC) — 0 callers.

A single 429 from Anthropic can: (L1) retry the tool call → (L3) compact + retry the stream → (L5) failover to OpenAI → (L1) retry tool call there again. Without a shared budget, total attempts can climb to 12+ for one user message. Without a correlationId, telemetry can't reconstruct what happened.

## Canonical retry contract

One shared retry context per **request** (= user message), passed down through all layers:

```ts
// src/retry-context.ts (new file in P3.C2)
export interface RetryContext {
  correlationId: string;        // UUID, generated at request entry
  budget: {
    maxAttempts: number;        // Default: 4 (across all layers combined)
    deadlineMs: number;         // Default: Date.now() + 90_000
    attemptsUsed: number;       // Mutated as layers retry
  };
  classify: (err: Error & { status?: number }) => RetryDecision;
  // Optional hook for telemetry — logRetry receives the context.
  onAttempt?: (layer: string, attempt: number, err?: Error) => void;
}

export type RetryDecision =
  | { kind: "retry"; backoffMs: number }
  | { kind: "fallback" }   // Move to next provider in chain (L5 behavior)
  | { kind: "fail" };      // No retry, propagate up
```

Every retry layer:
1. Reads `ctx.budget` before retrying. If exceeded, throws without retry.
2. Increments `ctx.budget.attemptsUsed` on each attempt.
3. Calls `ctx.onAttempt(layerName, attempt, err)` so `retry-telemetry.ts:logRetry` gets a single point of truth with `correlationId`.

L5 (provider cascade) doesn't share the per-attempt budget with L1/L2/L3/L4 — it has its own "providers to try" count. But it still increments `attemptsUsed` so the deadline applies.

## What we are NOT doing

- Replacing the warm-pool subprocess retry (L6). That's an out-of-band concern (spawn-time, before request entry). Documented as out of scope.
- Centralizing error classification. `classifyProviderError` lives in `provider-fallback.ts` and `model-fallback.ts` — both die in P3.C3. The canonical classifier becomes part of `RetryContext.classify`, configurable per request.

## Dependency: P3.C2 ⊃ P4 (mostly)

P3.C2 (implement canonical + migrate callers) intersects P4 the same way P2 does. The cleanest order:

1. **P3.C3 (inline now)**: delete dead `model-fallback.ts:withFallback` + `provider-fallback.ts` entirely. Keep `getProviderHealthStatus` and `resetProviderHealth` (the only live exports).
2. **P4** runs to completion (legacy loops die, retry layers L2/L3/L4 die with them).
3. **P3.C2 (post-P4)**: only L1, L5, L6 remain to consolidate. Plumb `RetryContext` into `tool-executor.withRetry` (L1), `routes/chat.ts` cascade (L5), and warm-pool spawn (L6). The 4-into-1 collapse becomes "wire RetryContext into 3 callers" — a much smaller chunk than the original plan.

---

## P3.C3 execution (this chunk, inline)

### `src/model-fallback.ts` — gut to ~50 LOC

**Keep:**
- `type ProviderId`
- `interface ProviderHealth`
- `healthMap` (module-level Map, internal)
- `loadHealth()` / `saveHealth()` (internal, called by module init + setters)
- `getProviderHealthStatus()` (live, called by routes/agents.ts + routes/settings/system.ts)
- `resetProviderHealth(provider)` (live, called by routes/agents.ts)

**Delete:**
- `withFallback` (entire function, ~40 LOC)
- `recordSuccess` / `recordFailure` (never called)
- `buildFallbackChain` (never called)
- `getBackoffMs` (never called)
- `isProviderAvailable` (only called by withFallback)
- `FallbackResult` / `FallbackChain` interfaces
- All the constants for backoff/circuit (`CIRCUIT_OPEN_DURATION_MS`, `MAX_CONSECUTIVE_FAILURES`, `MAX_RETRIES_PER_PROVIDER`, `BACKOFF_BASE_MS`, `BACKOFF_MAX_MS`, `RATE_LIMIT_BACKOFF_MS`)

**Notes:**
- `resetProviderHealth` previously called `saveHealth()` after mutating. Preserve that.
- The persisted file (`~/.lax/provider-health.json`) becomes effectively a museum (we no longer record success/failure). Acceptable until P3.C2 fixes the real retry story.

### `src/provider-fallback.ts` — delete entirely

Zero call sites confirmed by both audit and grep. No exports referenced elsewhere.

### Behavior contract

- `routes/agents.ts:355` (`getProviderHealthStatus()`) still returns the same shape (empty list, since nothing records, but that's true already).
- `routes/agents.ts:360` (`resetProviderHealth(provider)`) still resets the health entry.
- `routes/settings/system.ts:37` (`getProviderHealthStatus()`) still works.
- No other observable behavior change.

### Smoke test

1. `npm run dev:nowatch` → server boots cleanly.
2. `curl http://127.0.0.1:7007/api/providers/health` → returns `200` with health JSON.

### Commit

```
chore: delete dead retry orchestrators (AUDIT Critical #5, P3.C3)

- model-fallback.ts: gut to ProviderHealth tracking only (~50 LOC).
  Removes withFallback (~40 LOC, 0 callers), recordSuccess /
  recordFailure (0 callers), buildFallbackChain, getBackoffMs,
  isProviderAvailable, FallbackResult, FallbackChain, and 6 unused
  constants. Keeps getProviderHealthStatus + resetProviderHealth
  (live, used by routes/agents.ts and routes/settings/system.ts).
- provider-fallback.ts: deleted entirely (0 import sites).

Net ~430 LOC removed. Standard tsc clean. Server boots and the
provider-health UI endpoint still returns 200.
```
