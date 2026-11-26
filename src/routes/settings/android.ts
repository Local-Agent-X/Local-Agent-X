/**
 * Android SDK setup — status + install trigger for the Settings "Set up
 * Android SDK" card. installAndroidSdk() itself lives in src/android/
 * (the one place this logic runs); this route is a thin HTTP front end,
 * mirroring the local-runtimes card's status+action shape.
 */

import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, readBody } from "../../server-utils.js";
import { checkAndroidSdk, installAndroidSdk, listDevices, startEmulator, stopEmulator, keyEvent, deviceHolder, releaseDevice, watchDevice } from "../../android/index.js";

interface InstallState {
  running: boolean;
  lastStep: string | null;
  error: string | null;
  completedAt: number | null;
}

const state: InstallState = { running: false, lastStep: null, error: null, completedAt: null };

export const handleAndroidRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
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

  // Below: device control for the ANDROID sidebar tab (public/js/android-tab.js).
  // Same startEmulator/stopEmulator/listDevices the agent's `android` tool calls —
  // the UI's Start/Stop button is just another caller, not a parallel path.

  // Each device with the chat whose agent is driving it, if one is
  // (android/device-hold.ts), so the tab can say whose it is. `view` is the
  // device the open tab is showing: asking keeps its feed running
  // (android/frame-stream.ts), so a phone that was plugged in before the app
  // started shows without the agent touching it.
  if (method === "GET" && url.pathname === "/api/android/devices") {
    const titles = new Map(ctx.sessionStore.list().map((s) => [s.id, s.title]));
    const connected = await listDevices();
    const view = url.searchParams.get("view");
    if (view && connected.some((d) => d.serial === view && d.state === "device")) watchDevice(view);
    const devices = connected.map((device) => {
      const sessionId = deviceHolder(device.serial);
      return sessionId ? { ...device, heldBy: { sessionId, title: titles.get(sessionId) || "another chat" } } : device;
    });
    json(200, { devices });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/android/emulator/start") {
    const body = JSON.parse((await readBody(req)) || "{}") as { avdName?: string };
    try {
      const { serial } = await startEmulator(body.avdName || "lax_default");
      json(200, { ok: true, serial });
    } catch (e) {
      json(500, { ok: false, error: (e as Error).message });
    }
    return true;
  }

  if (method === "POST" && url.pathname === "/api/android/emulator/stop") {
    const body = JSON.parse((await readBody(req)) || "{}") as { serial?: string };
    if (!body.serial) { json(400, { ok: false, error: "serial is required" }); return true; }
    await stopEmulator(body.serial);
    releaseDevice(body.serial);
    json(200, { ok: true });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/android/key") {
    const body = JSON.parse((await readBody(req)) || "{}") as { serial?: string; key?: string };
    if (!body.serial || !body.key) { json(400, { ok: false, error: "serial and key are required" }); return true; }
    try {
      await keyEvent(body.serial, body.key);
      json(200, { ok: true });
    } catch (e) {
      json(400, { ok: false, error: (e as Error).message });
    }
    return true;
  }

  return false;
};
