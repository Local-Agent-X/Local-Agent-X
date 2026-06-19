// Bridge pairing + device-management routes (mirrors the sibling bridge routes).
//
//   POST /api/bridge/pair/issue   (operator) → { tailnetAddr, pairingSecret, expiresAt, qrPayload }
//   POST /api/bridge/pair/claim   (no token; secret IS the credential)
//                                  body { pairingSecret, deviceLabel }
//                                  → { deviceToken (once), device }  | 409 on reuse/expiry
//   GET  /api/bridge/devices      (operator) → device list (no token hashes)
//   POST /api/bridge/devices/:id/revoke (operator) → { revoked, closedSockets }
//   GET  /api/bridge/status       (operator; works when disabled) → { enabled, envForced }
//   POST /api/bridge/enabled      (operator) body { enabled } → { enabled, restartRequired }
//
// The auth gate (request-handler.ts) protects issue/devices with the operator
// token and exempts /api/bridge/pair/claim — the one-shot pairing secret is the
// credential there. claim never returns the token more than once.

import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, safeParseBody } from "../../server-utils.js";
import { issueChallenge, claim } from "../../bridge/pairing.js";
import { resolveBridgeBindAddr } from "../../bridge/tailnet.js";
import { loadBridgeConfig, isBridgeEnabled, isBridgeUiEnvFlag, resolveBridgeUiVisible, BRIDGE_ENABLED_SETTING } from "../../bridge/config.js";
import { getDeviceRegistry } from "../../bridge/device-registry.js";
import { revokeDevice } from "../../bridge/index.js";
import { encodePairQrPayload } from "../../bridge/pair-payload.js";
import { getSetting, setSetting } from "../../settings.js";

export const handlePairingRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  if (!url.pathname.startsWith("/api/bridge/")) return false;
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  // Discoverability for the desktop Mobile panel: works whether or not the
  // bridge is enabled so the UI can decide between the toggle/panel and a
  // "restart to apply" hint. Operator-authed like the rest (the gate is in
  // request-handler.ts), but must answer BEFORE the disabled short-circuit.
  //   enabled    — live effective state (drives whether the QR/devices panel shows)
  //   persisted  — the saved bridge.enabled flag (drives the toggle position)
  //   envForced  — true when LAX_BRIDGE_ENABLED pins it on regardless of the toggle
  if (method === "GET" && url.pathname === "/api/bridge/status") {
    const envForced = process.env.LAX_BRIDGE_ENABLED === "1" || process.env.LAX_BRIDGE_ENABLED === "true";
    const persisted = getSetting<boolean>(BRIDGE_ENABLED_SETTING) === true;
    const enabled = isBridgeEnabled();
    // Only resolve the tailnet addr when enabled — lets the UI distinguish
    // "bridge on and bound" from "bridge on but Tailscale is down" without a
    // pair attempt. Never reveal the address itself here (operator-only panel
    // gets it via pair/issue); just whether one exists.
    const hasTailnet = enabled ? resolveBridgeBindAddr(loadBridgeConfig().bindAddrOverride) !== null : false;
    // Whether the desktop Mobile settings tab should be shown at all. Unreleased
    // feature → hidden for everyone; revealed ONLY by the LAX_BRIDGE_UI dev flag.
    const uiVisible = resolveBridgeUiVisible(isBridgeUiEnvFlag());
    json(200, { enabled, persisted, envForced, hasTailnet, uiVisible, envVar: "LAX_BRIDGE_ENABLED" }); return true;
  }

  // Toggle the persisted flag. The bind happens at startup, so flipping this
  // takes effect on the next restart — say so explicitly. Operator-authed (the
  // request-handler gate already required the operator token to get here). When
  // the env override pins it on, persist the flag anyway but report that a
  // restart alone won't change the effective state until the env var is cleared.
  if (method === "POST" && url.pathname === "/api/bridge/enabled") {
    const body = await safeParseBody(req);
    if (!body || typeof body.enabled !== "boolean") { json(400, { error: "enabled (boolean) required" }); return true; }
    setSetting(BRIDGE_ENABLED_SETTING, body.enabled);
    const envForced = process.env.LAX_BRIDGE_ENABLED === "1" || process.env.LAX_BRIDGE_ENABLED === "true";
    json(200, { enabled: body.enabled, restartRequired: true, envForced }); return true;
  }

  // Every bridge route is inert unless the bridge is enabled — surface that
  // clearly rather than minting tokens that can never be used.
  if (!isBridgeEnabled()) { json(409, { error: "Mobile bridge is off. Turn it on in Settings → Mobile and restart." }); return true; }

  if (method === "POST" && url.pathname === "/api/bridge/pair/issue") {
    const addr = resolveBridgeBindAddr(loadBridgeConfig().bindAddrOverride);
    if (!addr) { json(409, { error: "No Tailscale interface found. Bring Tailscale up or set LAX_BRIDGE_BIND_ADDR." }); return true; }
    const challenge = issueChallenge(`${addr}:${ctx.config.port}`);
    // `qrPayload` is the EXACT string the desktop encodes into the QR and the
    // mobile parser reads — server-authoritative so the two can't drift.
    json(200, { ...challenge, qrPayload: encodePairQrPayload(challenge) }); return true;
  }

  if (method === "POST" && url.pathname === "/api/bridge/pair/claim") {
    const body = await safeParseBody(req);
    if (!body || typeof body.pairingSecret !== "string" || !body.pairingSecret) {
      json(400, { error: "pairingSecret required" }); return true;
    }
    const label = typeof body.deviceLabel === "string" ? body.deviceLabel : "";
    const result = claim(body.pairingSecret, label);
    if (!result.ok) { json(409, { error: result.reason }); return true; }
    json(200, { deviceToken: result.deviceToken, device: result.device }); return true;
  }

  if (method === "GET" && url.pathname === "/api/bridge/devices") {
    json(200, getDeviceRegistry().list()); return true;
  }

  const revokeMatch = url.pathname.match(/^\/api\/bridge\/devices\/([a-zA-Z0-9_-]+)\/revoke$/);
  if (method === "POST" && revokeMatch) {
    const id = revokeMatch[1];
    if (!getDeviceRegistry().get(id)) { json(404, { error: "Device not found" }); return true; }
    const result = revokeDevice(id);
    json(200, result); return true;
  }

  return false;
};
