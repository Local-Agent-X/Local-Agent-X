import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, safeParseBody, safeErrorMessage } from "../../server-utils.js";

export const handleWhatsappRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  if (method === "POST" && url.pathname === "/api/whatsapp/connect") {
    try { json(200, await ctx.whatsappBridge.connect()); } catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/whatsapp/disconnect") {
    await ctx.whatsappBridge.disconnect(); json(200, { ok: true }); return true;
  }
  if (method === "POST" && url.pathname === "/api/whatsapp/reset") {
    await ctx.whatsappBridge.reset(); json(200, { ok: true }); return true;
  }
  if (method === "GET" && url.pathname === "/api/whatsapp/status") {
    json(200, await ctx.whatsappBridge.getStatus()); return true;
  }
  if (method === "POST" && url.pathname === "/api/whatsapp/send") {
    try {
      const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
      const { to, message: msg } = body as { to?: string; message?: string };
      if (!to || !msg) { json(400, { error: "to and message are required" }); return true; }
      const ok = await ctx.whatsappBridge.sendMessage(to, msg);
      json(ok ? 200 : 500, { ok, error: ok ? undefined : "Failed to send" });
    } catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/whatsapp/allowed-numbers") {
    try {
      const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
      ctx.whatsappBridge.setAllowedNumbers((body.numbers || []) as string[]);
      json(200, { ok: true, numbers: body.numbers || [] });
    } catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }

  return false;
};
