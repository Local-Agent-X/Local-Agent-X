import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, safeParseBody } from "../../server-utils.js";
import { IntegrationRegistry } from "../../integrations/index.js";
import { canonicalFetch } from "../../tools/web-egress.js";
import { isSecretRequirement, type CredentialRequirement } from "../../credentials/requirements.js";

type InstallBody = { id: string; secretValue?: unknown; secretValues?: unknown };

/**
 * Pairs each supplied install value with the credential it was DECLARED under.
 * `secretValues` is the multi-credential shape; a bare `secretValue` still means
 * "the primary credential", so every caller written against the single-field
 * install keeps working unchanged.
 *
 * A name the integration does not declare is rejected outright, and resolution
 * completes before anything is written, so a rejected install never leaves a
 * partial write behind. That check bounds a write to the DECLARED names only —
 * it is not a proof that this route cannot write an arbitrary secret, because
 * the declaration itself is authored over the network (POST /api/integrations
 * accepts any credential list). It is the same capability, at the same
 * privilege, that POST /api/secrets already exposes.
 *
 * There is no silent-success branch here. Every arm that cannot produce a
 * stored credential returns an error, so the route never answers 200 over a
 * vault it wrote nothing to:
 *   - a supplied value that is not a string, or is the empty string, is an
 *     error rather than a skip (the modal already refuses to submit a blank, so
 *     nothing legitimate sends one);
 *   - the PRIMARY credential must end up supplied whenever the integration
 *     declares any, because the primary is what the single-name readers
 *     (uninstall, /api/integrations/test, the tool auth path) act on;
 *   - a DECLARED-but-omitted non-primary is still allowed, since C7 is where
 *     email first brings a real multi-credential list and decides whether the
 *     rest are mandatory;
 *   - an integration that declares NO credentials has nothing to store, so it
 *     installs cleanly on an empty body — but supplying a value for it is an
 *     error, because there is no declared name to bind that value to.
 */
function resolveInstallValues(
  credentials: CredentialRequirement[],
  body: InstallBody,
): { values: Array<{ requirement: CredentialRequirement; value: string }> } | { error: string } {
  const declared = new Map(credentials.map(c => [c.name, c]));
  const supplied = new Map<string, string>();
  if (body.secretValues !== undefined) {
    const raw = body.secretValues;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "secretValues must be an object" };
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!declared.has(name)) return { error: `Integration does not declare credential ${name}` };
      if (typeof value !== "string") return { error: `Credential ${name} must be a string` };
      if (!value) return { error: `Credential ${name} must not be empty` };
      supplied.set(name, value);
    }
  }
  if (body.secretValue !== undefined) {
    const primary = credentials[0];
    if (!primary) return { error: "Integration declares no credentials" };
    if (typeof body.secretValue !== "string") return { error: `Credential ${primary.name} must be a string` };
    if (!body.secretValue) return { error: `Credential ${primary.name} must not be empty` };
    if (!supplied.has(primary.name)) supplied.set(primary.name, body.secretValue);
  }
  const primary = credentials[0];
  if (primary && !supplied.has(primary.name)) return { error: `Credential ${primary.name} is required` };
  return { values: [...supplied].map(([name, value]) => ({ requirement: declared.get(name)!, value })) };
}

/**
 * The extra query a connection probe needs on top of the endpoint's path,
 * keyed on the API being probed.
 *
 * This is the honest residue of the `config.id === "google"` special case, and
 * it is deliberately NOT declaration-driven. YouTube Data v3 rejects every
 * request that omits `part`, and `part` takes an enum of resource-part names —
 * so filling the endpoint's declared required params with any generic probe
 * value returns 400 for a PERFECTLY VALID key, and the Settings button (which
 * renders `ok: false` as "Connection failed") would tell that user their key is
 * broken. IntegrationEndpoint carries a param's type, requiredness and prose
 * description but no VALUE that is valid for it, so there is nothing generic to
 * key off. An `example`/`default` on the param declaration is what would retire
 * this table; deleting it outright without one would just break the button.
 *
 * The credential's placement is a separate question and does NOT live here —
 * see probeHeaders(), which answers it from the declaration.
 */
