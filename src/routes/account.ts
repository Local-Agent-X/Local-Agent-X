// /api/account/* — the thin HTTP surface the in-app account page (public/account.html)
// drives to set up the agentxos account: device-code login, then QR pairing. The real
// orchestration runs in the AccountManager (broker-transport/account); these routes
// just trigger its background flows and report status. Operator-token gated by the
// request handler (like every /api/* route), so only the local user can set this up.
//
// The flows are fire-and-forget triggers (202) whose progress the page reads by polling
// GET /api/account/status — the in-flight login prompt + pairing QR live in the manager.
// The runtime module is lazy-imported so the account/broker code stays off the boot graph.

import type { RouteHandler } from "../server-context.js";
import { jsonResponse } from "../server-utils.js";

export const handleAccountRoutes: RouteHandler = async (method, url, req, res) => {
  if (!url.pathname.startsWith("/api/account/")) return false;

  const { getAccountManager, stopBrokerPresence } = await import("../broker-transport/account/runtime.js");
  const manager = getAccountManager();

  if (method === "GET" && url.pathname === "/api/account/status") {
    jsonResponse(res, 200, manager.status(), req);
    return true;
  }
  if (method === "POST" && url.pathname === "/api/account/login/start") {
    void manager.startLogin(); // background; page polls status for the code
    jsonResponse(res, 202, { ok: true }, req);
    return true;
  }
  if (method === "POST" && url.pathname === "/api/account/pair/start") {
    void manager.startPairing(); // background; page polls status for the QR
    jsonResponse(res, 202, { ok: true }, req);
    return true;
  }
  if (method === "POST" && url.pathname === "/api/account/signout") {
    manager.signOut();
    stopBrokerPresence();
    jsonResponse(res, 200, { ok: true }, req);
    return true;
  }

  return false;
};
