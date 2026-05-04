# Issue 09 — Anthropic adapter — full conformance + smoke

**Phase:** Vertical slice
**Blocks:** 11
**Blocked by:** 03, 07 (cancel proves abort()), 08 (crash recovery proves provider_state)

---

## Goal

Implement the production Anthropic adapter conforming to the locked v1 contract, wrapping the existing Claude CLI / OAuth path without modifying it. Pass all 9 conformance items (A–I) and 3–5 real-CLI smoke tests. This is the first real-provider canonical-loop op.

## Why it matters

Until the Anthropic adapter exists, canonical-loop is provable only against a fake. v1.0 ship requires a real adapter. The Anthropic adapter is also our reference implementation: Codex (v1.1) studies its pattern but writes its own provider_payload contents.

## Scope

- New module `src/canonical-loop/adapters/anthropic.ts` (or similar) implementing the adapter interface from PRD §15:
  - `runTurn(input, report)`: spawn / re-use existing Claude CLI invocation, stream tokens via `report({kind: "stream_chunk"})`, surface tool calls via `report({kind: "tool_call_requested"})`, finalize messages via `report({kind: "message_finalized"})`, surface transport errors via `report({kind: "error"})`, return `TurnResult` with `provider_state` envelope.
  - `abort()`: kill subprocess + cancel pending stream + release resources; idempotent and safe after completion; resolves once subprocess is actually gone.
  - `provider_state` envelope: `{adapter_name: "anthropic", adapter_version: "<semver>", provider_payload: {...}}`. `provider_payload` contents are adapter's choice (conversation id, last message pointer, anything Anthropic CLI needs to resume).
  - Size cap: enforce 256 KB suggested cap on `provider_state` JSON; fail loudly if exceeded.
- Wire the Anthropic adapter into the worker pool's lane=`interactive` path when flag is ON.
- Do not modify Anthropic OAuth / Claude CLI internals or the auth flow. Adapter is a thin shell.
- Sandbox audit: adapter has no DB handle, no `op_events` writer, no worker pool reference.

## Non-goals

- Modifying Claude CLI or its installation/auth.
- New OAuth flows.
- Codex adapter (issue 12, v1.1).
- Anthropic-specific features beyond what fits the canonical contract.
- Reading messages outside the canonical message replay (no provider-format conversation files outside `provider_state`).

## Likely files / modules

- `src/canonical-loop/adapters/anthropic.ts` — main adapter.
- `src/canonical-loop/adapters/anthropic-stream-parse.ts` — if needed, isolate stream parsing.
- `src/canonical-loop/adapters/anthropic-cli-shell.ts` — subprocess management wrapper.
- `tests/canonical-loop/anthropic-conformance.test.ts` — runs conformance suite (uses runner from issue 02).
- `tests/canonical-loop/anthropic-smoke.test.ts` — real CLI smoke (gated CI).

## Dependencies / blockers

- Issue 03 (canonical-loop happy path).
- Issue 07 (cancel mid-stream, since item E requires `abort()` interrupting an active stream).
- Issue 08 (crash recovery, since items C/D require `provider_state` round-trip).
- Issue 02 (conformance suite runner).

## Acceptance criteria

- Conformance suite passes for Anthropic adapter:
  - A. Text-only turn.
  - B. Tool-call turn through `tool-executor`.
  - C. Cold start with absent `provider_state`.
  - D. Resume with prior `provider_state`.
  - E. `abort()` interrupts active stream within 1s.
  - F. `abort()` idempotent.
  - G. `abort()` safe after completion.
  - H. Transport errors → `error` adapter_report (never thrown out of `runTurn`).
  - I. Adapter does not write DB / events / spawn workers (audit).
- Real CLI smoke (3–5 tests, gated):
  - End-to-end submit through canonical-loop with Anthropic adapter, simple prompt, op reaches `succeeded`.
  - Real cancel mid-stream actually kills the Claude CLI subprocess (no leaked PID; verify via `ps`/equivalent).
  - Real crash recovery: kill worker mid-turn, second worker re-leases, op resumes via `provider_state`.
- No diff in Anthropic OAuth or Claude CLI internals.
- `provider_state` size cap enforced; oversized state surfaces a clear error event, op transitions `failed` (not silent corruption).

## Tests required

- All 9 conformance items A–I via the runner.
- Real CLI smoke (3–5 tests).
- PRD test #1 happy path with Anthropic adapter (end-to-end with real CLI).
- PRD test #2 cancel mid-stream with Anthropic adapter.
- Boundary audit: import scan confirms no DB, event-writer, or worker-pool imports inside adapter modules.

## Definition of done

- [ ] Anthropic adapter passes all conformance items.
- [ ] Real CLI smoke green in CI (gated job).
- [ ] No Anthropic OAuth / Claude CLI internals touched.
- [ ] `provider_state` envelope correctly versioned.
- [ ] Size cap enforced.
- [ ] Sandbox audit clean.
- [ ] Module(s) within 400 LOC each.
