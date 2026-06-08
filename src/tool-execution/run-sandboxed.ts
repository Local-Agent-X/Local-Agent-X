// Sandboxed-execute phase: inject _onProgress, run tool.execute() with the
// transient-error retry policy, record sensitive reads, redact result content
// when taint fires (so the bytes never enter the LLM context — the egress
// gate would otherwise race the model's first sight of them), then record
// stats / circuit-breaker state / rate-limit consumption.

import type { ServerEvent, ToolResult } from "../types.js";
import { withRetry } from "../auto-retry.js";
import { getRetryContext } from "../retry-context.js";
import { recordCircuitFailure, recordCircuitSuccess } from "../circuit-breaker.js";
import { recordToolCall as recordToolStat } from "../tool-tracker.js";
import { recordToolCall as recordRateLimit } from "./rate-limiter.js";
import { recordSensitiveRead, isSensitivePath, extractSensitivePathsFromCommand, detectSecretsInOutput, redactSecretSpans } from "../data-lineage.js";
import { hasCapability } from "../tool-registry.js";
import { createLogger } from "../logger.js";
import type { Phase } from "./context.js";
import { CONTINUE } from "./context.js";
import { isRetryable, isRetryableTool } from "../resilience-policy.js";
import { getToolTimeout, withTimeout, ToolTimeoutError } from "../tool-timeout.js";
import { timeout } from "../tools/result-helpers.js";

const logger = createLogger("tool-execution");

// Sensitive-read tools whose taint is gated on the READ PATH (not on scanning
// returned content): a file read / pattern list. Their content scan is
// deliberately omitted to preserve canonical read/glob/grep behavior — output
// secret-scanning applies only to data-returning sensitive-read sinks.
const PATH_GATED_READS: ReadonlySet<string> = new Set(["read", "glob", "grep"]);

