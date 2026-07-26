import { createTransport } from "nodemailer";
import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, safeParseBody } from "../../server-utils.js";
import { IntegrationRegistry } from "../../integrations/index.js";
import { normalizeTransport, type IntegrationTransport } from "../../integrations/types.js";
import { BUILTIN_INTEGRATIONS } from "../../integrations/builtins/index.js";
import { canonicalFetch } from "../../tools/web-egress.js";
import { getSmtpConfig, ownsEmailConfig, writeEmailCredentials } from "../../tools/email-config.js";
import { isRequiredRequirement, isSecretRequirement, type CredentialRequirement } from "../../credentials/requirements.js";

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
 *     (uninstall, /api/integrations/test, the tool auth path) act on — that is a
 *     property of this seam, so a declaration cannot opt out of it;
 *   - every OTHER credential must be supplied unless the declaration says the
 *     integration runs without it (`required: false`). Answering 200 over a
 *     declaration whose own terms are unmet is the same silent success the rules
 *     above remove: it marks the integration CONNECTED on a configuration that
 *     cannot work. The Settings modal enforces the identical rule client-side
 *     (it blocks submit on a blank REQUIRED field and skips a blank optional
 *     one), so the two ends of the install cannot drift;
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
  const missing = credentials.find(c => isRequiredRequirement(c) && !supplied.has(c.name));
  if (missing) return { error: `Credential ${missing.name} is required` };
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
  names: string[],
  token: string,
): Record<string, string> {
  // Always `{{NAME}}`-wrapped, never a bare name: a bare empty name makes
  // `value.includes("")` true for EVERY header and splices the token between
  // every character of each one. Wrapping makes the no-credential case an inert
  // "{{}}" that matches nothing, so the guard cannot be dropped by accident.
  const placeholders = [...new Set(names.filter(Boolean))].map(n => `{{${n}}}`);
  const headers: Record<string, string> = {};
  let carriesCredential = false;
  for (const [key, value] of Object.entries(declared ?? {})) {
    let resolved = value;
    if (typeof resolved === "string") {
      for (const placeholder of placeholders) {
        if (!resolved.includes(placeholder)) continue;
        // split/join, not assignment: a declared header may EMBED the
        // placeholder in a scheme prefix ("Bearer {{X}}", "Key {{X}}"), and
        // overwriting the whole value would drop the prefix the API requires.
        resolved = resolved.split(placeholder).join(token);
        carriesCredential = true;
      }
    }
    headers[key] = resolved;
  }
  if (!carriesCredential) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

/**
 * The credential name a BUILTIN's declared headers were written against.
 *
 * `secretName` is user-authored state — a saved integrations.json may point the
 * primary at any vault entry (savedPrimaryName() in registry.ts), and the
 * registry renames the credential but NOT the shipped `headers` map, which
 * still names the default. Matching only the renamed name therefore left
 * google's `X-Goog-Api-Key: {{GOOGLE_API_KEY}}` unsubstituted AND appended a
 * bearer token YouTube rejects, so a perfectly good renamed key reported
 * "Connection failed".
 *
 * Keyed by builtin id, so this can only ever place the integration's OWN token
 * into the integration's OWN shipped header. A custom integration cannot claim
 * a builtin id (the registry seeds builtins first and merges by id), and even
 * if it could, the value substituted is its own primary token — never another
 * stored secret.
 */
const BUILTIN_PRIMARY_NAME = new Map(
  BUILTIN_INTEGRATIONS.map(d => [d.id, d.credentials[0]?.name ?? ""]),
);

/**
 * What "test this integration" means for a transport HTTP cannot carry.
 *
 * Switched on the transport rather than assuming the only one that exists
 * today. The body below is SMTP-specific — it calls getSmtpConfig() and dials
 * the mailbox — so a second non-HTTP transport falling through to it would have
 * the Settings button report the email mailbox's health as that transport's.
 * The `never` assignment after the switch makes adding one a COMPILE error
 * instead, which is the only way this stays honest without a second list.
 *
 * Ownership, not the declared transport, decides who may run the SMTP test, for
 * the reason ownsEmailConfig() gives: `transport` is caller-authored, and the
 * mailbox this dials plus the account it names are the owning integration's, not
 * the caller's.
 */
async function testNonHttpTransport(
  config: { id?: unknown; builtin?: unknown },
  transport: Exclude<IntegrationTransport, "http">,
): Promise<{ status: number; body: Record<string, unknown> }> {
  switch (transport) {
    case "smtp_imap":
      if (!ownsEmailConfig(config)) {
        return { status: 400, body: { error: `Integration "${String(config.id)}" declares the "smtp_imap" transport but does not own the email configuration, so there is nothing here to test` } };
      }
      return { status: 200, body: await testSmtpMailbox(transport) };
  }
  const unreachable: never = transport;
  throw new Error(`No connection test is defined for transport "${String(unreachable)}"`);
}

/**
 * The SMTP handshake behind the email transport's "test".
 *
 * The HTTP branch joins an endpoint path onto `baseUrl`; for email that built
 * `"" + "smtp"` and fired a request at a nonsense URL that could only ever
 * fail. This branch never builds a URL and never claims a connection it did not
 * make: a configuration that is incomplete is reported as incomplete WITHOUT a
 * network call, and a complete one is verified for real — the same
 * `transport.verify()` handshake `email_setup` runs, over the same
 * getSmtpConfig() the email_* tools send with, so a green answer here means the
 * mailbox actually accepted these credentials.
 *
 * The host dialled comes from ~/.lax/email.json, NOT from the integration
 * declaration, so this adds no reach: it is the identical connection
 * `email_send` already makes with the identical credential.
 */
async function testSmtpMailbox(
  transport: Exclude<IntegrationTransport, "http">,
): Promise<Record<string, unknown>> {
  const cfg = getSmtpConfig();
  if (typeof cfg === "string") return { ok: false, transport, error: cfg };
  try {
    await createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.port === 465,
      auth: { user: cfg.user, pass: cfg.pass },
      // Matched to the HTTP probe's timeoutMs so neither branch can hang the
      // Settings button longer than the other.
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 10000,
    }).verify();
    return { ok: true, transport, status: "SMTP", statusText: `authenticated as ${cfg.user} at ${cfg.host}:${cfg.port}` };
  } catch (e) {
    return { ok: false, transport, error: `SMTP ${cfg.host}:${cfg.port} — ${(e as Error).message}` };
  }
}

