# Fix Plan: Audit Findings (Concurrency, Cleanup, Context Preservation)

## Context

A code-review audit identified seven findings in Open Agent X. Phase-1
exploration verified each with file:line evidence and surfaced three additions
(voice hardcoded sessionId, the `wireWsChat` self-loop hang, the never-read
compaction summary).

After reviewing the original audit, three of its framings were too blunt or
slightly off and have been revised:

- **Codex incremental mode**: don't disable it. Add a compact "current task /
  latest user intent / active tool loop" context envelope so tool-result-only
  turns retain grounding while the cost win stays. Disable becomes a
  diagnostic switch only.
- **Findings 2 and 5 are one bug class**: process-global session state.
  `activeOnEvent`, `activeBrowserSessionId`, `Handler.currentSessionId` —
  same root cause, fix systematically in one pass.
- **Memory is attribution, not filtering**. Cross-session memory is a feature.
  The bug is that retrieved memory lacks strong attribution and usage
  guidance. Same-session results should be clearly marked and preferred;
  cross-session results should carry source/session/time/relevance metadata
  so the agent can reason instead of treating them as current-thread
  context.

The intended outcome is a system that handles concurrent sessions safely,
cleans up resources on every error path, attributes context clearly so the
agent reasons over it, and preserves grounding through tool loops.

## Amended fix order

Earlier steps protect later steps from leaking state when they fail.

---

### Step 1 — Lifecycle hygiene in `/api/chat`

**Problem.** Phase 1 found multiple paths in `src/routes/chat.ts` that don't
clean up:
- Outer catch (line 324) doesn't clear `activeOnEvent`.
- Turn-lock-refused early return (line 136) doesn't clear `activeOnEvent`
  and doesn't `clearInterval(heartbeat)`.
- No-API-key bail (line 78) doesn't emit a terminal `done` event.

**Fix.**
- Wrap the handler body (lines 61–331) in a single `try/finally`. The
  `finally` block must:
  - Call `releaseTurnLock(sessionId)` (idempotent).
  - Call `ctx.setActiveOnEvent(undefined)` (or per-session-map equivalent
    after Step 2).
  - `clearInterval(heartbeat)` if defined.
  - Emit a `done` SSE event if not already emitted (track via a flag).
  - `res.end()` if not already ended.
- The no-API-key path joins the same `finally` instead of returning early.

**Files.** `src/routes/chat.ts`.

**Effort.** ~30 min.

---

### Step 2 — Replace process-global session state with explicit session plumbing

**Problem.** Three module-level globals hold per-session state and race
under concurrent sessions. They are the same bug class:
- `Handler.getInstance().currentSessionId` (writers in `chat.ts:92`,
  `background-jobs.ts:54`; readers in `agency/handler.ts:112,586`).
- `activeOnEvent` callback in `ServerContext` (set/cleared in
  `chat.ts:88,260`; read in `routes/mcp.ts:53` and many `tool-executor.ts`
  lines).
- `activeBrowserSessionId` (writer in `chat.ts:90`; readers in
  `bootstrap-tools.ts:42–48`).

A `_sessionId` injection mechanism already exists in
`src/tool-executor.ts:274` for `browser`, `operation_start`, `enter_plan_mode`,
`exit_plan_mode`, `skill_run`, `usage_report`. Extending it covers tool-side
of the fix; the callback maps cover server-side.

**Fix.**

a. **Tool-level (mechanical).** Add to the `_sessionId` injection list at
   `src/tool-executor.ts:274`:
   - `agent_spawn`
   - `browser_capture_to_secret`
   - `browser_fill_from_secret`
   - `session_status`
   These tools already accept `args._sessionId` as the primary path
   (Phase 1 confirmed). Once injected, the singleton-callback fallbacks
   become dead code paths and can be deleted in a follow-up.

b. **`Handler.currentSessionId` writes.** Remove the writes in
   `routes/chat.ts:92` and `background-jobs.ts:54`. Pass `sessionId`
   explicitly to `Handler.spawnAgent()` via the existing `parentSessionId`
   parameter. The fallback at `agency/handler.ts:112` becomes dead code;
   delete it.

c. **`activeOnEvent` per-session map.** Replace the single mutable callback
   on `ServerContext` with `Map<sessionId, EventCallback>`. Setter
   becomes `setActiveOnEvent(sessionId, fn)`, getter becomes
   `getActiveOnEvent(sessionId)`. Update `routes/mcp.ts:53` and every
   `tool-executor.ts` event-emit site to look up by sessionId — the
   executor already has sessionId at `tool-executor.ts:583`.

