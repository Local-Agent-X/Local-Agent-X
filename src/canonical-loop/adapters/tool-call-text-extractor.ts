/**
 * Tool-call-from-text extractor — fallback for models that emit tool
 * calls as TEXT inside `content` instead of populating `tool_calls`.
 *
 * Live failure pattern (2026-05-12, qwen3-next:80b + gpt-oss:20b on
 * Ollama Turbo): the model would correctly call `browser` for 7-9 turns
 * via the structured wire shape, then mid-conversation switch to emitting
 * the same call as a string of JSON in `content.text`. The streaming
 * accumulator saw it as text; the canonical loop emitted a finalized
 * assistant message with that text in chat; no browser action fired.
 * Small local models widened the zoo: XML-ish wrapper tags
 * (`<execute_tool>`, `<tool_call>`, …), bracket markers, and channel-marker
 * leaks.
 *
 * Two layers, strongest signal first (heuristic, not a general parser):
 *
 *   1. **Explicit call syntax** (tool-call-text-syntaxes.ts): wrapper
 *      tags / bracket markers / channel-marker leaks. The model MARKED
 *      the call, so near-miss names (`web-search`, `functions.browser`)
 *      are resolved against the offered tool set via a normalization +
 *      bounded-edit-distance ladder.
 *
 *   2. **Naked JSON objects:** the full wire envelope
 *      `{"name": "<tool>", "arguments": {...}}` or the browser shorthand
 *      `{"action": "X", "ref": N, ...}`. A bare object is a weaker
 *      signal, so names must match the offered set EXACTLY — no fuzz.
 *
 * There is deliberately NO prose layer: text that merely DESCRIBES a tool
 * call ("I'll run bash with ls") is never guessed into one. The model MUST
 * have written recognizable call syntax; the loop's completion gate
 * (turn-loop/tool-intent-gate.ts) owns the one nudge for that case, and
 * plain prose stands as the reply.
 *
 * Only fires when `tool_calls` is empty AND the text matches a clear
 * pattern; healthy providers never hit this path, and ambiguous text is
 * left alone. Unpromoted-but-recognized syntax (unresolvable name,
 * over-cap payload, structurally-truncated payload, `<execute_tool>None`)
 * stays in the text untouched — scrubbing it is delivery-sanitization's
 * job, not extraction's. Truncated payloads NEVER promote: a payload that
 * needed unbalanced braces/strings closed was cut mid-write, and a
 * partial write/command must not execute.
 *
 * Adapter integration: call AFTER `streamOnce` returns, BEFORE the
 * empty-response retry. If matches found, append to `pendingToolCalls`
 * and clear `assembledText` (so the payload doesn't double-render).
 */

import { findJsonObjects } from "./tool-call-text-repair.js";
import {
  isBrowserShorthand,
  resolveCandidateName,
  scanTextToolCallSyntaxes,
  withinCaps,
} from "./tool-call-text-syntaxes.js";

export interface ExtractedToolCall {
  id: string;
  name: string;
  /** JSON string per OpenAI wire shape. Argument object as serialized JSON. */
  arguments: string;
}

export interface ExtractionResult {
  toolCalls: ExtractedToolCall[];
  /** What's left of the input text after removing the JSON we synthesized
   *  into tool calls. Empty when the entire input was a tool-call payload. */
  remainingText: string;
}

let _idCounter = 0;
function nextId(): string {
  _idCounter = (_idCounter + 1) % 1_000_000;
  return `call_synth_${Date.now().toString(36)}_${_idCounter.toString(36)}`;
}

/**
 * Try to extract tool calls from text content. Pure function.
 * @param text The assistant's emitted text content.
 * @param validToolNames Set of tool names the agent is allowed to call.
 *   We only synthesize calls to tools in this set.
 */
export function extractToolCallsFromText(
  text: string,
  validToolNames: Set<string>,
): ExtractionResult {
  if (!text || typeof text !== "string") return { toolCalls: [], remainingText: text ?? "" };

  // Strip common code-fence wrapping. Models often wrap tool-call payloads
  // in ```json ... ``` even when emitting as content.
  let working = text.replace(/```(?:json|tool_use|function)?\s*\n?/gi, "").replace(/\n?```/g, "");

  // Layer 1 — explicit call syntax. Candidates carry the name as the model
  // wrote it; promote only those whose name resolves against the offered
  // set (exact-only for weak markers — resolveCandidateName decides) and
  // whose payload is within caps. Unpromoted hits stay in the text, but
  // their bytes are off-limits to the naked-JSON layer below so a block
  // rejected here (truncated, over-cap, unresolvable) can't sneak back in
  // through its inner JSON.
  const syntaxHits = scanTextToolCallSyntaxes(working);
  const found: Array<{ start: number; end: number; call: ExtractedToolCall }> = [];
  for (const hit of syntaxHits) {
    if (!hit.candidate || !withinCaps(hit.candidate)) continue;
    const resolved = resolveCandidateName(hit.candidate, validToolNames);
    if (!resolved) continue;
    found.push({
      start: hit.start,
      end: hit.end,
      call: { id: nextId(), name: resolved, arguments: hit.candidate.argsJson },
    });
  }

  // Layer 2 — naked JSON objects (full envelope / browser shorthand).
  for (const obj of findJsonObjects(working)) {
    if (syntaxHits.some((h) => obj.start < h.end && h.start < obj.end)) continue;
    const synthesized = classify(obj.parsed, validToolNames);
    if (synthesized) found.push({ start: obj.start, end: obj.end, call: synthesized });
  }

  if (found.length === 0) return { toolCalls: [], remainingText: text };

  // Emit calls in source order; excise promoted ranges back-to-front so
  // indices stay valid.
  found.sort((a, b) => a.start - b.start);
  const calls = found.map((f) => f.call);
  for (let i = found.length - 1; i >= 0; i--) {
    working = working.slice(0, found[i].start) + working.slice(found[i].end);
  }
  return { toolCalls: calls, remainingText: working.trim() };
}

/**
 * Classify a parsed JSON object as a tool call we should synthesize, or
 * leave it alone if it doesn't match a known pattern.
 */
function classify(obj: Record<string, unknown>, validToolNames: Set<string>): ExtractedToolCall | null {
  // Pattern 1: full OpenAI envelope { name: "tool", arguments: {...} }
  if (typeof obj.name === "string" && validToolNames.has(obj.name)) {
    const args = obj.arguments;
    if (args === undefined || (typeof args === "object" && args !== null)) {
      return {
        id: nextId(),
        name: obj.name,
        arguments: typeof args === "object" ? JSON.stringify(args) : "{}",
      };
    }
    if (typeof args === "string") {
      // Already serialized — pass through as-is if it's valid JSON.
      try { JSON.parse(args); return { id: nextId(), name: obj.name, arguments: args }; }
      catch { return null; }
    }
  }

  // Pattern 2: browser shorthand { action: "X", ref: N, ... }. The shape
  // rules live in isBrowserShorthand — shared with the syntax layer so
  // wrapped shorthand promotes identically. Only fires when "browser" is
  // in validToolNames.
  if (validToolNames.has("browser") && isBrowserShorthand(obj)) {
    return { id: nextId(), name: "browser", arguments: JSON.stringify(obj) };
  }

  return null;
}

