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
import { recordSensitiveRead, isSensitivePath, extractSensitivePathsFromCommand, detectSecretsInOutput } from "../data-lineage.js";
import { createLogger } from "../logger.js";
import type { Phase } from "./context.js";
import { isRetryable, isRetryableTool } from "../resilience-policy.js";

const logger = createLogger("tool-execution");

export const runSandboxedPhase: Phase = async (ctx) => {
  const { tc, tool, args, sessionId, signal, onEvent } = ctx;
  if (!tool) return;

  args._onProgress = (message: string) => {
    onEvent?.({ type: "tool_progress", toolName: tc.name, toolCallId: tc.id, message } as ServerEvent);
  };

  const startedAt = Date.now();
  ctx.startedAt = startedAt;
  const shouldRetry = isRetryableTool(tc.name);

  try {
    if (shouldRetry) {
      ctx.result = await withRetry(() => tool.execute(args, signal), {
        maxRetries: 2,
        baseDelayMs: 500,
        maxDelayMs: 4000,
        shouldRetry: (err, attempt) => isRetryable(err, { toolName: tc.name, attempt }),
        ctx: getRetryContext(sessionId),
        layer: "L1-tool",
      });
    } else {
      ctx.result = await tool.execute(args, signal);
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
    if (tc.name === "read" && isSensitivePath(String(args.path || ""))) {
      recordSensitiveRead(sessionId || "default", "sensitive_file", String(args.path));
      redactReason = `read of sensitive path ${String(args.path)}`;
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
    if (tc.name === "http_request" || tc.name === "web_fetch") {
      const body = typeof ctx.result?.content === "string" ? ctx.result.content : "";
      if (body.length > 0) {
        const det = detectSecretsInOutput(body);
        if (det.matched) {
          recordSensitiveRead(sessionId || "default", "secret", `${tc.name}:${det.kinds.join(",")}`);
          logger.warn(
            `${tc.name} response contained secret-shaped content (kinds: ${det.kinds.join(", ")}) — session tainted`,
          );
          redactReason = `${tc.name} response contained secret-shaped content (${det.kinds.join(", ")})`;
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
    ctx.result = { content: `Tool error: ${(e as Error).message}`, isError: true };
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
};
