import type { RouteHandler } from "../../../server-context.js";
import { jsonResponse } from "../../../server-utils.js";
import { handleTierProbe } from "./tier-probe.js";
import { handleChatterboxProxy } from "./chatterbox-proxy.js";

export const handleVoiceCloneRoutes: RouteHandler = async (method, url, req, res, _ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  // /api/voices/tier — capability probe; reports Chatterbox readiness
  if (method === "GET" && url.pathname === "/api/voices/tier") {
    await handleTierProbe(json);
    return true;
  }

  // /api/voices/chatterbox/* → Chatterbox sidecar (:7010)
  if (url.pathname === "/api/voices/chatterbox" || url.pathname.startsWith("/api/voices/chatterbox/")) {
    await handleChatterboxProxy(method, url.pathname, req, json);
    return true;
  }

  return false;
};
