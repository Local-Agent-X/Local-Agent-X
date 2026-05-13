/**
 * Parse tool calls from Claude's text response — extracts ALL JSON blocks in order.
 *
 * Three shapes catch:
 *   1. ```json {"tool_calls": [...]} ``` — fenced OpenAI envelope (prompt-injected shape)
 *   2. {"tool_calls": [...]} — bare OpenAI envelope (no fence)
 *   3. {"name":"X","input":{...}} — bare Anthropic native tool_use shape, only
 *      matched against `validToolNames` so legitimate example JSON in prose
 *      doesn't get mis-fired. Claude 4.x drifts to native shape when it
 *      ignores the prompt-injected envelope instruction.
 */
export function parseToolCalls(
  text: string,
  validToolNames?: ReadonlySet<string>,
): Array<{ name: string; arguments: Record<string, unknown> }> {
  const results: Array<{ name: string; arguments: Record<string, unknown> }> = [];

  // Match ALL ```json tool_calls blocks (Claude sometimes outputs multiple)
  const fencedRe = /```(?:json)?\s*\n?(\{[\s\S]*?"tool_calls"[\s\S]*?\})\s*\n?```/g;
  let match: RegExpExecArray | null;
  while ((match = fencedRe.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (Array.isArray(parsed.tool_calls)) {
        for (const tc of parsed.tool_calls) {
          if (tc.name) results.push({ name: tc.name, arguments: tc.arguments || {} });
        }
      }
    } catch {}
  }
  if (results.length > 0) return results;

  // Also match raw JSON (no code fence) — Claude sometimes outputs without backticks
  const rawRe = /\{"tool_calls"\s*:\s*\[[\s\S]*?\]\s*\}/g;
  while ((match = rawRe.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed.tool_calls)) {
        for (const tc of parsed.tool_calls) {
          if (tc.name) results.push({ name: tc.name, arguments: tc.arguments || {} });
        }
      }
    } catch {}
  }
  if (results.length > 0) return results;

  // Anthropic native shape — only when caller provides the valid tool set
  if (validToolNames && validToolNames.size > 0) {
    for (const m of findAnthropicShapeCalls(text, validToolNames)) {
      results.push({ name: m.name, arguments: m.arguments });
    }
  }
  return results;
}

interface AnthropicShapeMatch {
  name: string;
  arguments: Record<string, unknown>;
  /** Index of the leading `{` of the outer envelope. */
  startIdx: number;
  /** Index one past the trailing `}` of the outer envelope. */
  endIdx: number;
}

function findAnthropicShapeCalls(text: string, validNames: ReadonlySet<string>): AnthropicShapeMatch[] {
  const matches: AnthropicShapeMatch[] = [];
  const startRe = /\{\s*"name"\s*:\s*"([^"\\]+)"\s*,\s*"input"\s*:\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = startRe.exec(text)) !== null) {
    const name = m[1];
    if (!validNames.has(name)) continue;
    // m[0] ends with the `{` opening the input object — back up one to point at it.
    const inputOpen = m.index + m[0].length - 1;
    const inputClose = findMatchingBrace(text, inputOpen);
    if (inputClose === -1) continue;
    let j = inputClose + 1;
    while (j < text.length && /\s/.test(text[j])) j++;
    if (text[j] !== "}") continue;
    try {
      const args = JSON.parse(text.slice(inputOpen, inputClose + 1));
      if (args && typeof args === "object" && !Array.isArray(args)) {
        matches.push({ name, arguments: args as Record<string, unknown>, startIdx: m.index, endIdx: j + 1 });
      }
    } catch {}
  }
  return matches;
}

function findMatchingBrace(text: string, openIdx: number): number {
  let depth = 1;
  let inStr = false;
  let escaped = false;
  for (let i = openIdx + 1; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Clean trailing punctuation from URLs so links aren't broken */
export function cleanUrls(text: string): string {
  return text.replace(/(https?:\/\/[^\s)>\]]+)[.,;:!?]+(\s|$)/g, "$1$2");
}

/**
 * Filter streaming deltas — suppress JSON tool call blocks AND Claude's
 * native XML tool-use blocks in real-time.
 *
 * Live failure: Claude's internal XML tool-call format
 * (<tool_use>...<parameter name="name">...</parameter>...</tool_use>)
 * sometimes leaks into the streamed text reply instead of being parsed
 * as a structured tool_use content block. The user sees the raw XML in
 * chat. Both shapes need streaming-time suppression so the leak doesn't
 * paint the chat with markup before we can clean it up.
 */
export function filterStreamDelta(delta: string, alreadySuppressing: boolean): { text?: string; suppress?: boolean } {
  if (alreadySuppressing) {
    // Block ended — JSON close OR XML close tag for tool_use / function_calls
    if (
      delta.includes("```") ||
      delta.includes("}\n") ||
      delta.includes("</tool_use>") ||
      delta.includes("</function_calls>")
    ) return { text: "" };
    return { suppress: true };
  }
  // Tool-call block starting — JSON form OR XML form
  if (
    delta.includes("```json") ||
    delta.includes('{"tool_calls"') ||
    delta.includes("<tool_use>") ||
    delta.includes("<function_calls>")
  ) return { suppress: true };
  // Bare code-fence start (might precede a JSON tool call)
  if (delta.trim() === "```") return { suppress: true };
  return { text: delta };
}

/**
 * Strip JSON tool-call blocks AND XML tool_use blocks from text so they
 * don't show in the UI. Used as a post-hoc cleanup for the full assistant
 * message in case the streaming filter missed a leak (split across deltas,
 * partial tags, etc).
 *
 * Pass `validToolNames` to also strip bare Anthropic native shape
 * `{"name":"X","input":{...}}` — without it those bare envelopes are
 * indistinguishable from legitimate example JSON in prose.
 */
export function stripToolCallBlocks(text: string, validToolNames?: ReadonlySet<string>): string {
  let cleaned = text;
  // ```json tool_calls blocks (fenced)
  cleaned = cleaned.replace(/```(?:json)?\s*\n?\{[\s\S]*?"tool_calls"[\s\S]*?\}\s*\n?```/g, "");
  // Raw JSON tool_calls
  cleaned = cleaned.replace(/\{"tool_calls"\s*:\s*\[[\s\S]*?\]\s*\}/g, "");
  // Claude's native XML form: <tool_use>...</tool_use> with <parameter> children
  cleaned = cleaned.replace(/<tool_use>[\s\S]*?<\/tool_use>/g, "");
  // Anthropic SDK alternate form: <function_calls>...</function_calls>
  cleaned = cleaned.replace(/<function_calls>[\s\S]*?<\/function_calls>/g, "");
  // Standalone <parameter name="...">...</parameter> blocks (in case the
  // outer <tool_use> tag was already stripped or never streamed)
  cleaned = cleaned.replace(/<parameter\s+name="[^"]*">[\s\S]*?<\/parameter>/g, "");
  // Bare Anthropic native shape — uses brace-balanced scanning so nested
  // input objects don't break the strip.
  if (validToolNames && validToolNames.size > 0) {
    const matches = findAnthropicShapeCalls(cleaned, validToolNames);
    if (matches.length > 0) {
      let out = "";
      let cursor = 0;
      for (const m of matches) {
        out += cleaned.slice(cursor, m.startIdx);
        cursor = m.endIdx;
      }
      out += cleaned.slice(cursor);
      cleaned = out;
    }
  }
  return cleaned.trim();
}
