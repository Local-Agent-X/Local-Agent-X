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
 * (`<execute_tool>`, `<tool_call>`, …), bracket markers, channel-marker
 * leaks, and plain-English narration.
 *
 * Three layers, strongest signal first (heuristic, not a general parser):
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
 *   3. **Prose narration** ("run tool bash with command is …"), strictly
 *      last and only when the layers above found nothing.
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

import { findJsonObjects, resolveToolName } from "./tool-call-text-repair.js";
import {
  escapeRegex,
  isBrowserShorthand,
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
  // set and whose payload is within caps. Unpromoted hits stay in the text,
  // but their bytes are off-limits to the naked-JSON layer below so a block
  // rejected here (truncated, over-cap, unresolvable) can't sneak back in
  // through its inner JSON.
  const syntaxHits = scanTextToolCallSyntaxes(working);
  const found: Array<{ start: number; end: number; call: ExtractedToolCall }> = [];
  for (const hit of syntaxHits) {
    if (!hit.candidate || !withinCaps(hit.candidate)) continue;
    const resolved = resolveToolName(hit.candidate.name, validToolNames);
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

  // Layer 3 — prose reconstruction, strictly last: only when no marked
  // syntax or JSON tool call was salvageable anywhere in the turn.
  if (found.length === 0) {
    const prose = extractProseCalls(text, validToolNames);
    if (prose.calls.length > 0) return { toolCalls: prose.calls, remainingText: prose.remainingText };
    return { toolCalls: [], remainingText: text };
  }

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

  // Pattern 3 (prose narration) is NOT classified here — it has no JSON to
  // parse. It's handled by extractProseCalls, called from the top-level
  // extractor only after JSON classification finds nothing.

  // Pattern 2: browser shorthand { action: "X", ref: N, ... }. The shape
  // rules live in isBrowserShorthand — shared with the syntax layer so
  // wrapped shorthand promotes identically. Only fires when "browser" is
  // in validToolNames.
  if (validToolNames.has("browser") && isBrowserShorthand(obj)) {
    return { id: nextId(), name: "browser", arguments: JSON.stringify(obj) };
  }

  return null;
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
 * Live failure 2026-06-04 (xAI Grok): weaker OpenAI-compat
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

/**
 * Last-resort guard for the openai-compat adapter: after the one-shot
 * wire-format retry, a stubborn model (Grok narrating an `edit` is the live
 * case) may STILL describe the call in prose instead of emitting it. Left
 * alone, that false-confident text ("I'll edit the file…") becomes the
 * assistant reply with nothing executed — a silent no-op the user reads as
 * success. Return an annotated copy of the text that makes the failure
 * visible to both the user and the model's next turn. Returns null when
 * there's nothing to flag (a real call was salvaged, or the text isn't
 * narration) so the caller leaves a healthy turn untouched.
 */
export function annotatePersistentNarration(
  assembledText: string,
  pendingToolCallCount: number,
  validToolNames: Set<string>,
): string | null {
  if (pendingToolCallCount > 0) return null;
  if (!proseLooksLikeToolCall(assembledText, validToolNames)) return null;
  return (
    assembledText.trimEnd() +
    "\n\n[wire-format-error: the text above described a tool call but did not emit one — nothing was executed. Reissue it as a real tool call.]"
  );
}
