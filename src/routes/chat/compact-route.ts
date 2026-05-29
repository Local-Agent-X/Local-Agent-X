import type { IncomingMessage, ServerResponse } from "node:http";

import { CompactSchema, validateBody } from "../../route-schemas.js";
import type { ServerContext } from "../../server-context.js";
import { jsonResponse, safeParseBody } from "../../server-utils.js";

/**
 * Handle POST /api/compact. Builds a summary of older messages and persists
 * it as a leading `system` row in `session.messages` (round-tripped through
 * a `summary` row in the per-session jsonl on disk). prepareAgentRequest
 * then sees the system message at index 0 and uses it without any
 * special-case slice/prepend logic.
 *
 * Returns `true` if the request was handled.
 */
export async function handleCompactRoute(
  method: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
): Promise<boolean> {
  if (!(method === "POST" && url.pathname === "/api/compact")) return false;

  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);
  const raw = await safeParseBody(req);
  const parsed = validateBody(raw, CompactSchema);
  if (!parsed.success) { json(400, { error: parsed.error }); return true; }

  const sessionId = parsed.data.sessionId!;
  // Read-modify-write of the transcript: flush any in-flight bridge write
  // first, or we'd compact (and persist) a transcript missing the last turn.
  await ctx.flushSession(sessionId);
  const session = ctx.getOrCreateSession(sessionId);
  if (session.messages.length < 10) {
    json(200, { ok: false, reason: `Only ${session.messages.length} messages (need 10+)` });
    return true;
  }

  const KEEP_RECENT = Math.min(20, session.messages.length - 5);
  let cutIdx = Math.max(0, session.messages.length - KEEP_RECENT);
  for (let i = cutIdx; i < session.messages.length; i++) {
    if (session.messages[i].role === "user") { cutIdx = i; break; }
  }
  const oldMessages = session.messages.slice(0, cutIdx);
  const recentMessages = session.messages.slice(cutIdx);

  const summaryLines: string[] = [];
  for (const m of oldMessages) {
    if (m.role === "user" && typeof m.content === "string") {
      summaryLines.push(`[User] ${m.content.slice(0, 200).replace(/\n/g, " ")}`);
    } else if (m.role === "assistant" && typeof m.content === "string") {
      summaryLines.push(
        `[Agent] ${m.content.split("\n").filter(l => l.trim()).slice(0, 2).join(" ").slice(0, 200)}`,
      );
    }
  }
  const compactSummary =
    `[COMPACTED CONTEXT — ${oldMessages.length} messages summarized]\n${summaryLines.join("\n")}\n[END COMPACTED CONTEXT — ${recentMessages.length} recent messages follow]`;

  session.messages = [
    { role: "system", content: compactSummary },
    ...recentMessages,
  ];
  session.updatedAt = Date.now();
  ctx.sessionStore.save(session);

  json(200, {
    ok: true,
    compactedAt: oldMessages.length,
    oldCount: oldMessages.length,
    recentCount: recentMessages.length,
  });
  return true;
}
