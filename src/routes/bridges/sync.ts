import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, safeParseBody } from "../../server-utils.js";
import type { AgentSync } from "../../sync/index.js";
import { createDeviceSync, type DeviceSync, type DeviceSyncAction } from "../../sync/device-sync.js";
import {
  MEMORY_SYNC_PATH, MEMORY_SYNC_PULL_PATH, MEMORY_SYNC_PUSH_PATH, MEMORY_SYNC_RUN_PATH,
} from "../../broker-transport/vendor/memory-sync.js";

/** The phone's buttons (sync/device-sync.ts), one per AgentSync. */
const deviceSyncs = new WeakMap<AgentSync, DeviceSync>();
const deviceSyncOf = (agentSync: AgentSync): DeviceSync => {
  let d = deviceSyncs.get(agentSync);
  if (!d) deviceSyncs.set(agentSync, d = createDeviceSync(agentSync));
  return d;
};
const DEVICE_ACTIONS: Record<string, DeviceSyncAction> = {
  [MEMORY_SYNC_RUN_PATH]: "sync", [MEMORY_SYNC_PULL_PATH]: "pull", [MEMORY_SYNC_PUSH_PATH]: "push",
};

export const handleSyncRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  if (method === "GET" && url.pathname === MEMORY_SYNC_PATH) {
    json(200, deviceSyncOf(ctx.agentSync).status()); return true;
  }
  const action = method === "POST" ? DEVICE_ACTIONS[url.pathname] : undefined;
  if (action) {
    json(200, deviceSyncOf(ctx.agentSync).run(action)); return true;
  }

  if (method === "GET" && url.pathname === "/api/sync/status") {
    json(200, ctx.agentSync.getStatus()); return true;
  }
  if (method === "POST" && url.pathname === "/api/sync/configure") {
    const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
    ctx.agentSync.saveConfig(body);
    ctx.agentSync.stopHeartbeat();
    ctx.agentSync.startHeartbeat();
    json(200, { ok: true }); return true;
  }
  if (method === "POST" && url.pathname === "/api/sync/push") {
    json(200, await ctx.agentSync.push()); return true;
  }
  if (method === "POST" && url.pathname === "/api/sync/pull") {
    json(200, await ctx.agentSync.pull()); return true;
  }

  return false;
};
