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

// ── Layer 3: History-rebuild sanitization ─────────────────────────────────
//
// When loading prior assistant messages for the next turn, any tool-call
// JSON / XML / tree-style notation that leaked into content is REPLACED
// with a corrective annotation. This breaks the feedback loop where claude
// sees its own bad output in history and learns "this is how I respond
// here," degrading subsequent turns. Layered on top of stream-time + persist-
// time stripping — defense in depth.
//
// See docs/tool-resolver-design.md for the broader pattern.

export type LeakShape =
  | "openai-envelope-fenced"   // ```json {"tool_calls":[...]}```
  | "openai-envelope-raw"      // {"tool_calls":[...]}
  | "anthropic-native"         // {"name":"X","input":{...}}
  | "anthropic-native-array"   // [{"name":"X","input":{...}}]
  | "anthropic-xml-tool-use"   // <tool_use>...</tool_use>
  | "anthropic-xml-fcalls"     // <function_calls>...</function_calls>
  | "tree-style-call"          // Bash(...) / Edit(...) / etc on its own line
  | "placeholder-narration";   // [Calling] / [Tool] / [Going] etc

export interface LeakInfo {
  shape: LeakShape;
  /** Tool name when recoverable from the leak; null for placeholders. */
  toolName: string | null;
  /** First 80 chars of the leak, for log diagnostics. */
  preview: string;
}

/**
 * Sanitize assistant text for the NEXT turn's request. Returns the cleaned
 * text with each leak replaced by a corrective marker, plus a list of
 * detections for telemetry.
 *
 * The corrective marker is deliberately model-readable:
 *   <wire-format-error: prior attempt to call <tool> emitted as text — not delivered. retry using proper tool_use.>
 *
 * Without the marker, silently stripping leaves the model confused ("I
 * thought I called that tool"). The marker tells it explicitly what went
 * wrong so the next attempt is clean.
 */