d. **`activeBrowserSessionId`.** Drop the global entirely. Once (a) ensures
   every browser/secret tool call carries `_sessionId`, the global is
   redundant.

**Files.** `src/tool-executor.ts`, `src/agency/handler.ts`,
`src/server-context.ts`, `src/routes/chat.ts`,
`src/server/background-jobs.ts`, `src/server/request-handler.ts`,
`src/server/bootstrap-tools.ts`, `src/routes/mcp.ts`,
`src/browser-secret-capture.ts`, `src/browser-secret-fill.ts`,
`src/session-status-tool.ts`.

**Effort.** ~3–4 hours. Most files get a 2–5 line touch; the
ServerContext change ripples through callers but each ripple is small.

---

### Step 3 — Voice session identity (no more hardcoded "voice")

**Problem.** `src/server/lifecycle.ts` line 83 (in
`prepareAgentRequest`) and line 123 (in `runAgent`) hardcode
`sessionId: "voice"`. Two concurrent voice connections share every
downstream global — secrets, browser state, memory writes, sub-agent
inheritance — because they're all tagged with the same id.

**Fix.**
- In the voice WebSocket setup path (likely `src/voice/audio-ws.ts`
  `setupVoiceWebSocket` or `createVoiceSession`), generate
  `voice-${crypto.randomUUID()}` per connection.
- Thread that generated id through to both `prepareAgentRequest` and
  `runAgent` calls in `lifecycle.ts:83,123`.
- Verify the voice session-state map (in `voice/voice-session.ts`,
  `voice/gpu-session.ts`) keys correctly by the new id.

**Files.** `src/server/lifecycle.ts`, `src/voice/audio-ws.ts`,
`src/voice/voice-session.ts`, `src/voice/gpu-session.ts`.

**Effort.** ~45 min.

---

### Step 4 — Serialize the shared browser resource with a queue and session-labeled registry

**Problem.** `src/browser.ts:354–388` returns a single global
`BrowserManager` regardless of `_sessionId`. Two sessions hitting browser
tools concurrently can race on page navigation and on the observation-ref
registry (`registry.reset()` clears refs for every session, per Phase 1
note at line 327).

**Fix.**
- Keep the single shared browser instance — per-session Chromium contexts
  cost ~200MB each.
- Add an explicit per-process **browser mutex** in `src/browser.ts`. Wrap
  every browser-tool execute path in a promise queue:
  ```ts
  let chain: Promise<unknown> = Promise.resolve();
  export function withBrowserLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {}); // never break the chain on error
    return next;
  }
  ```
- When session A is holding the lock and session B enqueues, emit a
  `browser_queued` event so the user gets feedback rather than
  unexplained latency.
- Add **session-labeled current-tab ownership**: track which session owns
  the active tab. When the lock changes hands, log the handover so debug
  traces clearly attribute browser actions.
- Audit observation-ref registry; ensure `registry.reset(sessionId)`
  scopes to the calling session (Phase 1 noted line 327 calls global
  reset, which is wrong).

**Files.** `src/browser.ts`, `src/browser/launcher.ts`, any tool that
calls `registry.reset()`.

**Effort.** ~1.5–2 hr.

---

### Step 5 — Memory attribution and same-session preference (without blocking cross-session)

**Problem.** Cross-session memory is a product feature, not a bug.
The actual bug is that retrieved snippets reach the agent's prompt
without strong source attribution. Today:
- `src/memory/manager.ts:103` calls `autoSearchContext` without
  `input.sessionId`, so the existing same-session +20% boost in
  `applySessionGrouping()` (`memory/index-search.ts:249–272`) never
  activates.
- The injection wrapper in `autoSearchContext` (`memory/context.ts`
  lines 162–169) gives one global warning ("may be from DIFFERENT chats")
  but per-snippet attribution is weak: no session id, no timestamp, no
  source title attached to each result.

The agent can't reason about which snippet is current-thread vs. a
months-old past chat without that metadata.

**Fix.**

a. Pass `sessionId` through the call:
   `src/memory/manager.ts:103` →
   `autoSearchContext(this.index, input.userMessage, { sessionId: input.sessionId })`.
   This activates the existing same-session boost for free.

b. Decorate each search result with attribution metadata when rendered
   into the prompt. Each snippet block should include:
   - `[SAME-SESSION]` or `[OTHER-SESSION]` tag
   - Session title + timestamp (e.g. `"Chat: GitHub Pages setup · 3 days ago"`)
   - Source file path if applicable
   - Relevance score
   The model already gets the snippet body — the bug is missing context.

