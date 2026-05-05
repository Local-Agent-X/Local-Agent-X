# v1.1 Codex interactive adapter — design

**Status:** Design only. No implementation yet. Companion to
[12-codex-v1-1.md](12-codex-v1-1.md) (the v1.1 issue).
**Locked v1.0 contract:** [PRD §15](../../canonical-loop-prd.md#15-adapter-contract).
**Reference implementation:** Anthropic adapter at
[src/canonical-loop/adapters/anthropic.ts](../../../src/canonical-loop/adapters/anthropic.ts)
+ transport at
[src/canonical-loop/adapters/anthropic-transport.ts](../../../src/canonical-loop/adapters/anthropic-transport.ts).

The whole point of v1.1: prove the loop is provider-neutral by landing
a second adapter against the locked contract, with **zero loop
changes**, and pass the same A–I conformance suite. If something
doesn't fit, the Codex adapter adapts — never the contract.

---

## 1. Goal

Land `src/canonical-loop/adapters/codex.ts` + a transport boundary
file `src/canonical-loop/adapters/codex-transport.ts`. Wrap the
existing `streamCodexResponse` async generator from
[src/codex-client.ts](../../../src/codex-client.ts). No modifications
to the Codex executor, codex-client, codex-message-convert, or any
v1.0 canonical-loop module.

## 2. What's already on disk vs. what we'll add

| Existing (untouchable) | Role |
|---|---|
| [src/codex-client.ts](../../../src/codex-client.ts) | HTTP client, async generator yielding `text` / `tool_call` / `reasoning` / `done`. |
| [src/codex-message-convert.ts](../../../src/codex-message-convert.ts) | OpenAI `ChatCompletionMessageParam[]` → Codex Responses API input shape. |
| [src/codex-session.ts](../../../src/codex-session.ts) | Codex auth/session helpers (token via `loadTokens()` + chatgpt-account-id JWT extraction). |
| [src/agent-codex/](../../../src/agent-codex) | Existing legacy executor; canonical adapter does NOT touch this. |
| [src/agent-request/resolve-provider.ts](../../../src/agent-request/resolve-provider.ts) | Resolves `codexApiKey` (ChatGPT OAuth or `OPENAI_API_KEY`). |

| New (this issue) | Role |
|---|---|
| `src/canonical-loop/adapters/codex.ts` | The audited adapter file. Implements `Adapter` interface. **No** DB / events / worker-pool / `child_process` / `streamCodexResponse` imports — only the transport interface. |
| `src/canonical-loop/adapters/codex-transport.ts` | Transport boundary. Allowed to import `streamCodexResponse` and resolve auth. Same role as `anthropic-transport.ts`. |
| `test/canonical-loop-12-codex-conformance.test.ts` | Runs the existing locked conformance suite against the Codex adapter via a programmable Codex transport mock. |
| `test/canonical-loop-12-codex-smoke.test.ts` | Gated real-CLI smoke tests, opt-in via `LAX_RUN_CODEX_SMOKE=1`. |
| `test/canonical-loop/codex-mock-transport.ts` | Programmable transport fixture for conformance (mirrors `anthropic-mock-transport.ts`). |

## 3. Adapter surface (mirrors Anthropic adapter byte-for-byte where possible)

```ts
export const CODEX_ADAPTER_NAME = "codex";
export const CODEX_ADAPTER_VERSION = "1.0.0";

export interface CodexTransport {
  stream(req: CodexTransportRequest): AsyncIterable<TransportEvent>;
}

export interface CodexTransportRequest {
  model: string;
  systemPrompt: string;
  messages: TransportMessage[];   // role: system|user|assistant|tool
  tools: TransportTool[];
  signal: AbortSignal;
  temperature?: number;
}

export type TransportEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "reasoning"; summary: string }   // Codex-specific; passed through as a stream chunk
  | { type: "error"; code: string; message: string; retryable?: boolean }
  | { type: "done"; stopReason?: string };
```

`Adapter` implementation lives in `codex.ts` with the same shape as
`AnthropicAdapter`:
- `runTurn(input, report) → Promise<TurnResult>`
- `abort() → Promise<void>`
- aborted flag flipped on abort
- fresh `AbortController` per turn so the adapter is reusable across
  resume turns (conformance D)
- the inflight stream consumer is awaited so abort resolves only when
  the adapter is actually stopped

## 4. Streaming → canonical mapping

| Codex client event | Canonical `AdapterReport` | Notes |
|---|---|---|
| `text { delta }` | `stream_chunk { delta }` + accumulate | Same as Anthropic. Single `assistant` `message_finalized` at end of turn. |
| `tool_call { id, name, arguments }` | `tool_call_requested { call }` | Loop dispatches via `tool-executor`; result rides back as `tool_result` canonical message in next turn. |
| `reasoning { item }` | `stream_chunk { reasoning: <summary> }` | Codex-specific — passed through ephemerally. Not persisted. Not converted to a message. |
| `done { usage, responseId, reasoning }` | not surfaced | `usage`/`responseId` recorded inside `provider_state.providerPayload` for telemetry / future continuation. |
| HTTP error → caught | `error { code, message, retryable }` | Routine errors NEVER throw out of `runTurn` (PRD §15 H). Same secret-redaction regex pattern as Anthropic adapter. |

Tool args truncation: the Codex client already drops mid-stream
truncated tool calls (see `codex-client.ts:441`). The adapter
forwards only complete tool calls — silent drops surface as a single
`error` adapter_report with `code: "tool_call_truncated"` so the loop
fails the turn cleanly instead of silently committing a hollow turn.

## 5. `provider_state` envelope

```ts
{
  adapterName: "codex",
  adapterVersion: "1.0.0",
  providerPayload: {
    lastTurnIdx,
    finalizedMessageId | null,
    stopReason | undefined,
    pendingTools,                  // count of outstanding tool calls
    usageInputTokens | undefined,  // observability only
    usageOutputTokens | undefined,
    responseId | undefined,        // captured but NOT used for chaining (see §6)
  }
}
```

256 KB cap (PRD §21) enforced before return — same as Anthropic
adapter. Oversize fails loud via `error` adapter_report with code
`provider_state_oversize`.

## 6. Why we don't use `previous_response_id`

`codex-client.ts:132-135` documents that the ChatGPT subscription
endpoint rejects `previous_response_id` with HTTP 400. Continuation
between turns is therefore **message-level only** — every turn
replays the full `op_messages` history through the adapter, exactly
how the Anthropic adapter behaves. `responseId` is captured in
`provider_state` for telemetry / future migration to the public
Responses API, but never sent back. This means resume after crash
recovery works the same as Anthropic: messages are the source of
truth.

## 7. Abort lifecycle

- HTTP-based, not subprocess. `abort()` flips `aborted = true`,
  calls `aborter.abort()` which signals the underlying `fetch` /
  HTTP client (via `AbortSignal` passed into `streamCodexResponse`),
  and awaits the inflight consumer.
- Idempotent (F): two `abort()`s no-op.
- Safe after completion (G): `aborter.abort()` on a finished
  controller is a no-op.
- **Pre-stream cancel:** Codex transport is HTTP, not subprocess —
  no first-byte-handshake hang. Cancel during the connection-
  establishment window should propagate cleanly via fetch's signal.
  This is the bug class flagged in [Issue 16](16-pre-stream-cancel-adapter-hang.md);
  Codex likely sidesteps it by virtue of the transport. Worth a
  conformance test to confirm.

## 8. Auth flow

Token resolution lives entirely in `codex-transport.ts`. Lazy at
first request:

1. Try `loadTokens()` from `auth.js` (ChatGPT OAuth — JWT containing
   the `chatgpt-account-id` we extract for the request header).
2. Fall back to `OPENAI_API_KEY` from `secretsStore` if no OAuth.
3. If neither resolves, yield a single `error` event with
   `code: "auth_unavailable"` and `done`. Adapter surfaces as an
   `error` adapter_report and ends the turn with
   `terminalReason: "error"`.

Token never enters `provider_state`, never appears in events.
Same secret-redaction guard at the adapter boundary.

## 9. Tools

The Codex client expects tool definitions in the OpenAI function-tool
shape (`{ type: "function", name, description, parameters }`).
Convert from canonical `ToolDescriptor` exactly like Anthropic
adapter does. No tool-executor changes — the loop's
`tool_call_requested` → `tool-executor` → `tool_result` round-trip
already works regardless of provider.

## 10. Conformance plan

Reuse the existing locked suite at
[test/canonical-loop-09-anthropic-conformance.test.ts](../../../test/canonical-loop-09-anthropic-conformance.test.ts)
as the structural template. Build a `codex-mock-transport.ts` fixture
that lets tests script per-turn streams (text deltas, tool calls,
reasoning events, errors, done). The new test file
`canonical-loop-12-codex-conformance.test.ts` runs the same A–I
items plus three Codex-specific items:

| ID | Test | Same as Anthropic? |
|---|---|---|
| A | Text-only turn | identical |
| B | Tool-call turn → tool_executor → next-turn tool_result | identical |
| C | Cold-start absent provider_state | identical |
| D | Resume with prior provider_state | identical |
| E | abort() interrupts active stream within 1s | identical |
| F | abort() idempotent | identical |
| G | abort() safe after completion | identical |
| H | Transport errors → `error` adapter_report, no throw | identical |
| I | Adapter source has zero `FORBIDDEN_ADAPTER_IMPORTS` matches | identical |
| J (new) | Reasoning events forwarded as `stream_chunk`, never persisted as messages | Codex-only |
| K (new) | Truncated tool call surfaces as `error` + `tool_call_truncated` | Codex-only |
| L (new) | Pre-stream cancel resolves cleanly (Issue 16 sanity check) | Codex-only |

Items J–L extend coverage; they don't modify A–I or the loop. The
boundary audit `test/canonical-loop-11-boundary-audit.test.ts`
already audits every file in `src/canonical-loop/adapters/` against
`FORBIDDEN_ADAPTER_IMPORTS`; `codex.ts` will be picked up
automatically. `codex-transport.ts` joins
`anthropic-transport.ts` on the allow-list.

## 11. Bootstrap wiring

Two reasonable options for selecting which adapter to run on the
interactive lane:

**A. Per-op routing via existing `resolve-provider.ts`.** The
canonical seam consults `resolveProvider(op)` and registers either
`createAnthropicAdapter()` or `createCodexAdapter()` per-op via
`registerAdapterForOp(op.id, factory)`. This gives the chat agent's
existing `preferred_provider` hint full effect: ops asking for Codex
get Codex, ops asking for Anthropic get Anthropic, both go through
canonical-loop. Cleanest but touches the seam.

**B. Lane-default chooser.** Update
`bootstrapCanonicalLoop()` to pick the lane default based on the
same provider-resolution logic. Slightly less granular (every op on
the interactive lane gets the same adapter for that boot) but no
seam changes.

**Recommendation: A.** Already the natural extension of how
provider routing works today. Implementation: add a single helper in
`canonical-loop-bootstrap.ts` (or a new `canonical-loop-router.ts`)
that builds the per-op factory based on `op.contextPack.routing.preferredProvider`
+ `resolveProvider`. Default is still Anthropic when the resolver
returns no preference and OAuth is present.

## 12. Open questions / known unknowns

1. **Reasoning event placement.** Currently planned to ride
   `stream_chunk`. Alternative: drop entirely and only surface in
   `provider_state.providerPayload.reasoning` (matches what Codex
   already returns in `done`). User-visible streaming UI would lose
   reasoning text under the alternative, which feels worse.
   Default to stream_chunk unless there's a privacy concern with
   reasoning text leaking past redaction.
2. **Per-turn temperature.** `streamCodexResponse` accepts
   `temperature` but the existing client doesn't pass it through
   from op metadata. Punt to v1.1.1 unless someone needs it.
3. **Continuation strategy.** Without `previous_response_id`, every
   turn ships the full message history. For ops with 50+ turns,
   this could exceed Codex's input window. Existing Codex executor
   handles this with `agent-codex/run-http-helpers.ts`'s
   turn-token-ceiling logic. Canonical-loop adapter does NOT
   implement that — long ops just fail when they hit the cap. Mark
   as known limitation; address in v1.2 if it matters.
4. **Conformance suite reuse.** Should we extract A–I into a
   provider-agnostic suite that both adapters import, or duplicate
   the test file once? Probably extract — Issue 13 (build_app
   adapter) will want the same suite. Single shared suite reduces
   maintenance and prevents drift. Out of scope for v1.1, log as
   v1.2-prep follow-up.

## 13. Sequencing / sub-tasks

Vertical slices, each independently mergeable behind the flag:

1. `codex-transport.ts` + `codex.ts` skeleton with all reports stubbed.
2. Programmable `codex-mock-transport.ts` fixture.
3. `canonical-loop-12-codex-conformance.test.ts` (A–I + J–L).
4. Boundary audit confirmation (no source change required — automatic).
5. Bootstrap wiring (per-op factory selection).
6. Real-CLI smoke (gated, opt-in).
7. Re-run Anthropic conformance to prove zero regression.
8. Tag `canonical-loop-v1.1`.

Estimated module sizes (≤400 LOC each per PRD):
- `codex.ts` ~ 350 LOC (mirror of `anthropic.ts:394`)
- `codex-transport.ts` ~ 130 LOC (mirror of `anthropic-transport.ts:119`)
- conformance test ~ 350 LOC
- mock transport ~ 100 LOC

## 14. Out of scope (explicit)

- Modifying `tool-executor.ts`, the existing Codex executor, codex-client, or any v1.0 canonical-loop module.
- Build / IDE lane work (v1.2 / v1.3).
- New event types or adapter contract changes.
- Address Issue 16 — it's an Anthropic adapter bug; conformance item L just confirms Codex doesn't share it.
- Multi-provider concurrency tuning.

## 15. Risk assessment

**Low risk:** the Codex client is already battle-tested via the
legacy path; this is a wrapping exercise. The hardest part is
making sure the adapter file itself stays sandbox-clean — and the
boundary audit catches that automatically. Reasoning event handling
is the only design question that doesn't have a clear precedent.

**Where it could go sideways:**
- If `previous_response_id` is the only way to hold reasoning state
  across turns reliably, the message-only continuation may degrade
  multi-turn quality. v1.0 doesn't exercise this; we'll find out.
- If Codex auth tokens expire mid-turn, the transport must surface
  `auth_expired` cleanly without leaking the token in error
  messages. Existing redaction regex covers `Bearer …` patterns.
- Reasoning event volume could overwhelm bus subscribers if they're
  forwarded as stream chunks. Existing Anthropic adapter's stream
  chunk delivery is fine at 50–100 chunks/sec; Codex reasoning
  arrives less frequently and shorter, so this is unlikely to bite.

---

**Implementation gate:** none of this lands until v1.0 has at least
one week of real interactive canary traffic with no Issue 16
recurrence in the wild and no new ship-blockers. v1.0 just shipped
2026-05-05; earliest reasonable v1.1 implementation start is
~2026-05-12, contingent on canary clean.
