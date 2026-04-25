/** Parse tool calls from Claude's text response — extracts ALL JSON blocks in order */
export function parseToolCalls(text: string): Array<{ name: string; arguments: Record<string, unknown> }> {
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
  return results;
}

/** Clean trailing punctuation from URLs so links aren't broken */
export function cleanUrls(text: string): string {
  return text.replace(/(https?:\/\/[^\s)>\]]+)[.,;:!?]+(\s|$)/g, "$1$2");
}

/** Filter streaming deltas — suppress JSON tool call blocks in real-time */
export function filterStreamDelta(delta: string, alreadySuppressing: boolean): { text?: string; suppress?: boolean } {
  // If we're already suppressing (inside a JSON block), keep suppressing
  if (alreadySuppressing) {
    // Check if block ended
    if (delta.includes("```") || delta.includes("}\n")) return { text: "" };
    return { suppress: true };
  }
  // Check if a tool call block is starting
  if (delta.includes('```json') || delta.includes('{"tool_calls"')) return { suppress: true };
  // Check for code fence start (might be a tool call coming)
  if (delta.trim() === '```') return { suppress: true };
  return { text: delta };
}

/** Strip JSON tool call blocks from text so they don't show in the UI */
export function stripToolCallBlocks(text: string): string {
  // Remove ```json tool_calls blocks
  let cleaned = text.replace(/```(?:json)?\s*\n?\{[\s\S]*?"tool_calls"[\s\S]*?\}\s*\n?```/g, "");
  // Remove raw JSON tool_calls
  cleaned = cleaned.replace(/\{"tool_calls"\s*:\s*\[[\s\S]*?\]\s*\}/g, "");
  return cleaned;
}
