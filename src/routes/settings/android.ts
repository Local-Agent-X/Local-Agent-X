/**
 * Android SDK setup — status + install trigger for the Settings "Set up
 * Android SDK" card. installAndroidSdk() itself lives in src/android/
 * (the one place this logic runs); this route is a thin HTTP front end,
 * mirroring the local-runtimes card's status+action shape.
 */

import type { RouteHandler } from "../../server-context.js";
import { jsonResponse } from "../../server-utils.js";
import { checkAndroidSdk, installAndroidSdk } from "../../android/index.js";

interface InstallState {
  running: boolean;
  lastStep: string | null;
  error: string | null;
  completedAt: number | null;
}

const state: InstallState = { running: false, lastStep: null, error: null, completedAt: null };

export const handleAndroidRoutes: RouteHandler = async (method, url, req, res, _ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  if (method === "GET" && url.pathname === "/api/android/sdk/status") {
    json(200, { ...checkAndroidSdk(), install: state });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/android/sdk/install") {
    if (state.running) { json(409, { ok: false, error: "Install already in progress." }); return true; }
    state.running = true;
    state.error = null;
    state.completedAt = null;
    state.lastStep = "Starting...";
    // Fire-and-forget: this can take several minutes (large downloads), so the
    // response returns immediately and the UI polls GET .../status for progress.
    void installAndroidSdk((step) => { state.lastStep = step; })
      .then(() => { state.completedAt = Date.now(); })
      .catch((e) => { state.error = (e as Error).message; })
      .finally(() => { state.running = false; });
    json(202, { ok: true, started: true });
    return true;
  }

  return false;
};