c. Update the wrapper text in `autoSearchContext` to instruct the agent
   how to read the attribution: "Treat SAME-SESSION snippets as continuing
   context. Treat OTHER-SESSION snippets as background knowledge — useful
   for facts and decisions, but not menus, lists, or questions to answer
   directly."

d. Verify `MemorySearchResult.metadata` already carries the session_id
   field (Phase 1 confirmed it does via `r.metadata?.session_id`); if
   timestamp / title aren't there, extend `index-search.ts` `postProcess`
   to populate them.

**Files.** `src/memory/manager.ts`, `src/memory/context.ts`,
`src/memory/index-search.ts` (only if metadata extension needed).

**Effort.** ~1.5–2 hr.

---

### Step 6 — Orchestrator signal telemetry (produced vs injected vs ignored)

**Problem.** The orchestrator's conversational modules (emotional-memory,
narrative-memory, proactive-memory, anticipatory-care, unspoken-detector,
inside-references, growth-tracker, shared-history) emit signals into a
fusion pool. `mergeSignals` at `src/orchestrator/signals.ts:30` drops
everything outside the top `MAX_CONTEXT_SIGNALS`. Runtime logging at
`src/memory/manager.ts:125` only emits module count and total time, not
which signals survived. The debug object has detail but no durable trace.

Result: half the conversational modules might be running on faith with no
proof anything they emit reaches the agent.

**Fix.**
- In `mergeSignals`, before returning, build a structured trace:
  `{ produced: SignalRef[], injected: SignalRef[], dropped: SignalRef[] }`
  where each `SignalRef` has `{ moduleName, type, priority, content?: shortPreview }`.
- Emit the trace via the structured logger (one line per turn, JSON when
  `LAX_LOG_JSON=1`).
- Optional: append to a JSONL file at `~/.lax/telemetry/signals.jsonl`
  (mirroring `retry-telemetry.ts` pattern) so it's queryable
  post-hoc with `jq`.
- After a few days of runtime, you can answer "which conversational
  modules ever inject anything" — and decide what to keep, what to demote
  to background-only, what to delete.

**Files.** `src/orchestrator/signals.ts`,
`src/memory/manager.ts`, optionally a new `src/orchestrator/signal-telemetry.ts`.

**Effort.** ~1 hr.

---

### Step 7 — Verify compaction summary loss empirically (then fix or delete)

**Problem.** `/api/compact` at `src/routes/chat.ts:20–42` writes
`session.compactedSummary`. Phase 1 confirmed no code path ever reads
the field. Either wire it in or delete the storage.

**Fix.**

a. **Verify first.** Add a debug log line to
   `src/agent-request/prepare-request.ts` that prints whether
   `session.compactedSummary` is present at request-prep time. Run a
   real compaction + follow-up turn. Confirm the field is set but
   ignored.

b. **Then fix.** In `prepare-request.ts` (or
   `src/providers/sanitize.ts` `truncateHistory`), check for
   `session.compactedSummary`. When present and `compactedAt` matches
   current truncation point, prepend the stored summary as a system
   message instead of regenerating from remaining messages.

c. The compaction summary needs to survive Codex incremental mode (Step
   8) — the envelope in Step 8 should preserve the most recent system
   message.

**Files.** `src/agent-request/prepare-request.ts`,
possibly `src/providers/sanitize.ts`.

**Effort.** ~1 hr.

---

### Step 8 — Codex incremental: preserve user/task context envelope

**Problem.** `src/agent-codex/run-http.ts:125–147` sends only tool results
in incremental mode, dropping the original user message and the system
summary. Codex subscription endpoint rejects `previous_response_id`
(`codex-client.ts:129–132`), so server-side state chaining doesn't fill
the gap.

**Don't disable incremental mode.** It's the biggest cost win for Codex.
A disable flag should exist as a diagnostic switch only.

**Fix.**
- When sending an incremental tool-result-only payload, prepend a
  compact **context envelope**:
  1. The most recent system message (compaction summary or system
     prompt — preserved from Step 7).
  2. The most recent user message of the current turn ("active intent").
  3. A one-line "active tool loop" header naming the goal of the loop
     (extracted from the user message or set by the agent).
  4. Then the new tool results.
- The envelope is a small constant overhead per loop iteration —
  preserves grounding without losing the cost win.
- Add an env flag `LAX_CODEX_INCREMENTAL=0` for diagnostic disable.

**Files.** `src/agent-codex/run-http.ts`.

