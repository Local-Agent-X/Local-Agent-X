// The user's connected calendars over HTTP (Settings → General → Watching for you).
//
// GET  /api/calendars             → { calendars: [{ id, kind, label, username?, host?, addedAt }] }
// POST /api/calendars/connect     { kind: "ics", label, url } | { kind: "caldav", label, url, username, password }
// POST /api/calendars/disconnect  { id }
//
// Connecting puts a credential in the vault (an iCal link is one) and points
// LAX at a server that will be sent it, so only the user does it: the agent
// principal is refused, as for the inbox. Every change broadcasts
// settings_changed { calendars: true } so open Settings pages redraw.

import type { RouteHandler } from "../server-context.js";
import { jsonResponse, safeParseBody } from "../server-utils.js";
import { connectCalendar, connectedView, disconnectCalendar, listConnected, type ConnectRequest } from "../calendar/connectors/store.js";

function requestOf(body: Record<string, unknown>): ConnectRequest | null {
  const s = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : "");
  if (body.kind === "ics") return { kind: "ics", label: s("label"), url: s("url") };
  if (body.kind === "caldav") return { kind: "caldav", label: s("label"), url: s("url"), username: s("username"), password: s("password") };
  return null;
}

export const handleCalendarRoutes: RouteHandler = async (method, url, req, res, ctx, role) => {
  if (url.pathname !== "/api/calendars" && !url.pathname.startsWith("/api/calendars/")) return false;
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);
  if (role === "agent") { json(403, { error: "Calendars are connected by the user, in Settings." }); return true; }

  if (method === "GET" && url.pathname === "/api/calendars") {
    json(200, { calendars: listConnected().map(connectedView) });
    return true;
  }
  if (method !== "POST" || (url.pathname !== "/api/calendars/connect" && url.pathname !== "/api/calendars/disconnect")) return false;
  if (role !== "operator" && role !== "user") { json(403, { error: "Connecting a calendar requires operator or user role" }); return true; }
  const body = await safeParseBody(req);
  if (body === null) { json(400, { error: "Invalid JSON" }); return true; }

  if (url.pathname === "/api/calendars/connect") {
    const request = requestOf(body);
    if (!request) { json(400, { error: "kind must be ics or caldav" }); return true; }
    const result = await connectCalendar(request);
    if (!result.ok) { json(400, { error: result.error }); return true; }
    ctx.broadcastAll({ type: "settings_changed", settings: { calendars: true } });
    json(200, { ok: true, calendar: connectedView(result.calendar), events: result.events });
    return true;
  }
  const id = typeof body.id === "string" ? body.id : "";
  if (!disconnectCalendar(id)) { json(404, { error: `No connected calendar ${id}` }); return true; }
  ctx.broadcastAll({ type: "settings_changed", settings: { calendars: true } });
  json(200, { ok: true });
  return true;
};
