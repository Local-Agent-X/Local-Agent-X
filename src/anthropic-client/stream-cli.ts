// Anthropic `claude` CLI subprocess transport. Two paths:
//   - warm-pool: long-lived CLI process per (model, permissionMode, sessionId);
//     drops first-byte from ~2s (cold) to ~4ms (warm). See warm-pool.ts.
//   - cold-spawn: one-shot subprocess per turn. Used when the warm-pool flag is
//     off, or when the per-session warm-pool isn't applicable.
//
// Both paths share buildCliPrompt() so the prompt shape can't drift between
// them (it did once — warm-pool always serialized history into MCP-mode
// prompts, which trained Claude to echo `[called X] / Tool result:` blocks
// into replies).
//
// Helpers split into ./stream-cli/* — this file is the orchestrator.

import { spawn } from "child_process";
import { isWarmPoolEnabled, streamViaWarmPool } from "./warm-pool.js";
import { npmAugmentedEnv } from "./cli-path.js";
import type { StreamEvent, StreamOptions } from "./types.js";
import { createLogger } from "../logger.js";

import { buildCliPrompt } from "./stream-cli/prompt-builder.js";
import { buildCliArgs, setupMcpConfig, cleanupMcpConfig } from "./stream-cli/cli-args.js";
import { startProgressTimer } from "./stream-cli/progress-timer.js";
import {
  createCliStreamState,
  processStreamLine,
  processLeftoverBuffer,
  buildDoneEvent,
} from "./stream-cli/stream-parse.js";

export {
  serializePriorTurns,
  buildCliPrompt,
  type CliPromptMode,
  type CliPromptInput,
} from "./stream-cli/prompt-builder.js";

const logger = createLogger("anthropic-client.stream-cli");

/**
 * CLI proxy with tool support: embeds tool definitions in the prompt,
 * instructs Claude to output JSON tool calls that we parse and route
 * back through the agent loop's executeToolCalls.
 */
export async function* streamViaCliWithTools(options: StreamOptions): AsyncGenerator<StreamEvent> {
  const { model, messages, systemPrompt, tools } = options;

  // Warm-pool fast path: long-lived CLI process per (model, permissionMode,
  // sessionId). Validated by scripts/spike-claude-warm-pool.mjs — drops
  // first-byte latency from ~2000ms (cold) to ~4ms (warm).
  //
  // Gate: ANY caller with the flag on. Earlier I gated on sessionId being
  // set under the (wrong) assumption that one-shot internal callers would
  // "defeat" the pool — but the pool keeps processes warm BETWEEN calls
  // by definition, so a single-shot call still benefits the next single-
  // shot call to the same model. Tracer logs caught this: prepareAgentRequest
  // makes 3-4 internal classifier/orchestrator LLM calls per chat turn
  // (haiku for routing, sonnet for redirect, opus for response), and the
  // sessionId gate sent every one of them through cold-spawn. That was
  // ~12-15s of CLI cold-start tax in the prep pipeline alone.
  // TRACER: log warm-pool gate decision so we can see which branch fires
  const _wpEnabled = isWarmPoolEnabled();
  logger.info(`[wp-gate] enabled=${_wpEnabled} sessionId=${options.sessionId ?? "(none)"} tools=${tools?.length ?? 0} model=${model}`);
  if (_wpEnabled) {
    yield* streamViaWarmPoolPath(options);
    return;
  }

  yield* streamViaColdSpawn(options);
}

// ── Warm-pool path ───────────────────────────────────────────────────────

async function* streamViaWarmPoolPath(options: StreamOptions): AsyncGenerator<StreamEvent> {
  const { model, messages, systemPrompt, tools } = options;
  const textOnlyMode = !tools || tools.length === 0;

  let saxToken = "";
  let saxPort = 7007;
  if (!textOnlyMode) {
    try {
      const { getRuntimeConfig } = await import("../config.js");
      const rc = getRuntimeConfig();
      saxToken = rc.authToken;
      saxPort = rc.port;
    } catch { /* swallow — falls back to text-only key below */ }
  }

  const useMcp = !textOnlyMode && !!saxToken && !!options.sessionId;
  const fullPrompt = buildCliPrompt({
    systemPrompt,
    messages,
    mode: textOnlyMode ? "text-only" : useMcp ? "mcp" : "prompt-inject",
    tools,
  });

  if (!useMcp) {
    logger.info(`[wp-gate] → text-only shared pool (textOnly=${textOnlyMode} hasToken=${!!saxToken})`);
    yield* streamViaWarmPool(
      { model, permissionMode: "plan" },
      { prompt: fullPrompt, signal: options.signal },
    );
  } else {
    logger.info(`[wp-gate] → per-session MCP pool sess=${options.sessionId!.slice(0, 16)}`);
    yield* streamViaWarmPool(
      {
        model,
        permissionMode: "bypassPermissions",
        sessionId: options.sessionId!,
        saxPort,
        saxToken,
      },
      { prompt: fullPrompt, signal: options.signal },
    );
  }
}

