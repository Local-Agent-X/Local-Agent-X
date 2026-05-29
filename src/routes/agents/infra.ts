import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, safeParseBody } from "../../server-utils.js";
import { getProviderHealthStatus, resetProviderHealth, type ProviderId } from "../../model-fallback.js";
import { linkIdentities, unlinkIdentity, getIdentityGroups, type ChannelType } from "../../session/router.js";
import { LinkIdentitiesSchema, validateBody } from "../../route-schemas.js";

export const handleInfraRoutes: RouteHandler = async (method, url, req, res, _ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  if (method === "GET" && url.pathname === "/api/identity-links") {
    json(200, getIdentityGroups()); return true;
  }
  if (method === "POST" && url.pathname === "/api/identity-links") {
    const raw = await safeParseBody(req);
    const parsed = validateBody(raw, LinkIdentitiesSchema);
    if (!parsed.success) { json(400, { error: parsed.error }); return true; }
    json(200, linkIdentities(parsed.data.identity1, parsed.data.identity2, parsed.data.displayName)); return true;
  }
  if (method === "DELETE" && url.pathname === "/api/identity-links") {
    const body = await safeParseBody(req);
    if (!body || !body.channel || !body.id) { json(400, { error: "channel and id required" }); return true; }
    json(unlinkIdentity(body.channel as ChannelType, body.id as string) ? 200 : 404, { ok: true }); return true;
  }

  if (method === "GET" && url.pathname === "/api/providers/health") {
    json(200, getProviderHealthStatus()); return true;
  }
  if (method === "POST" && url.pathname === "/api/providers/health/reset") {
    const body = await safeParseBody(req);
    if (!body || !body.provider) { json(400, { error: "provider required" }); return true; }
    resetProviderHealth(body.provider as ProviderId);
    json(200, { ok: true }); return true;
  }

  return false;
};
