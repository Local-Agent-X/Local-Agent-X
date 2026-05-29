# ADR 0001 — Keep retry-telemetry (and retry-context) separate from auto-retry

Status: Accepted — 2026-05-29

## Context

`auto-retry.ts` is the sole surviving retry layer (the former L1–L6 stack
collapsed to L1). `retry-context.ts` and `retry-telemetry.ts` look like shallow
leftovers of that collapse, and an architecture review proposed folding both
into `auto-retry.ts` as private detail.

Verification against the source showed the premise was wrong:

- **retry-telemetry.ts** is not retry-loop-private. `auto-retry.ts` never calls
  `logRetry`. Its real callers are `agent-guards/loop-detection.ts`,
  `tool-execution/resolve-tool.ts`, and `tool-execution/enforce-policy.ts`, and
  it records 8 event kinds (model-fallback, context-overflow, mcp-handled-tool,
  …). It is a cross-subsystem telemetry sidecar.
- **retry-context.ts** is a session-keyed store threaded across subsystems —
  created/attached in `routes/chat/run-chat-turn/orchestrator.ts` and read in
  `tool-execution/run-sandboxed.ts` at the `withRetry` call site. It is a
  side-channel precisely because it cannot be a private `auto-retry` local.

## Decision

Leave `retry-telemetry.ts` as an independent sidecar. Do not fold it into
`auto-retry.ts` — doing so would invert the dependency (telemetry living inside
the thing it observes) and force unrelated subsystems to import a logger out of
the retry module.

`retry-context.ts` may eventually fold into `auto-retry.ts`, but only in a task
scoped to also update its `tool-execution` consumers. It is out of scope for a
retry-only change.

## Consequences

- The retry/resilience file count stays at five; that is correct factoring, not
  a premature split.
- Future architecture reviews should not re-flag retry-telemetry as a fold
  candidate. The module's spread of callers is the signal that it is shared
  infrastructure.