const PROBE_QUERY: Record<string, string> = {
  "/youtube/v3/search": "part=snippet&q=test&maxResults=1",
};

/**
 * The headers a connection probe sends, with the credential where the
 * INTEGRATION says it goes rather than where this route guesses.
 *
 * An integration that names its primary credential inside a declared header —
 * google's `X-Goog-Api-Key: {{GOOGLE_API_KEY}}` — gets the token substituted
 * there. Everything that does not falls through to `Authorization: Bearer`,
 * which is what all ten bearer/bot-token builtins want and is byte-identical to
 * what they got before this existed (none of them declares a header naming its
 * credential). That is what retired `if (config.id === "google")`: the route no
 * longer knows any integration by name.
 *
 * Only the PRIMARY credential is substituted, and only into a header the
 * integration itself declared. Reaching for the vault's own {{SECRET}} resolver
 * would have been less code and strictly worse: POST /api/integrations accepts
 * an attacker-authored baseUrl AND an attacker-authored header map, so generic
 * resolution would turn the test button into a send-any-stored-secret-anywhere
 * primitive. The single token this route already sent is still the only token
 * it can send.
 */
function probeHeaders(
  declared: Record<string, string> | undefined,
  secretName: string,
  token: string,
): Record<string, string> {
  const placeholder = secretName ? `{{${secretName}}}` : "";
  const headers: Record<string, string> = {};
  let carriesCredential = false;
  for (const [key, value] of Object.entries(declared ?? {})) {
    if (placeholder && typeof value === "string" && value.includes(placeholder)) {
      headers[key] = value.split(placeholder).join(token);
      carriesCredential = true;
    } else {
      headers[key] = value;
    }
  }
  if (!carriesCredential) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

export const handleIntegrationsRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  if (method === "GET" && url.pathname === "/api/integrations") {
    json(200, ctx.integrations.list()); return true;
  }
  if (method === "GET" && url.pathname === "/api/integrations/schema") {
    json(200, { schema: IntegrationRegistry.getIntegrationSchema() }); return true;
  }
  if (method === "GET" && url.pathname.startsWith("/api/integrations/") && !url.pathname.includes("install") && !url.pathname.includes("uninstall") && !url.pathname.includes("toggle") && !url.pathname.includes("test") && !url.pathname.includes("schema")) {
    const id = decodeURIComponent(url.pathname.split("/").pop()!);
    const config = ctx.integrations.get(id);
    if (!config) { json(404, { error: "Integration not found" }); return true; }
    json(200, config); return true;
  }
  if (method === "POST" && url.pathname === "/api/integrations/install") {
    const body = await safeParseBody(req) as InstallBody | null;
    if (!body) { json(400, { error: "Invalid JSON" }); return true; }
    const config = ctx.integrations.get(body.id);
    if (!config) { json(404, { error: "Integration not found" }); return true; }
    const resolved = resolveInstallValues(config.credentials, body);
    if ("error" in resolved) { json(400, { error: resolved.error }); return true; }
    for (const { requirement, value } of resolved.values) {
      // A `secret: false` requirement is non-secret config (e.g. SMTP_HOST) and
      // must never reach the encrypted vault. There is no non-vault sink on this
      // seam yet, so such a value is collected by the modal and dropped here
      // rather than persisted somewhere it does not belong.
      if (!isSecretRequirement(requirement)) continue;
      // `config.name` is the human-readable service label the Secrets UI shows;
      // it is metadata, not an ownership record — nothing reads it back.
      ctx.secretsStore.set(requirement.name, value, config.name);
    }
    ctx.integrations.markInstalled(body.id, true);
    json(200, { ok: true, id: body.id, secretName: config.secretName }); return true;
  }
  if (method === "POST" && url.pathname === "/api/integrations/uninstall") {
    const body = await safeParseBody(req) as { id: string } | null;
    if (!body) { json(400, { error: "Invalid JSON" }); return true; }
    const config = ctx.integrations.get(body.id);
    if (!config) { json(404, { error: "Integration not found" }); return true; }
    // The PRIMARY credential only. Deleting the whole declared list was tried
    // and withdrawn: bounding it to "what this install wrote" recorded the
    // owner in the vault entry's free-text `service` label, which is forgeable
    // by any caller of POST /api/secrets and which silently orphaned any secret
    // the user had relabelled in the Secrets UI. Deleting the declared list
    // UNBOUNDED is worse still, because POST /api/integrations accepts any
    // credential list.
    //
    // All 11 builtins declare exactly one credential, so this is complete in
    // production today and identical to the behaviour that shipped before this
    // chunk. C7 is where email first gets a real multi-credential list, and so
    // is where multi-credential cleanup becomes a real problem worth solving.
    // `secretName` is derived from credentials[0] and is "" when an integration
    // declares none — there is then nothing to delete.
    if (config.secretName) ctx.secretsStore.delete(config.secretName);
    ctx.integrations.markInstalled(body.id, false);
    json(200, { ok: true, id: body.id }); return true;
  }
  if (method === "POST" && url.pathname === "/api/integrations/toggle") {
    const body = await safeParseBody(req) as { id: string; enabled: boolean };
    ctx.integrations.setEnabled(body.id, body.enabled);
    json(200, { ok: true, id: body.id, enabled: body.enabled }); return true;
  }
  if (method === "POST" && url.pathname === "/api/integrations") {
    const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
    if (!body.id || !body.name || !body.baseUrl) { json(400, { error: "id, name, and baseUrl are required" }); return true; }
    body.builtin = false; body.installed = false; body.enabled = true;
    if (!body.endpoints) body.endpoints = [];
    if (!body.headers) body.headers = {};
    ctx.integrations.addIntegration(body as unknown as import("../../integrations/index.js").IntegrationConfig);
    json(200, { ok: true, id: body.id }); return true;
  }
  if (method === "DELETE" && url.pathname.startsWith("/api/integrations/")) {
    const id = decodeURIComponent(url.pathname.split("/").pop()!);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) { json(400, { error: "Invalid integration ID" }); return true; }
    const removed = ctx.integrations.removeIntegration(id);
    if (!removed) { json(400, { error: "Cannot delete built-in integration" }); return true; }
    json(200, { ok: true, deleted: id }); return true;
  }
  if (method === "POST" && url.pathname === "/api/integrations/test") {
    const body = await safeParseBody(req) as { id: string };
    const config = ctx.integrations.get(body.id);
    if (!config) { json(404, { error: "Integration not found" }); return true; }
    const token = ctx.secretsStore.get(config.secretName);
    if (!token) { json(400, { error: `No credentials found. Save your ${config.secretName} first.` }); return true; }
    try {
      const testEndpoint = config.endpoints.find(e => e.method === "GET") || config.endpoints[0];
      const path = testEndpoint?.path?.replace(/\{[^}]+\}/g, "") || "";
      const query = PROBE_QUERY[path];
      const testUrl = config.baseUrl + path + (query ? `?${query}` : "");
      const headers = probeHeaders(config.headers, config.secretName, token);
      // Route through the SSRF-pinned egress chokepoint (DNS-pin + private-IP
      // block + per-hop redirect re-validation) instead of a raw fetch — this
      // HTTP route was sending a stored credential to an attacker-influenced
      // baseUrl past the egress controls the agent's own fetch tools honor.
      const r = await canonicalFetch(testUrl, { headers, timeoutMs: 10000 });
      json(200, { ok: r.ok, status: r.status, statusText: r.statusText });
    } catch (e) { json(200, { ok: false, error: (e as Error).message }); }
    return true;
  }

  return false;
};
