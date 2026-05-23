// JSON-line parser for the `claude` CLI's --output-format stream-json stream.
// One stream-cli generator → one CliStreamState; the orchestrator splits
// the subprocess stdout into lines and feeds each to processStreamLine,
// yielding events. State stays in the orchestrator's scope so the parser
// is pure(ish) per call — text dedup, suppression, and the
// emittedNativeTools/firstResponseSeen flags live on the state object.

import { cleanUrls, filterStreamDelta, parseToolCalls, stripToolCallBlocks } from "../parse.js";
import { newToolCallId } from "../request.js";
import type { StreamEvent } from "../types.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("anthropic-client.stream-cli.parse");

export interface CliStreamState {
  fullText: string;
  prevText: string;
  suppressing: boolean;
  usage: Record<string, number>;
  /** Set true when a native tool_use block is emitted in an assistant event.
   *  Read in the result event to skip text-based tool_call parsing — without
   *  this we double-emit when Opus uses native tool_use AND its textual
   *  representation matches the text-call regex. */
  emittedNativeTools: boolean;
  /** Flipped on the first text byte from the model. Orchestrator polls
   *  this after each line to stop the progress timer. */
  firstResponseSeen: boolean;
}

export function createCliStreamState(): CliStreamState {
  return {
    fullText: "",
    prevText: "",
    suppressing: false,
    usage: {},
    emittedNativeTools: false,
    firstResponseSeen: false,
  };
}

/**
 * Parse one JSON line from the CLI stdout and yield any StreamEvents it
 * produces. Mutates state in place. Caller is responsible for stopping
 * iteration when a `done` event is yielded (the orchestrator's outer loop
 * needs to clean up subprocess + MCP config files in finally).
 */
