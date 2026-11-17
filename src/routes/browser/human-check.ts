import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, readBody } from "../../server-utils.js";
import { humanCheckPicture, relayHumanCheck } from "../../tools/browser-tools/human-check-handoff.js";
import { parseRelayedInput } from "../../browser/relayed-input.js";

/**
 * The phone's side of a human check handed to the user
 * (tools/browser-tools/human-check-handoff.ts). Both answer only while a
 * handoff is open for that chat, so they reach no browser the user was not
 * just alerted about.
 *
 *   GET  /api/human-check/<sessionId>       → { open: false } | { open: true, site, mime, b64 }
 *   POST /api/human-check/<sessionId>/input { kind, x, y } | { kind: "text", text } | { kind: "key", key } → { ok }
 *        (browser/relayed-input.ts; points are 0..1 of the picture)
 *   POST /api/human-check/<sessionId>/tap   { x, y }: the first phone build's tap, kept for it
 *
 * Input changes a browser page, not a setting another tab shows, so it
 * broadcasts nothing; the chat hears of the result when the check is gone.
 */
export const handleHumanCheckRoutes: RouteHandler = async (method, url, req, res, _ctx, _role) => {
  const m = /^\/api\/human-check\/([^/]+)(\/(?:tap|input))?$/.exec(url.pathname);
  if (!m) return false;
  const sessionId = decodeURIComponent(m[1]);
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);
  try {
    if (method === "GET" && !m[2]) { json(200, await humanCheckPicture(sessionId)); return true; }
    if (method === "POST" && m[2]) {
      const input = parseRelayedInput(JSON.parse((await readBody(req)) || "{}"));
      const ok = await relayHumanCheck(sessionId, input);
      json(ok ? 200 : 409, ok ? { ok: true } : { error: "No check is waiting on you in that chat any more." });
      return true;
    }
    json(405, { error: "Method not allowed" });
  } catch (e) {
    json(400, { error: (e as Error).message });
  }
  return true;
};
