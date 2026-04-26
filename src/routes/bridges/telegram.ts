import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, safeParseBody, safeErrorMessage } from "../../server-utils.js";

export const handleTelegramRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  if (method === "POST" && url.pathname === "/api/telegram/connect") {
    try { json(200, await ctx.telegramBridge.connect()); } catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/telegram/disconnect") {
    ctx.telegramBridge.disconnect(); json(200, { ok: true }); return true;
  }
  if (method === "GET" && url.pathname === "/api/telegram/status") {
    json(200, { ...ctx.telegramBridge.getStatus(), hasToken: ctx.secretsStore.has("TELEGRAM_BOT_TOKEN") }); return true;
  }
  if (method === "POST" && url.pathname === "/api/telegram/send") {
    try {
      const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
      const { chatId, message: msg } = body as { chatId?: string; message?: string };
      if (!chatId || !msg) { json(400, { error: "chatId and message are required" }); return true; }
      json(await ctx.telegramBridge.sendMessage(chatId, msg) ? 200 : 500, { ok: true });
    } catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }

  return false;
};
