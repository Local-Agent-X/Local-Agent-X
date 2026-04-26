import type { RouteHandler } from "../../server-context.js";
import { handleWhatsappRoutes } from "./whatsapp.js";
import { handleTelegramRoutes } from "./telegram.js";
import { handleSyncRoutes } from "./sync.js";
import { handleProtocolRoutes } from "./protocols.js";
import { handleCronRoutes } from "./cron.js";
import { handleVoiceCloneRoutes } from "./voice-clones.js";
import { handleSecretsRoutes } from "./secrets.js";
import { handleIntegrationsRoutes } from "./integrations.js";
import { handleAuthRoutes } from "./auth.js";

const handlers: RouteHandler[] = [
  handleWhatsappRoutes,
  handleTelegramRoutes,
  handleSyncRoutes,
  handleProtocolRoutes,
  handleCronRoutes,
  handleVoiceCloneRoutes,
  handleSecretsRoutes,
  handleIntegrationsRoutes,
  handleAuthRoutes,
];

export const handleBridgeRoutes: RouteHandler = async (method, url, req, res, ctx, role) => {
  for (const h of handlers) {
    if (await h(method, url, req, res, ctx, role)) return true;
  }
  return false;
};
