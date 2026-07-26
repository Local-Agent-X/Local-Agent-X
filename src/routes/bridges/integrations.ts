import type { RouteHandler, ServerContext } from "../../server-context.js";
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
 * accepts any credential list). The bound that does hold is on uninstall; see
 * wroteCredential() below.
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
      if (value) supplied.set(name, value);
    }
  }
  if (body.secretValue !== undefined) {
    const primary = credentials[0];
    if (!primary) return { error: "Integration declares no credentials" };
    // A non-string used to be skipped: the route wrote nothing, still marked the
    // integration connected, and returned 200 — the user only discovered the
    // empty vault at /api/integrations/test. A credential write has no
    // silent-success branch, so this rejects with the wording the map path uses.
    if (typeof body.secretValue !== "string") return { error: `Credential ${primary.name} must be a string` };
    if (body.secretValue && !supplied.has(primary.name)) supplied.set(primary.name, body.secretValue);
  }
  return { values: [...supplied].map(([name, value]) => ({ requirement: declared.get(name)!, value })) };
}

/**
 * Whether THIS integration's install is what put `name` in the vault.
 *
 * Install records the owner in the entry's `service` metadata (it has always
 * passed `config.name` there), and `SecretsStore.set` preserves that field
 * across later updates that omit it, so the record survives a rotation through
 * the secrets UI. Uninstall deletes only entries this says it owns.
 *
 * Re-deriving the delete set from the live declaration instead would let one
 * uninstall empty the vault: `POST /api/integrations` accepts any credential
 * list, so an integration could declare every key it wants gone and then have
 * them all deleted by an uninstall that never installed anything.
 */
function wroteCredential(store: ServerContext["secretsStore"], name: string, owner: string): boolean {
  return store.getMeta(name)?.service === owner;
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
      // `config.name` is also the ownership record uninstall reads back — see
      // wroteCredential().
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
    // Every credential THIS integration's install wrote, not just the primary:
    // install writes one vault entry per credential, so deleting `secretName`
    // alone would orphan the rest of a multi-credential integration's secrets.
    // Bounded by what was actually written rather than by what is declared —
    // see wroteCredential(). A credential the user pointed this integration at
    // but never installed through it (email's SMTP_PASS indirection) is left
    // alone, which is the safe direction: an orphan is recoverable, a deleted
    // secret is not.
    for (const requirement of config.credentials) {
      if (!wroteCredential(ctx.secretsStore, requirement.name, config.name)) continue;
      ctx.secretsStore.delete(requirement.name);
    }
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
      let testUrl: string;
      const headers: Record<string, string> = { ...config.headers };
      if (config.id === "google" && config.authType === "api_key") {
        testUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=test&maxResults=1`;
        headers["X-Goog-Api-Key"] = token;
      } else {
        const testEndpoint = config.endpoints.find(e => e.method === "GET") || config.endpoints[0];
        testUrl = config.baseUrl + (testEndpoint?.path?.replace(/\{[^}]+\}/g, "") || "");
        headers["Authorization"] = `Bearer ${token}`;
      }
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
