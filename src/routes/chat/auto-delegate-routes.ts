import type { IncomingMessage, ServerResponse } from "node:http";

import { jsonResponse, safeParseBody } from "../../server-utils.js";

/**
 * Handles the three small auto-delegate / op-kill endpoints. Returns
 * `true` if the request matched (response was written), `false` otherwise.
 */
export async function handleAutoDelegateRoutes(
  method: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  // GET /api/auto-delegate/recent — last N decisions, persistent across restarts
  // (~/.lax/auto-delegate-decisions.jsonl). Useful for tuning the discussion-
  // mode regex from real corrections.
  if (method === "GET" && url.pathname === "/api/auto-delegate/recent") {
    const { getRecentAutoDelegateDecisions } = await import("../../routing/index.js");
    const limit = parseInt(url.searchParams.get("limit") || "50", 10);
    json(200, { decisions: getRecentAutoDelegateDecisions(limit) });
    return true;
  }

  // POST /api/op/kill — UI kill button (e.g. tool_chip "blocked-by-op"
  // chip). Routes through canonical opCancel.
  if (method === "POST" && url.pathname === "/api/op/kill") {
    const body = await safeParseBody(req);
    const opId = typeof body?.op_id === "string" ? body.op_id : "";
    if (!opId) { json(400, { ok: false, error: "op_id required" }); return true; }
    const { opCancel } = await import("../../canonical-loop/index.js");
    const res = opCancel(opId, "user-kill");
    json(200, { ok: res.ok });
    return true;
  }

  // POST /api/auto-delegate/override — user clicked "Stay inline" on a
  // worker card. Kill the op, mark the decision as a user-override (THE
  // training signal), and return the original message so the chat can
  // resubmit with /discuss prepended. Bypass the auto-delegate next time
  // for this exact message.
  if (method === "POST" && url.pathname === "/api/auto-delegate/override") {
    const body = await safeParseBody(req);
    const opId = typeof body?.opId === "string" ? body.opId : "";
    if (!opId) { json(400, { error: "opId required" }); return true; }
    const { markDecisionAsUserOverride } = await import("../../routing/index.js");
    const { opCancel } = await import("../../canonical-loop/index.js");
    const result = markDecisionAsUserOverride(opId);
    const killed = opCancel(opId, "user-override").ok;
    json(200, {
      ok: true,
      opId,
      killed,
      message: result.message,
      hint: "Resubmit the returned message with /discuss prefix to bypass auto-delegate.",
    });
    return true;
  }

  return false;
}
