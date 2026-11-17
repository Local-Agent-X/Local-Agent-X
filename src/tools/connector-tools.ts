import type { ServerEvent, ToolDefinition, ToolResult } from "../types.js";
import { saveConnectorManifest, parseManifest, referencedSecrets } from "../routes/connector-proxy.js";
import { getSecretsStoreSingleton } from "../secrets.js";
import { gateSecretDestinations } from "../secret-destination-gate.js";
import { sessionIdOf } from "../tool-execution/internal-args.js";
import { listDevServerRecords } from "./dev-server-records.js";

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

function ok(content: string): ToolResult { return { content }; }
function err(content: string): ToolResult { return { content, isError: true }; }

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
    "A stored secret is bound to the upstreams it may reach: binding it to a new upstream asks the user once in the chat (a yes is kept), unless this session captured the secret, an op_submit_async run pre-blessed it, or the upstream is the secret's own recorded site; a declined create writes nothing. The proxy re-checks that binding on every request, so editing the manifest file cannot widen it. " +
    "allow is a non-empty list of exact \"METHOD /path\" entries (trailing /* matches a subtree) — only these forward. " +
    "From the app, call /api/connectors/<name>/<path> with header Authorization: 'Bearer ' + window.__LAX_CONNECTOR_TOKEN__. " +
    "Not for a program of the app's own on this PC (its backend): start that with app_serve_backend, which wires its connector and has LAX restart it with the app.",
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

    // Every stored secret the manifest binds must be allowed at the upstream
    // before the manifest exists (ADR 0005); the proxy re-runs the same ladder.
    const secrets = getSecretsStoreSingleton();
    const referenced = referencedSecrets(parsed.manifest.auth);
    const stored = referenced.filter(n => secrets?.has(n));
    if (secrets && stored.length > 0) {
      const gate = await gateSecretDestinations(
        stored.map((n) => ({ name: n, destination: parsed.manifest.upstream, purpose: `Send ${n} to ${parsed.manifest.upstream} through connector "${name}"` })),
        { store: secrets, sessionId: sessionIdOf(args) ?? "", toolName: "connector_create", call: args },
      );
      if (!gate.allowed) return gate.result;
    }

    saveConnectorManifest(name, parsed.manifest);

    const missing = referenced.filter(n => !secrets?.has(n));
    const warn = missing.length
      ? `\nReferenced vault secret(s) not stored yet: ${missing.join(", ")} — call request_secret for each before the connector will authenticate.`
      : "";

    return ok(
      `Connector "${name}" saved.\n` +
      `Apps can now call /api/connectors/${name}/<path> with header Authorization: 'Bearer ' + window.__LAX_CONNECTOR_TOKEN__.\n` +
      `Allowed: ${parsed.manifest.allow.join(", ")}${warn}` +
      unregisteredLocalProgramNote(parsed.manifest.upstream, listDevServerRecords().map((r) => r.port)),
    );
  },
};

/**
 * A connector to a port on this PC that no app's registered backend listens on
 * is most often an app's own program started by hand, which nothing restarts:
 * after a LAX restart the app's every call fails. Say how to register it.
 * A service the user runs themself is left as it is.
 */
export function unregisteredLocalProgramNote(upstream: string, registeredPorts: number[]): string {
  let url: URL;
  try { url = new URL(upstream); } catch { return ""; }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return "";
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (registeredPorts.includes(port)) return "";
  return `\nPort ${port} on this PC is no app's registered backend. If it is a program this app needs (one you start, not a service the user runs), ` +
    `start it with app_serve_backend({ app_id, command, port: ${port} }) and have the app call /api/connectors/dev-<app_id>/... instead: ` +
    `LAX then starts it when the app is opened and after a restart. A program started with process_start is not restarted.`;
}
