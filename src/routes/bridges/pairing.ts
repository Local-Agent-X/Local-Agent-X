// Bridge pairing + device-management routes (mirrors the sibling bridge routes).
//
//   POST /api/bridge/pair/issue   (operator) → { tailnetAddr, pairingSecret, expiresAt }
//   POST /api/bridge/pair/claim   (no token; secret IS the credential)
//                                  body { pairingSecret, deviceLabel }
//                                  → { deviceToken (once), device }  | 409 on reuse/expiry
//   GET  /api/bridge/devices      (operator) → device list (no token hashes)
//   POST /api/bridge/devices/:id/revoke (operator) → { revoked, closedSockets }
//
// The auth gate (request-handler.ts) protects issue/devices with the operator
// token and exempts /api/bridge/pair/claim — the one-shot pairing secret is the
// credential there. claim never returns the token more than once.

import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, safeParseBody } from "../../server-utils.js";
import { issueChallenge, claim } from "../../bridge/pairing.js";
import { resolveBridgeBindAddr } from "../../bridge/tailnet.js";
import { loadBridgeConfig, isBridgeEnabled } from "../../bridge/config.js";
import { getDeviceRegistry } from "../../bridge/device-registry.js";
import { revokeDevice } from "../../bridge/index.js";

export const handlePairingRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  if (!url.pathname.startsWith("/api/bridge/")) return false;
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  // Every bridge route is inert unless the bridge is enabled — surface that
  // clearly rather than minting tokens that can never be used.
  if (!isBridgeEnabled()) { json(409, { error: "Bridge disabled. Set LAX_BRIDGE_ENABLED=1 and restart." }); return true; }

  if (method === "POST" && url.pathname === "/api/bridge/pair/issue") {
    const addr = resolveBridgeBindAddr(loadBridgeConfig().bindAddrOverride);
    if (!addr) { json(409, { error: "No Tailscale interface found. Bring Tailscale up or set LAX_BRIDGE_BIND_ADDR." }); return true; }
    const challenge = issueChallenge(`${addr}:${ctx.config.port}`);
    json(200, challenge); return true;
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