export function* processStreamLine(
  line: string,
  state: CliStreamState,
  validToolNames: Set<string>,
): Generator<StreamEvent> {
  if (!line.trim()) return;
  let event: unknown;
  try { event = JSON.parse(line); } catch { return; }
  const ev = event as Record<string, unknown>;

  // With --include-partial-messages, Claude Code wraps API stream frames
  // in { type: "stream_event", event: { ... } }. Extract text_deltas so
  // they flow to the UI token-by-token instead of waiting for the full
  // content block to land.
  if (ev.type === "stream_event" && ev.event) {
    const inner = ev.event as Record<string, unknown>;
    const delta = inner.delta as Record<string, unknown> | undefined;
    if (inner.type === "content_block_delta" && delta?.type === "text_delta" && typeof delta.text === "string") {
      state.firstResponseSeen = true;
      // Track prevText so the later full-block assistant event doesn't
      // re-yield the same text we already emitted as deltas.
      state.prevText += delta.text;
      state.fullText += delta.text;
      const cleanDelta = filterStreamDelta(delta.text, state.suppressing);
      if (cleanDelta.suppress) { state.suppressing = true; }
      else if (cleanDelta.text) { state.suppressing = false; yield { type: "text", delta: cleanUrls(cleanDelta.text) }; }
    }
    return;
  }

  if (ev.type === "assistant") {
    const message = ev.message as { content?: unknown } | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) return;

    const fullBlockText = content
      .filter((b: { type?: string; text?: string }) => b.type === "text" && typeof b.text === "string")
      .map((b: { text: string }) => b.text)
      .join("");
    if (fullBlockText.length > state.prevText.length) {
      const delta = fullBlockText.slice(state.prevText.length);
      state.prevText = fullBlockText;
      state.fullText = fullBlockText;
      process.stdout.write(`[claude] ${delta.replace(/\n/g, "\\n").slice(0, 200)}\n`);
      state.firstResponseSeen = true;
      const cleanDelta = filterStreamDelta(delta, state.suppressing);
      if (cleanDelta.suppress) { state.suppressing = true; }
      else if (cleanDelta.text) { state.suppressing = false; yield { type: "text", delta: cleanUrls(cleanDelta.text) }; }
    }
    // Also capture NATIVE tool_use blocks. Opus 4.7 sometimes emits these
    // alongside or instead of the text-JSON protocol the CLI prompt primes
    // it with. Without this pass, native tool calls were silently dropped
    // and the loop ended the turn with no tool call.
    //
    // Skip `mcp__*` blocks — those are routed end-to-end through the MCP
    // bridge (which executes them via /api/mcp/call). If we ALSO yielded
    // them here, the agent loop would try to re-run them with the prefixed
    // name, fail the tool-map lookup, hit default-deny in the policy, and
    // feed a spurious BLOCKED result back into the model's context.
    for (const b of content as Array<Record<string, unknown>>) {
      if (b?.type === "tool_use" && b.name) {
        const name = String(b.name);
        if (name.startsWith("mcp__")) {
          logger.info(`[claude] MCP tool_use (handled via bridge): ${name}`);
          // Signal to the agent loop that tool activity happened, so its
          // "toolCalls.length === 0 → auto-route to build_app" fallback
          // doesn't misfire. The tool already ran via MCP. Include args
          // so run-anthropic can forward as a real tool_start event
          // (sidebar live-progress used to be dark for Anthropic workers
          // because mcp_activity carried just the name and never reached
          // the worker's event stream).
          const mcpArgs = typeof b.input === "object" && b.input ? b.input : {};
          yield { type: "mcp_activity", name, arguments: JSON.stringify(mcpArgs) };
          continue;
        }
        const args = typeof b.input === "object" && b.input ? b.input : {};
        logger.info(`[claude] Native tool_use: ${name}(${JSON.stringify(args).slice(0, 80)})`);
        state.emittedNativeTools = true;
        yield { type: "tool_call", id: (b.id as string) || newToolCallId(name), name, arguments: JSON.stringify(args) };
      }
    }
    return;
  }

  if (ev.type === "result") {
    const result = typeof ev.result === "string" ? ev.result : "";
    if (result.length > state.prevText.length) {
      state.fullText = result;
      const remaining = result.slice(state.prevText.length);
      const clean = stripToolCallBlocks(remaining, validToolNames);
      // Don't trim — preserves whitespace at chunk boundaries (was eating leading spaces between sentences)
      if (clean) yield { type: "text", delta: clean };
      state.prevText = result;
    }
    state.usage = (ev.usage as Record<string, number>) || {};
    // DEBUG: inspect the raw `usage` shape so we can see whether the
    // CLI surfaces cache_read_input_tokens / cache_creation_input_tokens
    // (or similar) under OAuth subscription auth. Remove once the
    // soak file shows non-null cache fields on Anthropic chats.
    try {
      logger.info(`[claude] usage-keys=${Object.keys(state.usage).join(",")} usage-json=${JSON.stringify(state.usage).slice(0, 500)}`);
    } catch { /* ignore */ }
    logger.info(`[claude] Done: ${result.slice(0, 100).replace(/\n/g, "\\n")}...`);

    // Parse tool calls from full response ONLY if we didn't already emit
    // native tool_use blocks from the assistant event — prevents duplicate
    // emission when Opus uses native tool_use (which my text parser would
    // also match against the textual representation).
    if (!state.emittedNativeTools) {
      const toolCalls = parseToolCalls(state.fullText, validToolNames);
      for (const tc of toolCalls) {
        const redactedArgs = JSON.stringify(tc.arguments).slice(0, 100).replace(/(?:password|secret|token|key|api_key|apiKey|authorization|bearer)["']?\s*[:=]\s*["']?[^"',}\s]{3}[^"',}]*/gi, (m) => m.slice(0, m.indexOf(":") + 4) + "***REDACTED***");
        logger.info(`[claude] Tool call: ${tc.name}(${redactedArgs})`);
        yield { type: "tool_call", id: newToolCallId(tc.name), name: tc.name, arguments: JSON.stringify(tc.arguments) };
      }
      // Diagnostic: if response CONTAINS "tool_calls" text but parser found
      // nothing, log it — helps catch future CLI output-format changes.
      if (toolCalls.length === 0 && /"tool_calls"/.test(state.fullText)) {
        logger.warn(`[claude] WARNING: response contains "tool_calls" but parser extracted 0 calls. Response head: ${state.fullText.slice(0, 300).replace(/\n/g, "\\n")}`);
      }
    }
    yield buildDoneEvent(state);
    return;
  }
}

/** Handle the trailing buffer that didn't end with a newline. Only the
 *  `result` event matters here — partial stream_event / assistant frames
 *  are dropped (they'd already have come through as complete lines). */
export function* processLeftoverBuffer(
  buffer: string,
  state: CliStreamState,
  validToolNames: Set<string>,
): Generator<StreamEvent> {
  if (!buffer.trim()) return;
  let event: unknown;
  try { event = JSON.parse(buffer); } catch { return; }
  const ev = event as Record<string, unknown>;
  if (ev.type !== "result") return;
  state.fullText = typeof ev.result === "string" ? ev.result : state.fullText;
  state.usage = (ev.usage as Record<string, number>) || {};
  const toolCalls = parseToolCalls(state.fullText, validToolNames);
  const clean = stripToolCallBlocks(state.fullText, validToolNames);
  if (clean.trim() && clean.length > state.prevText.length) yield { type: "text", delta: clean.trim() };
  for (const tc of toolCalls) {
    yield { type: "tool_call", id: newToolCallId(tc.name), name: tc.name, arguments: JSON.stringify(tc.arguments) };
  }
}

export function buildDoneEvent(state: CliStreamState): StreamEvent {
  return {
    type: "done",
    usage: {
      inputTokens: state.usage.input_tokens || 0,
      outputTokens: state.usage.output_tokens || 0,
      cacheReadTokens: state.usage.cache_read_input_tokens,
      cacheCreateTokens: state.usage.cache_creation_input_tokens,
    },
  };
}