export function sanitizeAssistantTextForRebuild(
  text: string,
  validToolNames?: ReadonlySet<string>,
): { cleaned: string; leaks: LeakInfo[] } {
  if (!text) return { cleaned: text, leaks: [] };
  const leaks: LeakInfo[] = [];
  let cleaned = text;

  // 1. OpenAI envelope (fenced)
  cleaned = cleaned.replace(/```(?:json)?\s*\n?(\{[\s\S]*?"tool_calls"[\s\S]*?\})\s*\n?```/g, (_m, body) => {
    leaks.push({ shape: "openai-envelope-fenced", toolName: extractFirstName(body), preview: previewOf(body) });
    return correctiveMarker(extractFirstName(body));
  });

  // 2. OpenAI envelope (raw)
  cleaned = cleaned.replace(/\{"tool_calls"\s*:\s*\[[\s\S]*?\]\s*\}/g, (m) => {
    leaks.push({ shape: "openai-envelope-raw", toolName: extractFirstName(m), preview: previewOf(m) });
    return correctiveMarker(extractFirstName(m));
  });

  // 3. Anthropic XML (<tool_use> / <function_calls>)
  cleaned = cleaned.replace(/<tool_use>[\s\S]*?<\/tool_use>/g, (m) => {
    leaks.push({ shape: "anthropic-xml-tool-use", toolName: extractXmlToolName(m), preview: previewOf(m) });
    return correctiveMarker(extractXmlToolName(m));
  });
  cleaned = cleaned.replace(/<function_calls>[\s\S]*?<\/function_calls>/g, (m) => {
    leaks.push({ shape: "anthropic-xml-fcalls", toolName: extractXmlToolName(m), preview: previewOf(m) });
    return correctiveMarker(extractXmlToolName(m));
  });

  // 4. Anthropic native + array-wrapped — uses brace-balanced scan. Array
  //    wrappers are handled implicitly because the regex finds the inner
  //    `{`, the matched range is the object, and we splice that out;
  //    leftover `[]` brackets are removed via post-pass cleanup below.
  if (validToolNames && validToolNames.size > 0) {
    const matches = findAnthropicShapeCalls(cleaned, validToolNames);
    if (matches.length > 0) {
      let out = "";
      let cursor = 0;
      for (const m of matches) {
        // Detect array-wrapping by looking at chars immediately surrounding the match.
        const before = cleaned.slice(Math.max(0, m.startIdx - 4), m.startIdx);
        const after = cleaned.slice(m.endIdx, m.endIdx + 4);
        const inArray = before.trimEnd().endsWith("[") && after.trimStart().startsWith("]");
        out += cleaned.slice(cursor, m.startIdx);
        leaks.push({
          shape: inArray ? "anthropic-native-array" : "anthropic-native",
          toolName: m.name,
          preview: previewOf(cleaned.slice(m.startIdx, m.endIdx)),
        });
        out += correctiveMarker(m.name);
        cursor = m.endIdx;
      }
      out += cleaned.slice(cursor);
      cleaned = out;
      // Remove empty `[]` brackets left over from array-wrapped extractions.
      cleaned = cleaned.replace(/\[\s*\]/g, "");
    }
  }

  // 5. Tree-style notation: lines that ARE just `ToolName(...)` with no
  //    surrounding prose. Conservative — only fires when the toolName
  //    matches a valid tool. Catches Claude Code's rendering style leaking
  //    in: `Bash(ls -la ...)` / `└ Bash(...)` etc.
  if (validToolNames && validToolNames.size > 0) {
    const treeRe = /^[\s└|│├─]*([A-Z][a-zA-Z_]+)\s*\(([\s\S]*?)\)\s*$/gm;
    cleaned = cleaned.replace(treeRe, (m, name: string) => {
      const camelToSnake = name.replace(/([A-Z])/g, (_x, c, i) => i === 0 ? c.toLowerCase() : "_" + c.toLowerCase());
      if (validToolNames.has(name) || validToolNames.has(camelToSnake) || validToolNames.has(name.toLowerCase())) {
        leaks.push({ shape: "tree-style-call", toolName: name, preview: previewOf(m) });
        return correctiveMarker(name);
      }
      return m;
    });
  }

  // 6. Placeholder narration: lines that ARE just `[Calling]` / `[Tool]` /
  //    `[Going]` etc — generated when the model loses its thread and
  //    narrates intent without dispatching. Very conservative: only the
  //    exact words below, only when alone on a line.
  cleaned = cleaned.replace(/^[\s>]*\[(Calling|Tool|Going|Run|Bash|Edit|Read|Write|Doing|Executing|Now)[^\]]{0,30}\]\s*$/gm, (m) => {
    leaks.push({ shape: "placeholder-narration", toolName: null, preview: previewOf(m) });
    return correctiveMarker(null);
  });

  // Collapse 3+ consecutive newlines that excisions may have produced.
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

  return { cleaned, leaks };
}

function correctiveMarker(toolName: string | null): string {
  if (toolName) {
    return `<wire-format-error: prior attempt to call ${toolName} emitted as text — not delivered. retry using proper tool_use.>`;
  }
  return `<wire-format-error: prior assistant narrated tool-call intent without dispatching — retry using proper tool_use.>`;
}

function previewOf(s: string): string {
  return s.replace(/\s+/g, " ").slice(0, 80);
}

function extractFirstName(jsonBody: string): string | null {
  const m = /"name"\s*:\s*"([^"\\]+)"/.exec(jsonBody);
  return m ? m[1] : null;
}

function extractXmlToolName(xml: string): string | null {
  const m = /<(?:tool_name|n)>\s*([^<\s]+)\s*<\/(?:tool_name|n)>/.exec(xml);
  if (m) return m[1];
  const m2 = /name="([^"]+)"/.exec(xml);
  return m2 ? m2[1] : null;
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
    // Block ended — JSON close OR XML close tag for tool_use / function_calls.
    // Must explicitly return suppress:false so the consumer resets state;
    // empty text is falsy and won't reset on its own.
    if (
      delta.includes("```") ||
      delta.includes("}\n") ||
      delta.includes("</tool_use>") ||
      delta.includes("</function_calls>")
    ) return { text: "", suppress: false };
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
