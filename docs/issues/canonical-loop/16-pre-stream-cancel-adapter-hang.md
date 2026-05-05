# Issue 16 — Pre-stream cancel hang in Anthropic adapter

**Status:** Open follow-up. Discovered during long-soak validation
2026-05-05 after the v1.0 seeding fix (commit `32a29b8`).
**Severity:** Medium. Mid-stream cancel (the common case) works. Pre-
stream cancel (rare in practice) leaves the worker awaiting `runTurn`
indefinitely.
**Owner:** unassigned.
**Blocks:** v1.0 cancel reliability claim, but not v1.0 ship — the
common path is green.

---

## Summary

`adapter.abort()` does not reliably unblock the canonical worker's
`await runTurn(...)` while the underlying `claude` CLI subprocess is
still in its pre-stream window (waiting on first byte from the
Anthropic API). The cancel-handler's 1-second abort race completes
on schedule (`safeTransition` flips state to `cancelling`, then
`finalizeCancel` should land at `cancelled`), but the worker's
sequential `await driveTurn → adapter.runTurn → this.inflight` chain
never resolves because the transport's `for await (const ev of stream)`
loop never yields. The op stays at `cancelling` (or still `running`
in some races) until the lease expires.

## Reproduction

1. Submit a canonical interactive op with a prompt that elicits long
   model "thinking time" before first token (e.g., the 1500-word
   internal-combustion-engine prompt — observed 60+ seconds before
   first token).
2. Call `opCancel(opId, actor)` BEFORE any stream chunk has arrived
   (`streamChunkCount === 0`).
3. Observe: `op.canonical.state` stays `running` (or `cancelling`)
   past the 30-second `awaitTerminal` window.

`scripts/canonical-loop-soak-long-interactive.ts --cancel-one` happens
to dodge the bug today only because we changed the cancel-one prompt
to a fast-streaming lighthouse story; an earlier prompt that exercised
this path produced a `state=timeout` failure (logged in the soak
report 2026-05-05).

## Mid-stream cancel works

Cancel issued AFTER at least one stream chunk lands resolves cleanly
within ~1 second:

```
>>> cancelling op op_freeform_cancelone_… mid-stream (streamChunks=22)
[cancel-one] PASS  state=cancelled  21852ms
```

The bug is specific to the pre-stream window.

## Root cause (suspected)

`src/canonical-loop/adapters/anthropic.ts:abort()`:

```ts
async abort(): Promise<void> {
  this.aborted = true;
  try { this.aborter.abort(); } catch { /* ignore */ }
  if (this.inflight) {
    try { await this.inflight; } catch { /* swallow */ }
  }
}
```

`abort()` awaits `this.inflight` (the `consume()` promise wrapping the
transport's for-await loop). If the loop never yields a single event
because the underlying `streamAnthropicResponse` async generator is
blocked spawning the `claude` subprocess and waiting for its first
output, `consume()` never resolves and `abort()` hangs.

The cancel-handler races abort against a 1s timeout
(`cancel-handler.ts:abortWithTimeout`) — that prevents the cancel
handler from blocking, but the worker has its own independent await
on `driveTurn → adapter.runTurn → this.inflight` and is not raced.
Worker stays blocked.

## Fix candidates (evaluate before picking one)

1. **Adapter-side timeout on stream wait.** Wrap the `for await` in
   a watchdog that bails after `aborted === true` even if the stream
   never yields. Cleanest if `streamAnthropicResponse` honors the
   `signal` cleanly elsewhere; if not, this could leak the
   subprocess.
2. **Transport-side `signal` enforcement.** Ensure
   `streamAnthropicResponse` propagates `AbortSignal.aborted` through
   to the subprocess `kill()` and ends its async generator
   immediately. Likely the right place to fix it; touches existing
   `src/anthropic-client/stream-cli.ts` (out of canonical-loop's
   scope, but in-range for adapter-transport).
3. **Worker-side runTurn race with cancel.** Race
   `adapter.runTurn(...)` against a `tracker.cancelled`-triggered
   promise inside `driveTurn`. Last-resort fallback if 1 and 2 are
   too invasive.

## Acceptance criteria

- New test: submit a canonical op with a programmable transport that
  hangs on first yield, call `opCancel`, assert state reaches
  `cancelled` within 2 seconds.
- Long-soak `--cancel-one` passes regardless of whether streaming has
  begun (no need for a fast-stream prompt workaround).
- No subprocess leakage on abort (tasklist sweep or transport-level
  assertion).

## Out of scope

- Mid-stream cancel changes (already works).
- Lifecycle / state-machine changes (state machine is correct; the
  hang is in I/O, not state).
- Build / IDE lane changes.
