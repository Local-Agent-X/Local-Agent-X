// Read-dedup may answer "you already hold this file" only when the model's
// input still carries a real read of it.
//
// read-state records what the SESSION has read, and that record outlives the
// model's view: a new op is seeded with only the tail of the previous one, and
// the seed can hold a read-dedup stub whose real read fell outside it. muse,
// grade-school, 2026-09-17: the retry turn's first read came back "Unchanged
// since this session last read it", the only earlier read in view was itself
// that stub, and the model spent turns hunting for a file it could not see.

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { resolveAgentPath } from "../workspace/paths.js";

/** Opening of the stub run-sandboxed returns; a result carrying it held no content. */
export const READ_DEDUP_STUB_LEAD = "Unchanged since this session last read it";

type WireCall = { id: string; function: { name: string; arguments: string } };

function samePath(rawArgs: string, resolved: string): boolean {
  try {
    const args = JSON.parse(rawArgs) as { path?: unknown };
    return typeof args.path === "string" && resolveAgentPath(args.path) === resolved;
  } catch {
    return false;
  }
}

/** True when `messages` hold a successful, non-stub read result for `resolved`. */
export function readContentInView(messages: ChatCompletionMessageParam[] | undefined, resolved: string): boolean {
  if (!messages) return false;
  const readIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant") {
      const calls = (m as unknown as { tool_calls?: WireCall[] }).tool_calls ?? [];
      for (const c of calls) if (c.function?.name === "read" && samePath(c.function.arguments, resolved)) readIds.add(c.id);
      continue;
    }
    if (m.role !== "tool") continue;
    const r = m as unknown as { tool_call_id?: string; content?: unknown };
    if (!r.tool_call_id || !readIds.has(r.tool_call_id) || typeof r.content !== "string") continue;
    if (r.content.includes(READ_DEDUP_STUB_LEAD)) continue;
    if (/^\[(error|blocked|timeout)\b/i.test(r.content)) continue;
    return true;
  }
  return false;
}
