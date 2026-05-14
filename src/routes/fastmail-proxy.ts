import type { IncomingMessage } from "node:http";
import type { RouteHandler } from "../server-context.js";
import { jsonResponse, safeErrorMessage } from "../server-utils.js";
import { getSecretsStoreSingleton } from "../secrets.js";
import { createLogger } from "../logger.js";

const logger = createLogger("routes.fastmail-proxy");
const FASTMAIL_SESSION_URL = "https://api.fastmail.com/jmap/session";
const TIMEOUT_MS = 20000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

async function forwardWithTimeout(u: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try { return await fetch(u, { ...init, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

async function readRawBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export const handleFastmailProxyRoutes: RouteHandler = async (method, url, req, res) => {
  if (!url.pathname.startsWith("/api/fastmail/")) return false;

  const json = (s: number, d: unknown) => jsonResponse(res, s, d, req);
  const token = getSecretsStoreSingleton()?.get("FASTMAIL");
  if (!token) {
    json(401, { error: "FASTMAIL secret not configured in vault." });
    return true;
  }

  if (method === "GET" && url.pathname === "/api/fastmail/session") {
    try {
      const up = await forwardWithTimeout(FASTMAIL_SESSION_URL, {
        method: "GET",
        headers: { "Authorization": "Bearer " + token, "Accept": "application/json" },
      });
      const body = await up.text();
      res.writeHead(up.status, { "Content-Type": "application/json" });
      res.end(body);
    } catch (e) {
      logger.warn("[fastmail.session] failed: " + safeErrorMessage(e));
      json(502, { error: { upstream: safeErrorMessage(e) } });
    }
    return true;
  }

  if (method === "POST" && url.pathname === "/api/fastmail/jmap") {
    const raw = await readRawBody(req);
    if (raw === null) { json(413, { error: "Request body exceeds 2MB limit." }); return true; }
    try {
      const sessionRes = await forwardWithTimeout(FASTMAIL_SESSION_URL, {
        method: "GET",
        headers: { "Authorization": "Bearer " + token, "Accept": "application/json" },
      });
      if (!sessionRes.ok) {
        const sb = await sessionRes.text();
        res.writeHead(sessionRes.status, { "Content-Type": "application/json" });
        res.end(sb);
        return true;
      }
      const session = await sessionRes.json() as { apiUrl?: unknown };
      const apiUrl = typeof session.apiUrl === "string" ? session.apiUrl : "";
      if (!apiUrl) { json(502, { error: "Fastmail session response missing apiUrl." }); return true; }
      const up = await forwardWithTimeout(apiUrl, {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + token,
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: raw,
      });
      const body = await up.text();
      res.writeHead(up.status, { "Content-Type": "application/json" });
      res.end(body);
    } catch (e) {
      logger.warn("[fastmail.jmap] failed: " + safeErrorMessage(e));
      json(502, { error: { upstream: safeErrorMessage(e) } });
    }
    return true;
  }

  return false;
};
