import type { RouteHandler } from "../../../server-context.js";
import { jsonResponse } from "../../../server-utils.js";
import { isStrictLocalOnly } from "../../../security/egress-policy.js";
import { handleCoreAuthRoutes } from "./core-openai.js";
import { handleAnthropicAuthRoutes } from "./anthropic.js";
import { handleXaiAuthRoutes } from "./xai.js";

const handlers: RouteHandler[] = [
  handleCoreAuthRoutes,
  handleAnthropicAuthRoutes,
  handleXaiAuthRoutes,
];

// Cloud sign-in INITIATION routes across the three provider handlers. Refused
// with 403 while strictLocalOnly is on — a cloud OAuth handshake is non-local
// egress by definition. Status / logout / cancel / install-cli stay available
// so the UI can still report state and tear down an in-flight login.
const CLOUD_LOGIN_PATHS: ReadonlySet<string> = new Set([
  "/api/auth/login",
  "/api/auth/openai/cli-login",
  "/api/auth/anthropic/setup-token",
  "/api/auth/anthropic/cli-login",
  "/api/auth/anthropic/cli-login-submit",
  "/api/auth/xai/login",
  "/api/auth/xai/exchange-code",
  "/api/auth/xai/cli-login",
]);

/** The 403 refusal message for a cloud sign-in route under strictLocalOnly, or
 *  null when the request is not a refused login initiation. Pure decision —
 *  exported so the guard is testable without a fake HTTP round-trip. */
export function strictLocalOnlyLoginRefusal(method: string, pathname: string): string | null {
  if (method !== "POST" || !CLOUD_LOGIN_PATHS.has(pathname)) return null;
  if (!isStrictLocalOnly()) return null;
  return "strictLocalOnly is enabled in config.json — cloud provider sign-in is disabled. Disable strictLocalOnly to connect a cloud provider.";
}

export const handleAuthRoutes: RouteHandler = async (method, url, req, res, ctx, role) => {
  const refusal = strictLocalOnlyLoginRefusal(method, url.pathname);
  if (refusal) {
    jsonResponse(res, 403, { error: refusal }, req);
    return true;
  }
  for (const h of handlers) {
    if (await h(method, url, req, res, ctx, role)) return true;
  }
  return false;
};