// ── Cold-spawn path ──────────────────────────────────────────────────────

async function* streamViaColdSpawn(options: StreamOptions): AsyncGenerator<StreamEvent> {
  const { model, messages, systemPrompt, tools } = options;
  const textOnlyMode = !tools || tools.length === 0;

  // Peek whether MCP will be wired up — when it is, we skip the text-
  // serialized context entirely. Claude sees tool results natively via MCP
  // and doesn't need them re-serialized into its prompt; feeding them back
  // as "[called X] / Tool result: ..." text teaches it to echo that format
  // in its own reply (the garbled wall of EXTERNAL_UNTRUSTED_CONTENT the
  // user was seeing).
  const willUseMcp = !textOnlyMode && !!(await import("../config.js").then(m => m.getRuntimeConfig().authToken).catch(() => ""));

  const fullPrompt = buildCliPrompt({
    systemPrompt,
    messages,
    mode: textOnlyMode ? "text-only" : willUseMcp ? "mcp" : "prompt-inject",
    tools,
  });

  const args = buildCliArgs({ model, textOnlyMode });

  let saxToken = "";
  let saxPort = 7007;
  try {
    const { getRuntimeConfig } = await import("../config.js");
    const rc = getRuntimeConfig();
    saxToken = rc.authToken;
    saxPort = rc.port;
  } catch {}

  const mcpConfigPath = await setupMcpConfig({
    textOnlyMode,
    saxToken,
    saxPort,
    sessionId: options.sessionId,
  });
  if (mcpConfigPath) args.push("--mcp-config", mcpConfigPath);

  try {
    const proc = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
      env: npmAugmentedEnv(),
    });

    // Wire the abort signal to kill the subprocess. Without this, hitting
    // "Stop" in the chat only aborts the JS-side stream reader while the
    // spawned `claude` process keeps eating tokens + making tool calls in
    // the background. Real symptom from a user: stop button "did nothing"
    // for ~2 minutes after the click. SIGTERM gives it a beat to clean up;
    // a follow-up SIGKILL after 1.5s handles any subprocess that ignores it.
    let abortKillTimer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => {
      try { proc.kill("SIGTERM"); } catch { /* already dead */ }
      abortKillTimer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* already dead */ }
      }, 1500);
    };
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }
    proc.on("close", () => {
      if (abortKillTimer) clearTimeout(abortKillTimer);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
    });

    proc.stdin?.write(fullPrompt);
    proc.stdin?.end();

    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    const progress = startProgressTimer();
    const state = createCliStreamState();
    const validToolNames = new Set((tools ?? []).map(t => t.name));
    let buffer = "";
    let firstResponseHandled = false;

    try {
      for await (const chunk of proc.stdout as AsyncIterable<Buffer>) {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          for (const ev of processStreamLine(line, state, validToolNames)) {
            yield ev;
            if (state.firstResponseSeen && !firstResponseHandled) {
              firstResponseHandled = true;
              progress.stop();
            }
            if (ev.type === "done") {
              await cleanupMcpConfig(mcpConfigPath);
              return;
            }
          }
        }
      }
      // Process leftover buffer (last partial line without newline)
      for (const ev of processLeftoverBuffer(buffer, state, validToolNames)) {
        yield ev;
      }

      const exitCode = await new Promise<number>((resolve) => { proc.on("close", (code) => resolve(code ?? 0)); });
      if (exitCode !== 0 && stderr) {
        yield { type: "error", error: `Claude CLI error (${exitCode}): ${stderr.slice(0, 300)}` };
        return;
      }
      yield buildDoneEvent(state);
    } finally {
      progress.stop();
      await cleanupMcpConfig(mcpConfigPath);
    }
  } catch (e) {
    await cleanupMcpConfig(mcpConfigPath);
    yield { type: "error", error: `Claude CLI error: ${(e as Error).message}` };
  }
}