/**
 * Where a `secret: false` install value is persisted, chosen by which config
 * store the integration OWNS.
 *
 * `secret: false` means "config, not credential": it must not be encrypted at
 * rest in the vault, so it needs a sink of its own. ~/.lax/email.json is the
 * only such sink, it belongs to the builtin `email` integration, and
 * writeEmailJson() stays its only writer.
 *
 * Routing on the DECLARED transport instead was the defect this replaces:
 * `transport` is a field the caller supplies, so any installed integration could
 * name `smtp_imap` and merge SMTP_HOST into the real mailbox's config — see
 * ownsEmailConfig(), which is where that argument lives, so this route and the
 * store cannot drift about who may write it.
 *
 * An integration that owns no config store has nowhere to put such a value, and
 * no builtin declares one. Dropping it is what this route used to do for EVERY
 * non-secret credential, and it is the silent success the rest of this seam
 * removes: it answers 200 and marks the integration CONNECTED over a value it
 * threw away. So it is refused instead — the same 400 a non-owner now gets, for
 * the same reason, rather than a 200 over a discarded write.
 */
function persistNonSecretValues(
  config: { id?: unknown; builtin?: unknown },
  values: Record<string, string>,
  vaultedSecretNames: string[],
): { error: string } | null {
  if (Object.keys(values).length === 0) return null;
  if (ownsEmailConfig(config)) return writeEmailCredentials(values, vaultedSecretNames);
  return { error: `Integration "${String(config.id)}" declares non-secret credential(s) ${Object.keys(values).join(", ")} but owns no configuration store to hold them` };
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
    // Split by DECLARED kind, then persist each half to the sink that kind
    // belongs in. A `secret: false` requirement is config (SMTP_HOST) and must
    // never reach the encrypted vault; a secret must never reach the plaintext
    // config file. That split is the whole point of the flag.
    const nonSecret: Record<string, string> = {};
    const vaulted: Array<{ name: string; value: string }> = [];
    for (const { requirement, value } of resolved.values) {
      if (isSecretRequirement(requirement)) vaulted.push({ name: requirement.name, value });
      else nonSecret[requirement.name] = value;
    }
    // Config first: it validates before it writes, so a rejected install leaves
    // the vault — the sensitive half — untouched.
    const persisted = persistNonSecretValues(config, nonSecret, vaulted.map(v => v.name));
    if (persisted) { json(400, { error: persisted.error }); return true; }
    for (const { name, value } of vaulted) {
      // `config.name` is the human-readable service label the Secrets UI shows;
      // it is metadata, not an ownership record — nothing reads it back.
      ctx.secretsStore.set(name, value, config.name);
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
    // Before the vault lookup, not after: a non-HTTP transport resolves its own
    // credential through its own config path (email's SMTP_PASS_SECRET
    // indirection lets the password live under any vault name), so gating it on
    // `secretsStore.get(secretName)` would refuse to test a working mailbox.
    const transport = normalizeTransport((config as { transport?: unknown }).transport);
    if (transport !== "http") {
      const { status, body: result } = await testNonHttpTransport(config, transport);
      json(status, result); return true;
    }
    const token = ctx.secretsStore.get(config.secretName);
    if (!token) { json(400, { error: `No credentials found. Save your ${config.secretName} first.` }); return true; }
    try {
      const testEndpoint = config.endpoints.find(e => e.method === "GET") || config.endpoints[0];
      const path = testEndpoint?.path?.replace(/\{[^}]+\}/g, "") || "";
      const query = PROBE_QUERY[path];
      const testUrl = config.baseUrl + path + (query ? `?${query}` : "");
      const headers = probeHeaders(
        config.headers,
        [config.secretName, BUILTIN_PRIMARY_NAME.get(config.id) ?? ""],
        token,
      );
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
