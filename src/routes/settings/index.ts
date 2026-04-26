import type { RouteHandler } from "../../server-context.js";
import { handleSystemRoutes } from "./system.js";
import { handleDiagnosticsRoutes } from "./diagnostics.js";
import { handlePluginsRoutes } from "./plugins.js";
import { handlePreferencesRoutes } from "./preferences.js";
import { handleProvidersRoutes } from "./providers.js";
import { handleSecurityRoutes } from "./security.js";
import { handleMoodRoutes } from "./mood.js";

const handlers: RouteHandler[] = [
  handleSystemRoutes,
  handleDiagnosticsRoutes,
  handlePluginsRoutes,
  handlePreferencesRoutes,
  handleProvidersRoutes,
  handleSecurityRoutes,
  handleMoodRoutes,
];

export const handleSettingsRoutes: RouteHandler = async (method, url, req, res, ctx, role) => {
  for (const h of handlers) {
    if (await h(method, url, req, res, ctx, role)) return true;
  }
  return false;
};
