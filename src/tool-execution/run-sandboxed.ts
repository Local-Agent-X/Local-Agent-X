// Sandboxed-execute phase: inject _onProgress, run tool.execute() with the
// transient-error retry policy, record sensitive reads, then record stats /
// circuit-breaker state / rate-limit consumption.

import type { ServerEvent } from "../types.js";
import { withRetry } from "../auto-retry.js";
import { getRetryContext } from "../retry-context.js";
import { recordCircuitFailure, recordCircuitSuccess } from "../circuit-breaker.js";
import { recordToolCall as recordToolStat } from "../tool-tracker.js";
import { recordToolCall as recordRateLimit } from "../tool-rate-limiter.js";
import { recordSensitiveRead, isSensitivePath, extractSensitivePathsFromCommand, detectSecretsInOutput } from "../data-lineage.js";
import { createLogger } from "../logger.js";
import type { Phase } from "./context.js";
import { isTransientError } from "./errors.js";

const logger = createLogger("tool-execution");

// Tools whose failures are usually transient (network, rate limit).
const RETRYABLE_TOOLS = new Set([
  "http_request",
  "web_fetch",
  "web_search",
  "browser",
]);

// Tools whose failures are deterministic — never retry.
const NEVER_RETRY = new Set(["bash", "write", "edit", "agent_spawn", "delegate"]);

export const runSandboxedPhase: Phase = async (ctx) => {
  const { tc, tool, args, sessionId, signal, onEvent } = ctx;
  if (!tool) return;

  args._onProgress = (message: string) => {
    onEvent?.({ type: "tool_progress", toolName: tc.name, toolCallId: tc.id, message } as ServerEvent);
  };

  const startedAt = Date.now();
  ctx.startedAt = startedAt;
  const shouldRetry = RETRYABLE_TOOLS.has(tc.name) && !NEVER_RETRY.has(tc.name);

  try {
    if (shouldRetry) {
      ctx.result = await withRetry(() => tool.execute(args, signal), {
        maxRetries: 2,
        baseDelayMs: 500,
        maxDelayMs: 4000,
        shouldRetry: (err) => isTransientError(err),
        ctx: getRetryContext(sessionId),
        layer: "L1-tool",
      });
    } else {
      ctx.result = await tool.execute(args, signal);
    }
    if (tc.name === "read" && isSensitivePath(String(args.path || ""))) {
      recordSensitiveRead(sessionId || "default", "sensitive_file", String(args.path));
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
      }
      const stdout = typeof ctx.result?.content === "string" ? ctx.result.content : "";
      if (stdout.length > 0) {
        const det = detectSecretsInOutput(stdout);
        if (det.matched) {
          recordSensitiveRead(sessionId || "default", "secret", `bash:${det.kinds.join(",")}`);
          logger.warn(
            `bash output contained secret-shaped content (kinds: ${det.kinds.join(", ")}) — session tainted`,
          );
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
        }
      }
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
