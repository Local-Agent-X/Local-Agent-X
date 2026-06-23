// Capability token an embedded app uses to reach the connector proxy — and
// nothing else.
//
// A served app is a LOWER-TRUST principal than the operator: it's AI/user
// generated, pulls unvetted dependencies, and renders remote data. So the app
// HTML strips the operator token (see request-handler.ts). Without a narrow
// capability it therefore can't reach /api/connectors at all. This mints one,
// one-way derived from the operator token, that the gate admits ONLY for
// /api/connectors/*. Same shape as authorizeDeviceHttp (bridge/upgrade-auth.ts):
// a narrow principal for a narrow path set, never the operator surface.

import { createHmac, timingSafeEqual } from "node:crypto";

const CONNECTOR_PREFIX = "/api/connectors/";
const CAP_LABEL = "lax-app-connector-capability:v1";

/**
 * This server's connector capability, derived one-way from the operator token.
 * Rotates with the operator token and can't be reversed into operator access;
 * a distinct value from the operator token, so it's safe to embed in served app
 * HTML without granting the broader /api surface.
 */
export function deriveConnectorCapability(operatorToken: string): string {
  return createHmac("sha256", operatorToken).update(CAP_LABEL).digest("hex");
}

/**
 * Authorize an app's connector capability for an HTTP request — mirrors
 * authorizeDeviceHttp. Admits iff the path is under /api/connectors/ AND the
 * token is this server's capability. Constant-time; never reveals which half
 * failed. This grants "reach the connector surface", not "reach any connector
 * unchecked" — the connector proxy still enforces its per-manifest allow list.
 */
export function authorizeAppConnectorHttp(token: string, pathname: string, operatorToken: string): boolean {
  if (!token || !operatorToken) return false;
  if (!pathname.startsWith(CONNECTOR_PREFIX)) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(deriveConnectorCapability(operatorToken));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
