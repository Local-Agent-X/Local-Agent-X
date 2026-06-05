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

  const consumedRanges: Array<[number, number]> = [];
  for (const obj of objects) {
    const synthesized = classify(obj.parsed, validToolNames);
    if (synthesized) {
      calls.push(synthesized);
      consumedRanges.push([obj.start, obj.end]);
    }
  }

  // Structured JSON wins. Only fall back to shell-prose reconstruction when
  // no JSON tool call was salvageable — keeps the cheap, unambiguous path
  // first and the heuristic prose path strictly last.
  if (calls.length === 0) {
    const shell = extractShellProseCall(text, validToolNames);
    if (shell) return { toolCalls: [shell.call], remainingText: shell.remainingText };
    return { toolCalls: [], remainingText: text };
  }

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

  // Pattern 3 (shell prose) is NOT classified here — it has no JSON to
  // parse. It's handled by extractShellProseCall, called from the top-level
  // extractor only after JSON classification finds nothing.

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

/** Shell-style tools whose `command` arg can be reconstructed from a
 *  natural-language "run tool bash with command is …" narration. Kept
 *  small + explicit: only tools whose sole required arg is a shell string.
 *  First one present in validToolNames wins. */
const SHELL_TOOL_NAMES: ReadonlyArray<string> = ["bash", "shell", "ari_shell"];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Prose-narration fallback for shell tools (Pattern 3).
 *
 * Live failure 2026-06-04 (Nutrishop demo, xAI Grok): weaker OpenAI-compat
 * models sometimes DESCRIBE a shell call in English instead of emitting a
 * structured tool_call — or even the JSON the extractor above catches —
 * e.g. `run tool bash with command is cat > f << EOL …`. With no JSON to
 * parse, the call silently never dispatches and the trailing "File
 * committed." prose trips the false-completion guard.
 *
 * Conservative by construction:
 *   - fires ONLY when a shell tool is in validToolNames, and
 *   - requires the full invocation shape: an action verb, the shell tool
 *     name, then `command` followed by an explicit value marker (is | : | =).
 *     The marker is what separates a real invocation ("…command is rm x")
 *     from a casual mention ("run the bash command to verify"), which must
 *     NOT synthesize a call.
 *
 * Everything after the marker is taken verbatim as the `command` arg —
 * heredocs and `&&` chains span newlines, so we capture to end-of-string.
 * The reconstructed call still flows through normal approval + the bash
 * sandbox downstream, so it gets the same safety as a structured call.
 */
function extractShellProseCall(
  text: string,
  validToolNames: Set<string>,
): { call: ExtractedToolCall; remainingText: string } | null {
  const shellName = SHELL_TOOL_NAMES.find((n) => validToolNames.has(n));
  if (!shellName) return null;

  // verb … <shell> … command (is|:|=) <COMMAND to end-of-string>
  const re = new RegExp(
    String.raw`\b(?:run|use|call|invoke|execute)\b[^\n]*?\b` +
      escapeRegex(shellName) +
      String.raw`\b[\s\S]*?\bcommand\b\s*(?:is|:|=)\s*([\s\S]+)`,
    "i",
  );
  const m = re.exec(text);
  if (!m || m.index === undefined) return null;
  const command = m[1].trim();
  if (!command) return null;

  return {
    call: { id: nextId(), name: shellName, arguments: JSON.stringify({ command }) },
    remainingText: text.slice(0, m.index).trim(),
  };
}

/**
 * Cheap predicate: does this assistant text READ like the model narrated a
 * tool call instead of emitting one? Used by the openai-compat adapter to
 * decide whether to inject a wire-format-error nudge and retry the turn
 * once (mirrors the Anthropic adapter's `<wire-format-error: … emitted as
 * text — retry…>` recovery). Distinct from extractToolCallsFromText: this
 * only DETECTS the smell; extraction may still fail to reconstruct args,
 * which is exactly when the nudge+retry earns its keep.
 *
 * Tighter than "mentions a tool name" — requires an action verb near a
 * valid tool name, or near the literal word "tool". A normal completion
 * ("all agents are hired") returns false.
 */
export function proseLooksLikeToolCall(
  text: string,
  validToolNames: Set<string>,
): boolean {
  if (!text || typeof text !== "string") return false;
  for (const name of validToolNames) {
    const re = new RegExp(
      String.raw`\b(?:run|use|call|invoke|execute)\b[^\n]{0,30}\b` +
        escapeRegex(name) +
        String.raw`\b`,
      "i",
    );
    if (re.test(text)) return true;
  }
  return /\b(?:run|use|call|invoke|execute)\b[^\n]{0,20}\btool\b/i.test(text);
}
