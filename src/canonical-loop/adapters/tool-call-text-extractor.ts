/**
 * Tool-call-from-text extractor — fallback for models that emit tool
 * calls as raw JSON inside `content` instead of populating `tool_calls`.
 *
 * Live failure pattern (2026-05-12, qwen3-next:80b + gpt-oss:20b on
 * Ollama Turbo): the model would correctly call `browser` for 7-9 turns
 * via the structured wire shape, then mid-conversation switch to emitting
 * the same call as a string of JSON in `content.text`. The streaming
 * accumulator saw it as text; the canonical loop emitted a finalized
 * assistant message with that text in chat; no browser action fired.
 * Tool calls leaked into the user-visible chat output, and the agent
 * got stuck because nothing dispatched the click.
 *
 * Patterns this catches (only — heuristic, not a general parser):
 *
 *   1. **Full OpenAI envelope as text:**
 *      `{"name": "<tool>", "arguments": {...}}`
 *      Wire-correct shape, but in `content` instead of `tool_calls`.
 *
 *   2. **Browser shorthand:** `{"action": "X", "ref": N, ...}`
 *      Bare arg shape with no tool-name wrapper. Mapped to `browser`
 *      because `action` + `ref` is the browser tool's signature.
 *
 * Heuristic-only — only fires when `tool_calls` is empty AND the text
 * matches a clear pattern. If a model correctly emits structured tool
 * calls, this never runs. If a model emits ambiguous text (mixed prose
 * with a JSON-shaped substring), the conservative pattern matching
 * leaves it alone.
 *
 * Adapter integration: call AFTER `streamOnce` returns, BEFORE the
 * empty-response retry. If matches found, append to `pendingToolCalls`
 * and clear `assembledText` (so the JSON doesn't double-render to chat).
 */

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

  // Strip common code-fence wrapping. Models often wrap tool-call JSON
  // in ```json ... ``` even when emitting as content.
  let working = text.replace(/```(?:json|tool_use|function)?\s*\n?/gi, "").replace(/\n?```/g, "");

  const calls: ExtractedToolCall[] = [];

  // Walk the string looking for balanced JSON objects.
  const objects = findJsonObjects(working);
  if (objects.length === 0) return { toolCalls: [], remainingText: text };

  const consumedRanges: Array<[number, number]> = [];
  for (const obj of objects) {
    const synthesized = classify(obj.parsed, validToolNames);
    if (synthesized) {
      calls.push(synthesized);
      consumedRanges.push([obj.start, obj.end]);
    }
  }

  if (calls.length === 0) return { toolCalls: [], remainingText: text };

  // Remove consumed JSON blocks from the working text. Walk back-to-front
  // so indices stay valid.
  consumedRanges.sort((a, b) => b[0] - a[0]);
  for (const [start, end] of consumedRanges) {
    working = working.slice(0, start) + working.slice(end);
  }
  return { toolCalls: calls, remainingText: working.trim() };
}

interface JsonObjectHit {
  start: number;
  end: number;
  parsed: Record<string, unknown>;
}

/**
 * Find balanced-brace JSON object substrings and JSON.parse each. Returns
 * the parse results with their string offsets so the caller can excise
 * consumed regions. Skips malformed JSON without throwing.
 */
function findJsonObjects(s: string): JsonObjectHit[] {
  const hits: JsonObjectHit[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] !== "{") { i++; continue; }
    // Balanced-brace scan, respecting string literals.
    let depth = 0;
    let inString = false;
    let escape = false;
    let j = i;
    for (; j < s.length; j++) {
      const ch = s[j];
      if (escape) { escape = false; continue; }
      if (inString) {
        if (ch === "\\") { escape = true; continue; }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { j++; break; } }
    }
    if (depth !== 0) { i++; continue; }
    const candidate = s.slice(i, j);
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        hits.push({ start: i, end: j, parsed: parsed as Record<string, unknown> });
      }
    } catch { /* skip malformed */ }
    i = j;
  }
  return hits;
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

  // Pattern 2: browser shorthand { action: "X", ref: N, ... }
  // Only fires when "browser" is in validToolNames. We also accept the
  // `coords`, `text`, `url`, `target` keys that the browser tool's other
  // actions use, but the discriminator is `action` (required).
  if (typeof obj.action === "string" && validToolNames.has("browser")) {
    const hasBrowserShape =
      "ref" in obj || "coords" in obj || "text" in obj ||
      "url" in obj || "target" in obj || "key" in obj ||
      "selector" in obj || obj.action === "snapshot" || obj.action === "back" ||
      obj.action === "forward" || obj.action === "wait";
    if (hasBrowserShape) {
      return {
        id: nextId(),
        name: "browser",
        arguments: JSON.stringify(obj),
      };
    }
  }

  return null;
}
