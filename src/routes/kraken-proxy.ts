import type { RouteHandler } from "../server-context.js";
import { jsonResponse, safeParseBody, safeErrorMessage } from "../server-utils.js";
import { createLogger } from "../logger.js";

const logger = createLogger("routes.kraken-proxy");
const KRAKEN_BASE = "https://api.kraken.com";
const TIMEOUT_MS = 15000;

const PUBLIC_ENDPOINTS = new Set([
  "Time", "SystemStatus", "Assets", "AssetPairs",
  "Ticker", "OHLC", "Depth", "Trades", "Spread",
]);
const PRIVATE_ENDPOINTS = new Set([
  "Balance", "TradeBalance", "OpenOrders", "ClosedOrders", "QueryOrders",
  "TradesHistory", "QueryTrades", "OpenPositions", "Ledgers", "QueryLedgers",
  "TradeVolume", "AddOrder", "CancelOrder", "CancelAll", "GetWebSocketsToken",
]);

async function forwardWithTimeout(u: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try { return await fetch(u, { ...init, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

export const handleKrakenProxyRoutes: RouteHandler = async (method, url, req, res) => {
  const json = (s: number, d: unknown) => jsonResponse(res, s, d, req);

  if (method === "GET" && url.pathname.startsWith("/api/kraken/public/")) {
    const ep = url.pathname.slice("/api/kraken/public/".length);
    if (!/^[A-Za-z]+$/.test(ep) || !PUBLIC_ENDPOINTS.has(ep)) {
      json(400, { error: "Unsupported public endpoint: " + ep });
      return true;
    }
    try {
      const up = await forwardWithTimeout(KRAKEN_BASE + "/0/public/" + ep + (url.search || ""), { method: "GET" });
      const body = await up.text();
      res.writeHead(up.status, { "Content-Type": "application/json" });
      res.end(body);
    } catch (e) {
      logger.warn("[kraken.public] " + ep + " failed: " + safeErrorMessage(e));
      json(502, { error: { upstream: safeErrorMessage(e) } });
    }
    return true;
  }

  if (method === "POST" && url.pathname.startsWith("/api/kraken/private/")) {
    const ep = url.pathname.slice("/api/kraken/private/".length);
    if (!/^[A-Za-z]+$/.test(ep) || !PRIVATE_ENDPOINTS.has(ep)) {
      json(400, { error: "Unsupported private endpoint: " + ep });
      return true;
    }
    const body = await safeParseBody(req);
    if (!body) { json(400, { error: "Invalid JSON body" }); return true; }
    const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
    const apiSign = typeof body.apiSign === "string" ? body.apiSign : "";
    const postBody = typeof body.postBody === "string" ? body.postBody : "";
    if (!apiKey) { json(400, { error: "apiKey required" }); return true; }
    if (!apiSign) { json(400, { error: "apiSign required" }); return true; }
    if (!postBody) { json(400, { error: "postBody required" }); return true; }
    try {
      const up = await forwardWithTimeout(KRAKEN_BASE + "/0/private/" + ep, {
        method: "POST",
        headers: {
          "API-Key": apiKey,
          "API-Sign": apiSign,
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "OpenAgentX-KrakenProxy/1.0",
        },
        body: postBody,
      });
      const rb = await up.text();
      res.writeHead(up.status, { "Content-Type": "application/json" });
      res.end(rb);
    } catch (e) {
      logger.warn("[kraken.private] " + ep + " failed: " + safeErrorMessage(e));
      json(502, { error: { upstream: safeErrorMessage(e) } });
    }
    return true;
  }

  return false;
};