export const runSandboxedPhase: Phase = async (ctx) => {
  const { tc, tool, args, sessionId, signal, onEvent } = ctx;
  if (!tool) return CONTINUE;

  args._onProgress = (message: string) => {
    onEvent?.({ type: "tool_progress", toolName: tc.name, toolCallId: tc.id, message } as ServerEvent);
  };

  const startedAt = Date.now();
  ctx.startedAt = startedAt;
  const shouldRetry = isRetryableTool(tc.name);
  // Hang-catcher: bound each execute so a stuck tool yields a [timeout] result
  // row instead of stranding the model with no result. ms <= 0 means the tool
  // is exempt (long-runner) — call it directly, never pass 0 to withTimeout.
  // withTimeout sits INSIDE the withRetry thunk so each attempt is bounded
  // independently. NOTE: on timeout the underlying execute promise keeps
  // running orphaned (no per-tool abort); acceptable — the point is the row.
  const ms = getToolTimeout(tc.name);
  const runOnce = () => (ms > 0 ? withTimeout(tool.execute(args, signal), ms, tc.name) : tool.execute(args, signal));

  try {
    if (shouldRetry) {
      ctx.result = await withRetry(runOnce, {
        maxRetries: 2,
        baseDelayMs: 500,
        maxDelayMs: 4000,
        shouldRetry: (err, attempt) => isRetryable(err, { toolName: tc.name, attempt }),
        ctx: getRetryContext(sessionId),
        layer: "L1-tool",
      });
    } else {
      ctx.result = await runOnce();
    }
    // Taint detection + result redaction.
    //
    // The taint model is "if you touched sensitive bytes, the whole session
    // is tainted for egress." dataLineageGate blocks the next egress call,
    // but the model has already SEEN the bytes once via ctx.result — and a
    // tainted model can include them in plain prose, future tool args, or
    // any channel the gate doesn't cover. So when taint fires we also
    // overwrite ctx.result.content with a stub: the gate prevents exfil AND
    // the redaction prevents the first sight.
    let redactReason: string | null = null;
    const isSensitiveRead = hasCapability(tc.name, "sensitive-read");
    // Path-carrying sensitive-read sinks (read, ari_file, glob, grep, …): a read
    // of a sensitive path taints + redacts. Was keyed to "read" only; now every
    // sensitive-read synonym that takes a `path` arg is covered the same way.
    if (isSensitiveRead && tc.name !== "bash" && args.path && isSensitivePath(String(args.path))) {
      recordSensitiveRead(sessionId || "default", "sensitive_file", String(args.path));
      redactReason = `${tc.name} of sensitive path ${String(args.path)}`;
    }
    if (tc.name === "bash") {
      const cmd = String(args.command || "");
      const matches = extractSensitivePathsFromCommand(cmd);
      if (matches.length > 0) {
        for (const p of matches) {
          recordSensitiveRead(sessionId || "default", "sensitive_file", p);
        }
        logger.warn(
          `bash command referenced sensitive paths; session ${sessionId || "default"} now tainted for egress`,
          { paths: matches },
        );
        redactReason = `bash command referenced sensitive path(s): ${matches.join(", ")}`;
      }
      const stdout = typeof ctx.result?.content === "string" ? ctx.result.content : "";
      if (stdout.length > 0) {
        const det = detectSecretsInOutput(stdout);
        if (det.matched) {
          recordSensitiveRead(sessionId || "default", "secret", `bash:${det.kinds.join(",")}`);
          logger.warn(
            `bash output contained secret-shaped content (kinds: ${det.kinds.join(", ")}) — session tainted`,
          );
          redactReason = `bash output contained secret-shaped content (${det.kinds.join(", ")})`;
        }
      }
    }
    // Owned-source DATA reads (sql_query, email_read, memory_search, ari_file
    // read, ari_retrieval, ari_database, ari_sqlite) return row/record content
    // from a LOCAL or account-owned source. A secret stored there is OUR secret,
    // so a hit gets the full owned-source treatment: taint + whole-result redact.
    // Keyed on the sensitive-read CLASS (excluding bash — handled above — and the
    // path-listing read/glob/grep, whose existing behavior is path-gated only).
    if (isSensitiveRead && !PATH_GATED_READS.has(tc.name) && tc.name !== "bash") {
      const body = typeof ctx.result?.content === "string" ? ctx.result.content : "";
      if (body.length > 0) {
        const det = detectSecretsInOutput(body);
        if (det.matched) {
          recordSensitiveRead(sessionId || "default", "secret", `${tc.name}:${det.kinds.join(",")}`);
          logger.warn(
            `${tc.name} output contained secret-shaped content (kinds: ${det.kinds.join(", ")}) — session tainted`,
          );
          redactReason = `${tc.name} output contained secret-shaped content (${det.kinds.join(", ")})`;
        }
      }
    }
    // web_fetch / http_request bodies are UNTRUSTED INBOUND content from the
    // public internet — NOT a secret this system owns. A secret-shaped span is
    // coincidental (a slug, a sample key in docs) or a prompt-injection payload.
    // Strip those spans from the model's view (so it can't echo/exfil them) but
    // KEEP the rest of the page and DON'T taint the session: blanket-redacting +
    // egress-blocking on a coincidental `sk-…` match bricked whole agent runs.
    // Exfil of OUR secrets is guarded by the owned-source branches above + the
    // egress allowlist — not by bytes arriving from a trade site.
    if (tc.name === "http_request" || tc.name === "web_fetch") {
      const body = typeof ctx.result?.content === "string" ? ctx.result.content : "";
      if (body.length > 0 && ctx.result && !ctx.result.isError) {
        const red = redactSecretSpans(body);
        if (red.matched) {
          ctx.result = { ...ctx.result, content: red.text };
          logger.warn(
            `${tc.name} response had secret-shaped span(s) redacted inline (kinds: ${red.kinds.join(", ")}) — not tainting (untrusted inbound source)`,
          );
        }
      }
    }

    if (redactReason && ctx.result && !ctx.result.isError) {
      const stub: ToolResult = {
        content:
          `[redacted by data-lineage gate — ${redactReason}. ` +
          `The raw bytes are withheld from the model context to prevent first-sight exfiltration; ` +
          `the session is now tainted and outbound egress tools are blocked for this session.]`,
        isError: false,
        status: "blocked",
        metadata: { layer: "data-lineage", redacted: true, reason: redactReason },
      };
      ctx.result = stub;
    }
  } catch (e) {
    if (e instanceof ToolTimeoutError) {
      // A hung tool: hand the model a hard [timeout] row so it can't narrate
      // "done" against silence. The execute promise is orphaned (no abort), so
      // tell the model to VERIFY state rather than assume success or failure.
      ctx.result = timeout(
        `Tool "${e.toolName}" exceeded its ${e.ms}ms timeout and was abandoned. It may still be running in the background.`,
        {
          duration_ms: e.ms,
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
  const durationMs = Date.now() - startedAt;
  const succeeded = !result.isError;
  try { recordToolStat(tc.name, sessionId || "default", succeeded, durationMs, result.isError ? result.content?.slice(0, 200) : undefined); } catch { /* tracker should never break the call */ }
  try { recordRateLimit(tc.name, sessionId); } catch { /* same */ }
  if (succeeded) {
    recordCircuitSuccess(sessionId, tc.name);
  } else {
    recordCircuitFailure(sessionId, tc.name, typeof result.content === "string" ? result.content : undefined);
  }
  return CONTINUE;
};
