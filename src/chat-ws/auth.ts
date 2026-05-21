// WebSocket auth — token via query param OR Sec-WebSocket-Protocol
// subprotocol. Accept legacy "sax-auth" too so cached old chat.js
// sessions still connect across the rebrand.

import type { IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";

export function extractAuthToken(req: IncomingMessage): string {
  const url = new URL(req.url || "/", "http://localhost");
  const queryToken = url.searchParams.get("token") || "";
  if (queryToken) return queryToken;

  const protocols = req.headers["sec-websocket-protocol"] || "";
  const parts = protocols.split(",").map(s => s.trim());
  let authIdx = parts.indexOf("lax-auth");
  if (authIdx < 0) authIdx = parts.indexOf("sax-auth");
  if (authIdx >= 0 && parts[authIdx + 1]) {
    return parts[authIdx + 1];
  }
  return "";
}

export function verifyToken(token: string, authToken: string): boolean {
  const tokenBuf = Buffer.from(token);
  const authBuf = Buffer.from(authToken);
  if (tokenBuf.length !== authBuf.length) return false;
  return timingSafeEqual(tokenBuf, authBuf);
}
