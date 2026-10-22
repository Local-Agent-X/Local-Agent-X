/**
 * Which session a request through the loopback proxy belongs to, and the
 * send-time judgement on what the proxy can see of it
 * (docs/proposals/egress-consolidation.md, phase 5).
 *
 * A caged shell's proxy URL carries a per-session ticket as its user name and
 * the proxy instance's token as its password. The token still authenticates
 * the route; the ticket only names the session, and it is unguessable, so a
 * process cannot pass itself off as another session to dodge that session's
 * taint. The plain user name is the session-less credential: a long-lived MCP
 * server is shared by every session and is judged on stored secrets only.
 *
 * What is judged: a plain-HTTP request's URL and the head of its body, and a
 * CONNECT's destination (a canary or a secret spelled into a hostname). An
 * HTTPS body is inside the tunnel and stays out of reach here.
 */
import { randomBytes } from "node:crypto";
import { PROXY_AUTH_USER } from "./egress-proxy-core.js";
import { EgressPayloadBlocked, judgeSendText } from "./egress-send.js";
import { REQUEST_BODY_HEAD_CAP } from "./request-body-head.js";

const TICKET_PREFIX = "s.";
const ticketToSession = new Map<string, string>();
const sessionToTicket = new Map<string, string>();

/** The proxy user name for a session: its ticket, issued on first use. */
export function proxyUserForSession(sessionId: string | null): string {
  if (!sessionId) return PROXY_AUTH_USER;
  let ticket = sessionToTicket.get(sessionId);
  if (!ticket) {
    ticket = `${TICKET_PREFIX}${randomBytes(12).toString("hex")}`;
    sessionToTicket.set(sessionId, ticket);
    ticketToSession.set(ticket, sessionId);
  }
  return ticket;
}

/** The session a proxy user name was issued to; "" for the plain user and for
 *  a ticket this process never issued. */
export function sessionOfProxyUser(user: string): string {
  return ticketToSession.get(user) ?? "";
}

/** The proxy URL with the session's ticket as its user name. */
export function proxyUrlForSession(url: string, sessionId: string | null): string {
  if (!sessionId) return url;
  const u = new URL(url);
  if (!u.password) return url;
  u.username = proxyUserForSession(sessionId);
  return u.href.replace(/\/$/, "");
}

/** The refusal reason for a proxied request, or null when it may go. */
export function inspectProxyRequest(user: string, target: URL, bodyHead: Buffer | null): string | null {
  const text = bodyHead ? `${target.href}\n${bodyHead.subarray(0, REQUEST_BODY_HEAD_CAP).toString("utf8")}` : target.href;
  try {
    judgeSendText(sessionOfProxyUser(user), text, `the request to ${target.host}`);
    return null;
  } catch (e) {
    if (e instanceof EgressPayloadBlocked) return e.message;
    throw e;
  }
}
