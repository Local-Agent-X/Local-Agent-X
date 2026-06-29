import type { ToolDefinition, ToolResult } from "../types.js";
import { saveConnectorManifest, parseManifest, type ConnectorManifest } from "../routes/connector-proxy.js";
import { getSecretsStoreSingleton } from "../secrets.js";

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

function ok(content: string): ToolResult { return { content }; }
function err(content: string): ToolResult { return { content, isError: true }; }

/** Vault secret names a manifest's auth references — so we can warn when one
 *  isn't stored yet (the connector 401s at call time without it). */
function referencedSecrets(auth: ConnectorManifest["auth"]): string[] {
  const names = new Set<string>();
  if (auth.type === "bearer" || auth.type === "header") names.add(auth.secret);
  else if (auth.type === "signed") {
    names.add(auth.secret);
    for (const tmpl of Object.values(auth.headers ?? {})) {
      for (const m of tmpl.matchAll(/\{vault:([^}]+)\}/g)) names.add(m[1]);
    }
  }
  return [...names];
}

/**
 * connector_create — the sanctioned way to define an external-API connector.
 *
 * A built app can't reach an external API directly (the sandbox CSP blocks
 * cross-origin fetch) and must never drive a core self_edit. The connector
 * proxy is the gate; this tool writes the validated manifest behind it. The
 * builder agent is sandboxed to its app dir, so it can't write the manifest
 * file itself — this tool does it for it (same shape as request_secret writing
 * the vault). Validation reuses parseManifest so the recipe can't drift.
 */
export const connectorCreateTool: ToolDefinition = {
  name: "connector_create",
  description:
    "Define a connector so an app or dashboard can reach an external API through the same-origin proxy /api/connectors/<name> — the app sandbox's CSP blocks direct cross-origin fetch, and core LAX must never be edited to add an integration. Writes a validated manifest behind the proxy gate. " +
    "auth: {type:'none'} for a keyless public API; {type:'bearer',secret:'NAME'} or {type:'header',header:'X-Api-Key',secret:'NAME'} for a single key (store it first with request_secret and pass its NAME, never the value); {type:'signed',...} for HMAC-signed APIs. " +
    "allow is a non-empty list of exact \"METHOD /path\" entries (trailing /* matches a subtree) — only these forward. " +
    "From the app, call /api/connectors/<name>/<path> with header Authorization: 'Bearer ' + window.__LAX_CONNECTOR_TOKEN__.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Connector slug, lowercase (e.g. 'coingecko', 'webull'). The app calls /api/connectors/<name>/..." },
      upstream: { type: "string", description: "External API origin — https:// with no path (e.g. https://api.coingecko.com)." },
      auth: { type: "object", description: "Auth config. Default {type:'none'}. See the tool description for bearer/header/signed shapes. Secrets are referenced by vault NAME, never raw values." },
      allow: { type: "array", items: { type: "string" }, description: "Exact \"METHOD /path\" entries to allow, e.g. [\"GET /api/v3/simple/price\"]. Trailing /* matches a subtree." },
      forwardHeaders: { type: "array", items: { type: "string" }, description: "Optional client header names to forward upstream (never authorization/cookie)." },
      timeoutMs: { type: "number", description: "Optional upstream timeout in ms." },
    },
    required: ["name", "upstream", "allow"],
  },
  async execute(args): Promise<ToolResult> {
    const name = String(args.name || "").trim();
    if (!NAME_RE.test(name)) return err(`Connector name must be a lowercase slug ([a-z0-9][a-z0-9_-]*). Got ${JSON.stringify(args.name)}.`);

    const manifest: Record<string, unknown> = {
      upstream: args.upstream,
      auth: args.auth ?? { type: "none" },
      allow: args.allow,
    };
    if (args.forwardHeaders !== undefined) manifest.forwardHeaders = args.forwardHeaders;
    if (args.timeoutMs !== undefined) manifest.timeoutMs = args.timeoutMs;

    const parsed = parseManifest(JSON.stringify(manifest));
    if (!parsed.ok) return err(`Invalid connector manifest: ${parsed.error}`);

    saveConnectorManifest(name, parsed.manifest);

    const secrets = getSecretsStoreSingleton();
    const missing = referencedSecrets(parsed.manifest.auth).filter(n => !secrets?.has(n));
    const warn = missing.length
      ? `\nReferenced vault secret(s) not stored yet: ${missing.join(", ")} — call request_secret for each before the connector will authenticate.`
      : "";

    return ok(
      `Connector "${name}" saved.\n` +
      `Apps can now call /api/connectors/${name}/<path> with header Authorization: 'Bearer ' + window.__LAX_CONNECTOR_TOKEN__.\n` +
      `Allowed: ${parsed.manifest.allow.join(", ")}${warn}`
    );
  },
};
