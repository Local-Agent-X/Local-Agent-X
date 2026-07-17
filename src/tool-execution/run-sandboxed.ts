// Sandboxed-execute phase: inject _onProgress, run tool.execute() with the
// transient-error retry policy, apply the delivery-point taint policy
// (sensitive-read-taint.ts — taint commits only for bytes that actually reach
// the model; fully-stubbed results never taint), then record stats /
// circuit-breaker state / rate-limit consumption.

import type { ServerEvent } from "../types.js";
import { circuitArgsSig, recordCircuitFailure, recordCircuitSuccess } from "../circuit-breaker.js";
import { recordToolCall as recordToolStat } from "../tool-tracker.js";
import { recordToolCall as recordRateLimit } from "./rate-limiter.js";
import { setPreExecuteTaintFloor, applyResultTaintPolicy } from "./sensitive-read-taint.js";
import type { Phase } from "./context.js";
import { CONTINUE } from "./context.js";
import { RetryableToolResultError } from "../resilience-policy.js";
import { ToolTimeoutError } from "./tool-timeout.js";
import { timeout, blocked, ok } from "../tools/result-helpers.js";
import { resolveAgentPath } from "../workspace/paths.js";
import { isAbsolute } from "node:path";
import { checkFreshness, recordFileSeen, unchangedSinceSeen, seenViewFromReadResult } from "../tools/read-state.js";
import { unattendedShellBlock } from "./unattended-shell-gate.js";
import { createToolRunner } from "./tool-runner.js";

// Edit-family tools that must not touch a file the session hasn't seen the
// current bytes of (stale-read guard). Read-before-edit, enforced at the layer
// that actually knows the session — not inside the tool, which doesn't.
const FRESHNESS_GUARDED: ReadonlySet<string> = new Set(["edit", "edit_lines", "multi_edit"]);
// Tools that leave the session knowing a file's current on-disk bytes.
const RECORDS_SEEN: ReadonlySet<string> = new Set(["read", "write", "edit", "edit_lines", "multi_edit"]);