**Effort.** ~1 hr. Verify with a multi-tool-call Codex turn that the
model stays on task across iterations.

---

### Step 9 (bonus) — `wireWsChat` self-loop hang propagation

**Problem.** Not in original audit; surfaced by Phase 1. The self-loop in
`src/server/lifecycle.ts:151–170` calls `/api/chat` over local fetch and
drains the body. If `/api/chat` hangs, fetch waits 600 s before timing
out, then logs and exits — but **never tells the WS client**. The
client-side `activeChats` entry stays `done: false` until the 5-minute
cleanup at `chat-ws.ts:234`.

**Fix.**
- On fetch error or timeout in the `onChat` handler at
  `lifecycle.ts:156–169`, broadcast an error event to the chat-ws so the
  client receives a terminal signal.

**Files.** `src/server/lifecycle.ts`, possibly `src/chat-ws.ts`.

**Effort.** ~30 min.

---

## Critical files to modify (consolidated)

- `src/routes/chat.ts` (Steps 1, 2)
- `src/tool-executor.ts` (Step 2)
- `src/agency/handler.ts` (Step 2)
- `src/server-context.ts` (Step 2)
- `src/server/request-handler.ts` (Step 2)
- `src/server/bootstrap-tools.ts` (Step 2)
- `src/server/background-jobs.ts` (Step 2)
- `src/server/lifecycle.ts` (Steps 3, 9)
- `src/voice/audio-ws.ts` (Step 3)
- `src/voice/voice-session.ts`, `src/voice/gpu-session.ts` (Step 3)
- `src/routes/mcp.ts` (Step 2)
- `src/browser-secret-capture.ts`, `src/browser-secret-fill.ts` (Step 2 cleanup)
- `src/session-status-tool.ts` (Step 2 cleanup)
- `src/browser.ts`, `src/browser/launcher.ts` (Step 4)
- `src/memory/manager.ts`, `src/memory/context.ts` (Step 5)
- `src/memory/index-search.ts` (Step 5, only if metadata extension)
- `src/orchestrator/signals.ts` (Step 6)
- `src/agent-request/prepare-request.ts`, `src/providers/sanitize.ts` (Step 7)
- `src/agent-codex/run-http.ts` (Step 8)

## Reusable code paths to leverage

- **`_sessionId` injection** at `src/tool-executor.ts:274` — extend the
  list, don't invent a new pattern.
- **`tryAcquireOrReplace` / `releaseTurnLock`** in
  `src/session-turn-lock.ts` — already correct; just ensure release runs
  on all paths.
- **`SearchOptions.sessionId`** in `src/memory/index-search.ts:29` and
  **`applySessionGrouping()`** at line 249 — already implemented; just
  pass the sessionId through.
- **`r.metadata?.session_id`** in `MemorySearchResult` — already populated;
  just expose it in attribution rendering.
- **`crypto.randomUUID()`** for the voice session id.
- **`src/retry-telemetry.ts` JSONL pattern** — mirror it for the new
  signal-telemetry trace in Step 6.

## Followup risk to track (not blocking)

`safeRun` at `src/orchestrator/state.ts:33` is sync-only. Current
orchestrator blocks happen to be synchronous, but any future async
module placed inside `safeRun` will escape its error capture. Worth
tracking but not part of this fix.

## Verification

- **Static.** `npx tsc --noEmit` — must pass with zero errors after each
  step.
- **Concurrency smoke test.** Two browser tabs, two sessionIds,
  simultaneous messages. Confirm no event from one session leaks to the
  other's SSE; no log line shows cross-session sub-agent inheritance.
- **Voice concurrency.** Two voice connections (or voice + text). Confirm
  separate per-connection UUIDs in logs.
- **Browser serialization.** Two parallel browser-using flows. Confirm
  they queue cleanly and emit `browser_queued` events.
- **Memory attribution.** With past sessions in the store, send a
  `memory_search` query. Confirm each snippet renders with
  `[SAME-SESSION]` / `[OTHER-SESSION]` tag, session title, and timestamp.
- **Signal telemetry.** Observe `signals.jsonl` after a few real turns;
  cross-reference produced vs injected counts per module.
- **Compaction reuse.** Call `/api/compact`, send a follow-up. Verify the
  assembled system prompt contains the stored summary, not a fresh one.
- **Codex incremental.** Multi-tool-call Codex request; verify each
  iteration's payload contains the context envelope (system + user +
  loop header).
- **Existing tests.** `npm test` and `tsx src/test-suite.ts` should still
  pass.

## Estimated total effort

~9–12 hours of focused work, sequenced as above.
