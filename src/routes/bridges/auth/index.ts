import type { RouteHandler } from "../../../server-context.js";
import { handleCoreAuthRoutes } from "./core-openai.js";
import { handleAnthropicAuthRoutes } from "./anthropic.js";
import { handleXaiAuthRoutes } from "./xai.js";

const handlers: RouteHandler[] = [
  handleCoreAuthRoutes,
  handleAnthropicAuthRoutes,
  handleXaiAuthRoutes,
];

export const handleAuthRoutes: RouteHandler = async (method, url, req, res, ctx, role) => {
  for (const h of handlers) {
    if (await h(method, url, req, res, ctx, role)) return true;
  }
  return false;
};
