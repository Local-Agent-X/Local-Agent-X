import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, readBody } from "../../server-utils.js";

export const handleChatStatusRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  if (method === "GET" && url.pathname === "/api/chats/active") {
    json(200, { active: ctx.chatWs.getActiveChats() }); return true;
  }
  if (method === "POST" && url.pathname === "/api/chats/stop") {
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req)); } catch { json(400, { error: "Invalid JSON" }); return true; }
    const sid = String(body.sessionId || "");
    if (!sid) { json(400, { error: "sessionId required" }); return true; }
    const stopped = ctx.chatWs.stopChat(sid);
    // Abort + release the turn lock — mirrors the WS stop handler in chat-ws.ts.
    // Without releaseTurn the next message hits "previous request still running"
    // because the lock waits for the agent loop's finally block, which can take
    // 60s+ if a subprocess stalls. Stop should mean stop.
    let lockAborted = false;
    try {
      const { abortTurn, releaseTurn } = await import("../../session-turn-lock.js");
      lockAborted = abortTurn(sid);
      releaseTurn(sid);
    } catch {}
    json(200, { ok: true, stopped: sid, wasActive: stopped, turnLockAborted: lockAborted }); return true;
  }
  // Active-turn status probe. Frontend hits this to show "agent is working —
  // iteration 5, last tool: bash, 42s elapsed" instead of a bare spinner.
  if (method === "GET" && url.pathname.match(/^\/api\/chats\/[^/]+\/status$/)) {
    const sid = decodeURIComponent(url.pathname.split("/")[3]);
    try {
      const { getActiveTurn } = await import("../../session-turn-lock.js");
      const turn = getActiveTurn(sid);
      json(200, { active: turn !== null, turn });
    } catch { json(200, { active: false, turn: null }); }
    return true;
  }

  return false;
};
