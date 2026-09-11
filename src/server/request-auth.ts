import type { IncomingMessage, ServerResponse } from "node:http";
import { authorizeAppConnectorHttp } from "./app-connector-auth.js";
import { corsHeaders, isLoopbackOrigin, isLoopbackAddress, checkRateLimit, getRateLimitKey, recordAuthFailure, getAuthFloodGuard, jsonResponse } from "../server-utils.js";
import type { LAXConfig } from "../types.js";
import type { RBACManager, Role } from "../rbac.js";

const AUTH_EXEMPT = new Set(["/api/auth/status", "/api/auth/anthropic/status", "/api/auth/xai/status", "/api/health"]);
const BROWSER_OPENABLE_GET_API = /^\/api\/cron\/[^/]+\/reports\/latest$/;

export interface RequestAuthorization {
  handled: boolean;
  role: Role;
}

export function authorizeRequest(
  method: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  config: LAXConfig,
  rbac: RBACManager,
): RequestAuthorization {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);
  if (method === "OPTIONS") {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return { handled: true, role: "operator" };
  }
  if (url.pathname.startsWith("/api/") && method !== "GET") {
    if (req.headers["sec-fetch-site"] === "cross-site") {
      json(403, { error: "Cross-origin mutation blocked" });
      return { handled: true, role: "operator" };
    }
    if (req.headers.origin && !isLoopbackOrigin(req.headers.origin)) {
      json(403, { error: "Cross-origin request blocked" });
      return { handled: true, role: "operator" };
    }
  }
  const clientIp = req.socket.remoteAddress || "unknown";
  // Loopback clients (127.0.0.0/8, ::1) bypass throttling entirely — see the
  // rationale on isLoopbackAddress. Skipping BOTH the token bucket and the
  // flood guard prevents cold-boot cascades where the UI fires ~20 bootstrap
  // fetches in parallel and gets 429'd on all of them, breaking the whole app
  // until the buckets refill (~15 min for the flood-guard lockout).
  const trustedLocal = isLoopbackAddress(clientIp);

  if (!trustedLocal && url.pathname.startsWith("/api/") && !checkRateLimit(getRateLimitKey(req))) {
    json(429, { error: "Rate limit exceeded." });
    return { handled: true, role: "operator" };
  }
  if (!url.pathname.startsWith("/api/") || AUTH_EXEMPT.has(url.pathname)) {
    return { handled: false, role: "operator" };
  }

  const authorization = req.headers.authorization || "";
  const headerToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const queryToken = method === "GET" && BROWSER_OPENABLE_GET_API.test(url.pathname)
    ? (url.searchParams.get("token") || "")
    : "";
  const token = headerToken || queryToken;
  if (!trustedLocal) {
    const lockout = getAuthFloodGuard().get(clientIp);
    if (lockout && lockout.lockedUntil > Date.now()) {
      res.writeHead(429, {
        ...corsHeaders(req),
        "Retry-After": String(Math.ceil((lockout.lockedUntil - Date.now()) / 1000)),
      });
      res.end(JSON.stringify({ error: "Too many failed attempts." }));
      return { handled: true, role: "operator" };
    }
  }
  if (!token) {
    json(401, { error: "Unauthorized" });
    return { handled: true, role: "operator" };
  }

  const authResult = rbac.authenticate(token);
  if (!authResult.valid || !authResult.entry) {
    if (authorizeAppConnectorHttp(token, url.pathname, config.authToken)) {
      getAuthFloodGuard().delete(clientIp);
      return { handled: false, role: "user" };
    }
    if (!trustedLocal) recordAuthFailure(clientIp);
    json(401, { error: "Unauthorized" });
    return { handled: true, role: "operator" };
  }

  getAuthFloodGuard().delete(clientIp);
  const role = authResult.entry.role;
  const endpoint = rbac.checkEndpoint(role, method, url.pathname);
  if (!endpoint.allowed) {
    json(403, { error: endpoint.reason });
    return { handled: true, role };
  }
  return { handled: false, role };
}
