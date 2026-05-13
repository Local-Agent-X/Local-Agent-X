import type { RouteHandler } from "../server-context.js";
import type { ServerEvent } from "../types.js";
import { sseWrite, corsHeaders, jsonResponse, safeParseBody } from "../server-utils.js";
import { ChatRequestSchema, validateBody } from "../route-schemas.js";
import { createLogger } from "../logger.js";
import { handleAutoDelegateRoutes } from "./chat/auto-delegate-routes.js";
import { handleCompactRoute } from "./chat/compact-route.js";
import { runChatTurn } from "./chat/run-chat-turn.js";

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

  return false;
};
