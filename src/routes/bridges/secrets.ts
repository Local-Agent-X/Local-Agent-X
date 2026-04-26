import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, safeParseBody } from "../../server-utils.js";

export const handleSecretsRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  if (method === "GET" && url.pathname === "/api/secrets") {
    json(200, ctx.secretsStore.list()); return true;
  }
  if (method === "POST" && url.pathname === "/api/secrets") {
    const body = await safeParseBody(req) as { name?: string; value?: string; service?: string; account?: string; url?: string; notes?: string };
    const name = body.name?.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
    if (!name || !body.value) { json(400, { error: "name and value are required" }); return true; }
    ctx.secretsStore.set(name, body.value, {
      service: body.service,
      account: body.account,
      url: body.url,
      notes: body.notes,
    });
    json(200, { ok: true, name }); return true;
  }
  // PATCH metadata only (not the value). Used by the secrets UI so users can
  // annotate entries without re-entering the password.
  if (method === "PATCH" && url.pathname.startsWith("/api/secrets/")) {
    const name = decodeURIComponent(url.pathname.split("/").pop()!);
    if (!/^[A-Z0-9_]{1,64}$/i.test(name)) { json(400, { error: "Invalid secret name" }); return true; }
    const existing = ctx.secretsStore.get(name);
    if (existing === undefined) { json(404, { error: "Not found" }); return true; }
    const body = await safeParseBody(req) as { service?: string; account?: string; url?: string; notes?: string };
    ctx.secretsStore.set(name, existing, {
      service: body.service,
      account: body.account,
      url: body.url,
      notes: body.notes,
    });
    json(200, { ok: true, name }); return true;
  }
  // Reveal the decrypted value for ONE secret. Same auth-token gate as every
  // other loopback route. Never exports. Never logged. Caller is the user's
  // browser session that already has the token — this is only a convenience
  // read so Alex can copy/paste creds he asked the agent to generate.
  if (method === "GET" && url.pathname.match(/^\/api\/secrets\/[^/]+\/reveal$/)) {
    const name = decodeURIComponent(url.pathname.split("/")[3]);
    if (!/^[A-Z0-9_]{1,64}$/i.test(name)) { json(400, { error: "Invalid secret name" }); return true; }
    const value = ctx.secretsStore.get(name);
    if (value === undefined) { json(404, { error: "Not found" }); return true; }
    json(200, { name, value }); return true;
  }
  // Approve a specific {secret, origin} pair for automated fill by
  // browser_fill_from_secret. This is the first-use approval gate: the agent
  // fills fine once the user clicks "Approve" in the Secrets UI for an origin.
  // Approvals persist in the vault entry and survive restarts.
  if (method === "POST" && url.pathname.match(/^\/api\/secrets\/[^/]+\/approve-origin$/)) {
    const name = decodeURIComponent(url.pathname.split("/")[3]);
    if (!/^[A-Z0-9_]{1,64}$/i.test(name)) { json(400, { error: "Invalid secret name" }); return true; }
    const body = await safeParseBody(req) as { origin?: string };
    const originRaw = (body.origin || "").trim();
    if (!originRaw) { json(400, { error: "origin is required" }); return true; }
    // Normalize to canonical origin form (scheme://host[:port]); reject anything we can't parse.
    let origin: string;
    try { origin = new URL(originRaw).origin; } catch { json(400, { error: "origin must be a full URL" }); return true; }
    const ok = ctx.secretsStore.approveFill(name, origin);
    if (!ok) { json(404, { error: "Secret not found" }); return true; }
    json(200, { ok: true, name, origin }); return true;
  }
  // Revoke a previously-granted fill approval for a specific origin.
  if (method === "DELETE" && url.pathname.match(/^\/api\/secrets\/[^/]+\/approvals\/.+$/)) {
    const parts = url.pathname.split("/");
    const name = decodeURIComponent(parts[3]);
    const origin = decodeURIComponent(parts.slice(5).join("/"));
    if (!/^[A-Z0-9_]{1,64}$/i.test(name)) { json(400, { error: "Invalid secret name" }); return true; }
    const removed = ctx.secretsStore.revokeFillApproval(name, origin);
    json(200, { ok: true, removed }); return true;
  }
  if (method === "DELETE" && url.pathname.startsWith("/api/secrets/")) {
    const name = decodeURIComponent(url.pathname.split("/").pop()!);
    if (!/^[A-Z0-9_]{1,64}$/i.test(name)) { json(400, { error: "Invalid secret name" }); return true; }
    json(200, { ok: true, deleted: ctx.secretsStore.delete(name) }); return true;
  }

  return false;
};
