// Per-turn driver for an acquired warm process. Writes one user-message
// JSON-line to stdin, demuxes stdout frames via the process's
// activeListener, and yields StreamEvents. Releases the process back to
// the pool on completion (or evicts on hard-kill abort).
//
// Wire format mirrors stream-cli.ts so callers can swap paths
// transparently. Per-prompt protocol (validated by the spike):
//   stdin  : `{"type":"user","message":{"role":"user","content":"..."}}\n`
//   stdout : sequence of JSON frames ending with `{"type":"result", ...}`

import type { StreamEvent } from "../types.js";
import { createLogger } from "../../logger.js";
import { acquire, release } from "./pool.js";
import { NATIVE_CLI_TOOL_SET } from "../stream-cli/cli-args.js";
import type { WarmPoolKey } from "./types.js";

const logger = createLogger("anthropic-client.warm-pool.stream");

export interface WarmPromptOptions {
  prompt: string;
  signal?: AbortSignal;
}

export async function* streamViaWarmPool(
  key: WarmPoolKey,
  opts: WarmPromptOptions,
): AsyncGenerator<StreamEvent> {
  const wp = await acquire(key);
  let released = false;
  let aborted = false;
  // Two abort modes, distinguished by the AbortSignal's `reason`:
  //   - reason matches /idle|stalled|stop/i → KILL the warm process. The
  //     model is wedged or the user pressed stop; we need to free the
  //     subprocess so it stops burning Anthropic tokens.
  //   - any other reason (or no reason) → DRAIN silently. This is the
  //     gentle path for session-turn-lock evictions and similar internal
  //     cleanup — preserves the warm process for the next turn.
  const onAbort = () => {
    aborted = true;
    const reason = opts.signal?.reason;
    const reasonText =
      reason instanceof Error ? reason.message :
      typeof reason === "string" ? reason : "";
    if (/idle|stalled|stop/i.test(reasonText)) {
      try { wp.proc.kill("SIGKILL"); } catch { /* dead */ }
      wp.state = "dead";
    }
  };
  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    const queue: unknown[] = [];
    let resolveNext: ((v: { done: boolean; frame?: unknown }) => void) | null = null;
    let finished = false;

    wp.activeListener = (frame: unknown) => {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ done: false, frame });
      } else {
        queue.push(frame);
      }
    };

    const userMsg = JSON.stringify({
      type: "user",
      message: { role: "user", content: opts.prompt },
    }) + "\n";
    wp.proc.stdin.write(userMsg);

    let fullText = "";
    let usage: WarmUsage = {};

    while (!finished) {
      let next: { done: boolean; frame?: unknown };
      if (queue.length > 0) {
        next = { done: false, frame: queue.shift() };
      } else if (wp.state === "dead") {
        yield { type: "error", error: `warm process died: ${wp.stderr.slice(-300)}` };
        return;
      } else {
        next = await new Promise((r) => { resolveNext = r; });
      }
      if (next.done) break;

      const events = processFrame(next.frame as Record<string, unknown>, {
        getAborted: () => aborted,
        getFullText: () => fullText,
        appendText: (t) => { fullText += t; },
        setUsage: (u) => { usage = u; },
      });
      for (const ev of events) {
        yield ev;
        if (ev.type === "done") {
          finished = true;
          break;
        }
      }
      // result frame also signals end-of-turn even if processFrame yielded
      // nothing (e.g. fully-drained abort case).
      if ((next.frame as Record<string, unknown>).type === "result") {
        finished = true;
      }
    }
  } finally {
    wp.activeListener = null;
    if (!released) {
      released = true;
      release(wp);
    }
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
  }
}

interface WarmUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface FrameContext {
  getAborted: () => boolean;
  getFullText: () => string;
  appendText: (delta: string) => void;
  setUsage: (u: WarmUsage) => void;
}

/** Translate one CLI stdout frame into zero or more StreamEvents. Caller
 *  iterates until a `done` event is yielded (end of turn). */
function* processFrame(frame: Record<string, unknown>, ctx: FrameContext): Generator<StreamEvent> {
  const t = frame.type as string | undefined;

  // If the consumer aborted, drain frames silently until the CLI's
  // natural `result` arrives. We MUST keep reading stdout — otherwise
  // the next acquired prompt would race the old turn's tail and the
  // CLI's stdin/stdout demux gets confused. Suppressing yields keeps
  // the consumer clean; suppressing the early return keeps the
  // process reusable.
  if (ctx.getAborted()) return;

  // stream_event with content_block_delta → text deltas
  if (t === "stream_event") {
    const inner = frame.event as Record<string, unknown> | undefined;
    if (inner?.type === "content_block_delta") {
      const delta = inner.delta as Record<string, unknown> | undefined;
      if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
        ctx.appendText(delta.text);
        yield { type: "text", delta: delta.text };
      }
    }
    return;
  }

  // assistant frame may contain tool_use blocks. MCP-prefixed names are
  // handled by the CLI's bridge subprocess (executed in-CLI; result fed
  // back automatically) — we just emit `mcp_activity` so the UI can
  // render an activity card. Non-MCP tool_use yields a `tool_call` event
  // so the agent loop can dispatch externally.
  if (t === "assistant") {
    const msg = frame.message as Record<string, unknown> | undefined;
    const content = msg?.content;
    if (!Array.isArray(content)) return;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block?.type !== "tool_use" || typeof block.name !== "string") continue;
      const argStr = JSON.stringify(block.input ?? {});
      const name = block.name as string;
      if (NATIVE_CLI_TOOL_SET.has(name) || name.startsWith("mcp__")) {
        // Native Claude tools (e.g. WebSearch) and MCP-bridged tools both run
        // inside the CLI subprocess; surfacing them as a tool_call would make
        // the outer loop re-dispatch a tool it doesn't own → spurious BLOCKED.
        yield { type: "mcp_activity", name, arguments: argStr };
      } else {
        const id = (typeof block.id === "string" && block.id) ? block.id : `${name}_${Date.now().toString(36)}`;
        yield { type: "tool_call", id, name, arguments: argStr };
      }
    }
    return;
  }

  // result frame = end of turn. Yield done.
  if (t === "result") {
    const u = frame.usage as WarmUsage | undefined;
    const usage: WarmUsage = u && typeof u === "object" ? u : {};
    ctx.setUsage(usage);
    // DEBUG: inspect raw usage shape so we can see whether the CLI
    // surfaces cache_read_input_tokens / cache_creation_input_tokens
    // under OAuth subscription auth. Drop once cache fields are
    // confirmed in soak rows.
    try {
      logger.info(`[warm-pool] usage-keys=${Object.keys(usage).join(",")} usage-json=${JSON.stringify(usage).slice(0, 500)}`);
    } catch { /* ignore */ }
    // If no streamed deltas arrived (no --include-partial-messages
    // support, or the model emitted a single content block), back-fill
    // from result text.
    const resultText = typeof frame.result === "string" ? frame.result : "";
    const fullText = ctx.getFullText();
    if (resultText.length > fullText.length) {
      const tail = resultText.slice(fullText.length);
      if (tail.length > 0) yield { type: "text", delta: tail };
    }
    yield {
      type: "done",
      usage: {
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
        cacheReadTokens: usage.cache_read_input_tokens,
        cacheCreateTokens: usage.cache_creation_input_tokens,
      },
    };
    return;
  }

  // Other frames (system, user-replay, rate_limit_event) — ignored. The
  // text deltas already covered content; replay frames would re-emit
  // what we've already streamed.
}