export const runSandboxedPhase: Phase = async (ctx) => {
  const { tc, tool, args, sessionId, signal, onEvent } = ctx;
  if (!tool) return CONTINUE;

  const shellBlock = unattendedShellBlock(tc.name, ctx.callContext);
  if (shellBlock) {
    ctx.result = shellBlock;
    return CONTINUE;
  }

  // Progress messages double as the timeout path's partial-output capture:
  // withTimeout orphans the execute promise on expiry, so whatever the tool
  // streamed via _onProgress is the only work product we can still surface
  // (metadata.partial_output on the [timeout] row). Bounded so a chatty
  // long-runner can't grow the buffer without limit.
  const progressLog: string[] = [];
  const onProgress = (message: string) => {
    progressLog.push(message);
    if (progressLog.length > 200) progressLog.shift();
    onEvent?.({ type: "tool_progress", toolName: tc.name, toolCallId: tc.id, message } as ServerEvent);
  };

  // Stale-read guard: refuse an edit against a file this session hasn't seen
  // the current bytes of. Runs before execute (and before circuit-breaker
  // accounting) so a "re-read first" never trips the breaker — it's guidance,
  // not a tool failure.
  if (typeof args.path === "string" && args.path && FRESHNESS_GUARDED.has(tc.name)) {
    // Path resolution / freshness is best-effort: a malformed path is the
    // tool's job to report, not ours to crash on, so swallow and fall through.
    let resolved: string | null = null;
    try { resolved = resolveAgentPath(args.path); } catch { /* let the tool handle it */ }
    const fresh = resolved ? checkFreshness(sessionId, resolved) : "ok";
    if (resolved && fresh !== "ok") {
      ctx.result = blocked(
        fresh === "unseen"
          ? `Refusing to edit ${resolved}: this session hasn't read it. Read the file first so your edit targets its current contents.`
          : `Refusing to edit ${resolved}: it changed on disk since this session last read it. Re-read it — your old_string or line numbers may be stale.`,
        { recovery: `Call read with path="${args.path}", then retry this edit.`, layer: "stale-read-guard" },
      );
      return CONTINUE;
    }
  }

  // Read-dedup: a full re-read of a file whose CURRENT disk bytes this session
  // provably already holds (hash-verified — mtime is only a prefilter) returns
  // a one-line stub instead of re-shipping the content. Partial/screened views
  // never dedup, an explicit offset/limit is the model's force-re-read lever,
  // and relative paths are exempt (their resolution can be work-root-dependent,
  // so only the session-independent absolute form is safe to stub). Runs before
  // execute and before accounting, like the freshness guard: a served stub is
  // guidance, not a tool run.
  if (tc.name === "read" && typeof args.path === "string" && args.path &&
      args.offset === undefined && args.limit === undefined && isAbsolute(args.path)) {
    let resolved: string | null = null;
    try { resolved = resolveAgentPath(args.path); } catch { /* let the tool handle it */ }
    if (resolved && unchangedSinceSeen(sessionId, resolved)) {
      ctx.result = ok(
        `Unchanged since this session last read it: ${resolved} (content-hash verified). ` +
        `Your existing view of this file is still current, so the re-read was skipped. ` +
        `To force a full re-read anyway, pass an explicit offset (e.g. offset=1).`,
        { path: resolved, unchanged: true },
      );
      return CONTINUE;
    }
  }

  const startedAt = Date.now();
  ctx.startedAt = startedAt;
  const runner = createToolRunner({ tool, args, operationId: ctx.operationId, toolCallId: tc.id, toolName: tc.name, sessionId, signal, onProgress });

  // Provisional arg-derived taint floor (R4-09): up before execute so a
  // co-batched egress check can't observe an empty floor. The post-execute
  // policy upgrades it with content fingerprints (bytes delivered) or retracts
  // it (result fully stubbed — delivery-point invariant).
  const floor = setPreExecuteTaintFloor(tc.name, args, sessionId);

  try {
    ctx.result = await runner.run();
    // Delivery-point taint + redaction policy (sensitive-read-taint.ts): scans
    // the result, swaps in the redaction stub when sensitive bytes would reach
    // the model, and commits taint ONLY for bytes actually delivered.
    ctx.result = applyResultTaintPolicy(tc.name, args, sessionId, ctx.result, floor);
  } catch (e) {
    const reconciliation = runner.reconcile(e);
    if (reconciliation) {
      ctx.result = reconciliation;
    } else if (e instanceof RetryableToolResultError) {
      ctx.result = e.result;
    } else if (e instanceof ToolTimeoutError) {
      // A hung tool: hand the model a hard [timeout] row so it can't narrate
      // "done" against silence. The execute promise is orphaned (no abort), so
      // tell the model to VERIFY state rather than assume success or failure.
      // Whatever the tool streamed via _onProgress before the deadline is the
      // one work product we still hold — surface it as partial_output (tail-
      // capped) instead of discarding it with the orphaned promise.
      const partial = progressLog.length > 0 ? progressLog.join("\n").slice(-4_000) : undefined;
      ctx.result = timeout(
        `Tool "${e.toolName}" exceeded its ${e.ms}ms timeout and was abandoned. It may still be running in the background.`,
        {
          duration_ms: e.ms,
          ...(partial ? { partial_output: partial } : {}),
          recovery:
            `Do NOT assume this succeeded or failed. Verify actual state before continuing: ` +
            `check process_status / process_list for a still-running process, and inspect the ` +
            `filesystem for any partial output. If the work is long-running, re-run it via an async tool (e.g. process_start / op_submit_async) and poll.`,
        },
      );
    } else {
      ctx.result = { content: `Tool error: ${(e as Error).message}`, isError: true };
    }
  }

  const result = ctx.result!;
  runner.complete(result);
  const durationMs = Date.now() - startedAt;
  const succeeded = !result.isError;
  if (succeeded && typeof args.path === "string" && args.path && RECORDS_SEEN.has(tc.name)) {
    // Reads record HOW the file was seen (partial/range views never dedup);
    // writes/edits pass no view — the session knows the whole resulting file,
    // and re-recording refreshes the diff snapshot to the post-edit bytes.
    const view = tc.name === "read" ? seenViewFromReadResult(args, result.metadata) : undefined;
    try { recordFileSeen(sessionId, resolveAgentPath(args.path), view); } catch { /* freshness is best-effort */ }
  }
  try { recordToolStat(tc.name, sessionId || "default", succeeded, durationMs, result.isError ? result.content?.slice(0, 200) : undefined); } catch { /* tracker should never break the call */ }
  try { recordRateLimit(tc.name, sessionId); } catch { /* same */ }
  if (succeeded) {
    recordCircuitSuccess(sessionId, tc.name, circuitArgsSig(tc.arguments));
  } else {
    recordCircuitFailure(sessionId, tc.name, typeof result.content === "string" ? result.content : undefined, circuitArgsSig(tc.arguments));
  }
  return CONTINUE;
};
