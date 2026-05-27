/**
 * App Agent Tools — aggregator.
 *
 * The 10 tool definitions live in src/app-tools/:
 *   lifecycle.ts — create, update, list, delete, permissions
 *   runtime.ts   — read, action, query
 *   sidebar.ts   — pin, unpin
 *   shared.ts    — actor / ok / err / port helpers
 *
 * Security model (enforced inside each tool's execute):
 * - All operations check permissions via AppRegistry.checkAccess()
 * - Input validation on all mutations
 * - Audit trail for every operation
 * - Rate limiting on state/event operations
 */

import type { ToolDefinition } from "./types.js";
import { appCreate, appUpdate, appList, appDelete, appPermissions } from "./app-tools/lifecycle.js";
import { appRead, appAction, appQuery } from "./app-tools/runtime.js";
import { sidebarPin, sidebarUnpin, sidebarClear } from "./app-tools/sidebar.js";

export const appTools: ToolDefinition[] = [
  appCreate,
  appUpdate,
  appRead,
  appAction,
  appQuery,
  appList,
  appDelete,
  appPermissions,
  sidebarPin,
  sidebarUnpin,
  sidebarClear,
];
