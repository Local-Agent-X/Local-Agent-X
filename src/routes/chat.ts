import type { RouteHandler } from "../server-context.js";
import type { ServerEvent } from "../types.js";
import { sseWrite, corsHeaders, jsonResponse, safeParseBody, safeErrorMessage } from "../server-utils.js";
import { ChatRequestSchema, validateBody } from "../route-schemas.js";
import { createLogger } from "../logger.js";
import { handleAutoDelegateRoutes } from "./chat/auto-delegate-routes.js";
import { handleCompactRoute } from "./chat/compact-route.js";
import { runChatTurn } from "./chat/run-chat-turn.js";
import { markDryRunSession, unmarkDryRunSession } from "../tool-executor.js";

const logger = createLogger("routes.chat");
void logger;

export const handleChatRoutes: RouteHandler = async (method, url, req, res, ctx, requestRole) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  if (await handleAutoDelegateRoutes(method, url, req, res)) return true;
  if (await handleCompactRoute(method, url, req, res, ctx)) return true;

  // Main chat SSE endpoint. The body of this turn used to live inline here
  // (~270 LOC). It's now in `run-chat-turn.ts` so the WS forward layer
  // (server/lifecycle.ts wireWsChat) can invoke the same code without an
  // HTTP self-loop. This route remains the HTTP entry for non-WS callers
  // (Telegram / WhatsApp bridges, curl, external integrations).
  if (method === "POST" && url.pathname === "/api/chat") {
    const raw = await safeParseBody(req);
    if (!raw) { json(400, { error: "Invalid JSON body" }); return true; }
    const parsed = validateBody(raw, ChatRequestSchema);
    if (!parsed.success) { json(400, { error: parsed.error }); return true; }
    const message = parsed.data.message ?? "";
    const attachments = parsed.data.attachments!;
    const sessionId = parsed.data.sessionId!;
    const projectId = (raw as Record<string, unknown>).projectId;

    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", ...corsHeaders(req) });

    // Heartbeat keeps the SSE connection alive for slow tool turns. The
    // runChatTurn helper doesn't know about res; the route owns the
    // transport-level keepalive. Cleared in the finally below.
    const heartbeat = setInterval(() => {
      if (!res.destroyed) res.write(": heartbeat\n\n");
      else clearInterval(heartbeat);
    }, 15_000);

    const sseSink = (event: ServerEvent) => {
      if (!res.writableEnded) sseWrite(res, event);
    };

    try {
      await runChatTurn({
        sessionId,
        message,
        attachments,
        projectId,
        ctx,
        requestRole,
        sseSink,
      });
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
    return true;
  }

  // ── Eval endpoint ──
  // Lightweight wrapper for the tool-discovery eval (eval/tool-discovery/).
  // Runs ONE chat turn, captures the first tool_start event server-side, then
  // deletes the throwaway session so the user's sidebar stays clean. Returns
  // a small JSON envelope instead of an SSE stream — easier to consume from a
  // test script. The chat turn itself still runs in the background to completion
  // (we can't safely abort mid-turn without leaking state), but the session is
  // tombstoned on return so it never surfaces in the UI.
  if (method === "POST" && url.pathname === "/api/eval/run") {
    const raw = await safeParseBody(req);
    if (!raw) { json(400, { error: "Invalid JSON body" }); return true; }
    const evalBody = raw as { message?: string; timeoutMs?: number };
    const message = String(evalBody.message || "").trim();
    if (!message) { json(400, { error: "message is required" }); return true; }
    const timeoutMs = Math.min(Math.max(Number(evalBody.timeoutMs) || 60_000, 5_000), 120_000);

    const evalSessionId = `eval-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    // Mark the session as dry-run BEFORE we kick off the chat turn so the
    // very first tool dispatch hits the short-circuit. Cleared in `finally`.
    markDryRunSession(evalSessionId);
    let firstTool: string | null = null;
    const allTools: string[] = [];
    let assistantText = "";
    let errorMsg: string | null = null;

    // Resolve once the first tool_start fires OR the turn ends OR we time out.
    let resolve: () => void;
    const done = new Promise<void>((r) => { resolve = r; });
    const timer = setTimeout(() => { errorMsg = errorMsg || "timeout"; resolve(); }, timeoutMs);
    const captureSink = (event: ServerEvent) => {
      if (event.type === "tool_start") {
        allTools.push(event.toolName);
        if (!firstTool) { firstTool = event.toolName; resolve(); }
      } else if (event.type === "stream") {
        if ("delta" in event && typeof event.delta === "string") assistantText += event.delta;
        else if ("text" in event && typeof event.text === "string") assistantText = event.text;
      } else if (event.type === "error") {
        errorMsg = event.message;
      } else if (event.type === "done") {
        resolve();
      }
    };

    // Fire-and-forget the chat turn — we resolve `done` as soon as we have the
    // first tool (or the turn ends / times out) and return the envelope. The
    // turn keeps running in the background and may dispatch more tools, so
    // dry-run must stay in effect for its WHOLE lifetime — but no longer.
    // Unmark + tombstone the session when the turn actually settles, not on a
    // fixed timer: a fixed window either expired mid-turn or lingered onto a
    // later real turn on the same session and silently dry-ran it.
    void runChatTurn({
      sessionId: evalSessionId,
      message,
      attachments: [],
      projectId: null,
      ctx,
      requestRole,
      sseSink: captureSink,
    })
      .catch((e) => { errorMsg = errorMsg || safeErrorMessage(e); resolve(); })
      .finally(() => {
        unmarkDryRunSession(evalSessionId);
        // sessionStore.delete is idempotent; deleting only after the turn has
        // settled avoids the background turn re-persisting (resurrecting) it.
        try { ctx.sessionStore.delete(evalSessionId); } catch {}
      });

    try {
      await done;
    } finally {
      clearTimeout(timer);
    }

    json(200, { firstTool, allTools, assistantText: assistantText.slice(0, 500), error: errorMsg });
    return true;
  }

  return false;
};
