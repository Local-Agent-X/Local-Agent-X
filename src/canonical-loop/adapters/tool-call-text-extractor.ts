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

  // Structured JSON wins. Only fall back to prose reconstruction when no JSON
  // tool call was salvageable — keeps the cheap, unambiguous path first and
  // the heuristic prose path strictly last.
  if (calls.length === 0) {
    const prose = extractProseCalls(text, validToolNames);
    if (prose.calls.length > 0) return { toolCalls: prose.calls, remainingText: prose.remainingText };
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

  // Pattern 3 (prose narration) is NOT classified here — it has no JSON to
  // parse. It's handled by extractProseCalls, called from the top-level
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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Action verbs that open a narrated tool call ("run tool bash …"). */
const PROSE_VERB = String.raw`(?:run|use|call|invoke|execute)`;

/**
 * Tools whose prose narration can be reconstructed into a real call. Each
 * entry lists the tool's args IN THE ORDER the model narrates them; the LAST
 * arg captures verbatim to the segment end (handles unbounded values: shell
 * heredocs, file content). A tool earns an entry only once we've observed the
 * model narrate it AND its args are ordered scalars where the tail can be
 * greedily captured — `edit`/`agent_spawn`/etc. are deliberately absent
 * (object args or ambiguous unbounded boundaries) and ride the adapter's
 * nudge+retry instead.
 */
const PROSE_RECONSTRUCTABLE: ReadonlyArray<{ name: string; args: ReadonlyArray<string> }> = [
  { name: "bash", args: ["command"] },
  { name: "shell", args: ["command"] },
  { name: "ari_shell", args: ["command"] },
  { name: "write", args: ["path", "content"] },
  { name: "read", args: ["path"] },
];

/** Parse "arg1 is <v1> arg2 is <v2> … argN is <rest>" from one invocation's
 *  text. Non-final args capture non-greedily up to the next arg's marker; the
 *  final arg captures to end. An explicit value marker (is | : | =) is
 *  required after each arg name — that's what separates a real invocation
 *  ("path is f.txt") from a casual mention ("the write path"). Returns null
 *  if any arg is missing or empty. */
function parseNarratedArgs(
  segment: string,
  argNames: ReadonlyArray<string>,
): Record<string, string> | null {
  let pattern = "";
  for (let i = 0; i < argNames.length; i++) {
    const isFinal = i === argNames.length - 1;
    pattern +=
      String.raw`\b${escapeRegex(argNames[i])}\b\s*(?:is|:|=)\s*` +
      (isFinal ? String.raw`([\s\S]+)` : String.raw`([\s\S]*?)\s*`);
  }
  const m = new RegExp(pattern, "i").exec(segment);
  if (!m) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < argNames.length; i++) {
    const v = (m[i + 1] || "").trim();
    if (!v) return null;
    out[argNames[i]] = v;
  }
  return out;
}

/**
 * Prose-narration fallback (Pattern 3).
 *
 * Live failure 2026-06-04 (Nutrishop demo, xAI Grok): weaker OpenAI-compat
 * models DESCRIBE tool calls in English instead of emitting structured
 * tool_calls — or even the JSON the extractor above catches — e.g.
 * `run tool write with path is f.txt content is …`, often several in one
 * turn. With no JSON to parse, the calls never dispatch and the trailing
 * "Committed" prose trips the false-completion guard.
 *
 * Splits the text into one segment per invocation header (verb + a
 * reconstructable, allowed tool name) and reconstructs each via
 * parseNarratedArgs. Conservative: a segment with no value marker yields no
 * call, so casual mentions ("run the bash command to verify") are ignored.
 * Reconstructed calls flow through normal approval + sandbox downstream, so
 * they get the same safety as structured calls.
 */
function extractProseCalls(
  text: string,
  validToolNames: Set<string>,
): { calls: ExtractedToolCall[]; remainingText: string } {
  const specs = PROSE_RECONSTRUCTABLE.filter((s) => validToolNames.has(s.name));
  if (specs.length === 0) return { calls: [], remainingText: text };

  const nameAlt = specs.map((s) => escapeRegex(s.name)).join("|");
  const headerRe = new RegExp(String.raw`\b${PROSE_VERB}\b[^\n]*?\b(${nameAlt})\b`, "gi");

  const heads: Array<{ name: string; start: number; bodyStart: number }> = [];
  let hm: RegExpExecArray | null;
  while ((hm = headerRe.exec(text)) !== null) {
    heads.push({ name: hm[1].toLowerCase(), start: hm.index, bodyStart: headerRe.lastIndex });
    if (headerRe.lastIndex === hm.index) headerRe.lastIndex++;
  }
  if (heads.length === 0) return { calls: [], remainingText: text };

  const calls: ExtractedToolCall[] = [];
  const consumed: Array<[number, number]> = [];
  for (let i = 0; i < heads.length; i++) {
    const head = heads[i];
    const segEnd = i + 1 < heads.length ? heads[i + 1].start : text.length;
    const spec = specs.find((s) => s.name === head.name);
    if (!spec) continue;
    const args = parseNarratedArgs(text.slice(head.bodyStart, segEnd), spec.args);
    if (!args) continue;
    calls.push({ id: nextId(), name: head.name, arguments: JSON.stringify(args) });
    consumed.push([head.start, segEnd]);
  }
  if (calls.length === 0) return { calls: [], remainingText: text };

  consumed.sort((a, b) => b[0] - a[0]);
  let working = text;
  for (const [start, end] of consumed) working = working.slice(0, start) + working.slice(end);
  return { calls, remainingText: working.trim() };
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
