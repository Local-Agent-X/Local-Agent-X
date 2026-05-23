import type { RouteHandler } from "../../server-context.js";
import { handleAgentHistoryRoutes } from "./history.js";
import { handleAgentTemplateRoutes } from "./templates.js";
import { handleRosterRoutes } from "./rosters.js";
import { handleInfraRoutes } from "./infra.js";
import { handleProjectRoutes } from "./projects.js";
import { handleChatStatusRoutes } from "./chats.js";

const SUB_HANDLERS: RouteHandler[] = [
  handleAgentHistoryRoutes,
  handleAgentTemplateRoutes,
  handleRosterRoutes,
  handleInfraRoutes,
  handleProjectRoutes,
  handleChatStatusRoutes,
];

export const handleAgentRoutes: RouteHandler = async (method, url, req, res, ctx, role) => {
  for (const h of SUB_HANDLERS) {
    if (await h(method, url, req, res, ctx, role)) return true;
  }
  return false;
};
