/**
 * Connector proxy — one authenticated route that forwards dashboard/app
 * requests to external APIs, driven by declarative manifests in
 * `<lax data dir>/connectors/<name>.json`.
 *
 * Replaces the old pattern of one hand-written proxy route per service
 * (fastmail-proxy.ts, kraken-proxy.ts): each new integration meant editing
 * core route files, and the per-service routes drifted (one even shipped an
 * auth exemption). A connector is user DATA, not code — adding one never
 * touches the repo, survives platform updates, and always sits behind the
 * normal auth gate.
 *
 * Manifest shape:
 *   {
 *     "upstream": "https://api.fastmail.com",
 *     "auth": { "type": "bearer", "secret": "FASTMAIL" },
 *     "allow": ["GET /jmap/session", "POST /jmap/api"],
 *     "forwardHeaders": ["API-Key", "API-Sign"],
 *     "timeoutMs": 20000
 *   }
 *
 * auth.type: "bearer" (Authorization: Bearer <vault secret>),
 *            "header" ({header, secret} — secret sent in a named header),
 *            "none"   (client supplies everything via forwardHeaders).
 * allow:     "METHOD /path" entries; a trailing "/*" matches the subtree.
 * Secrets resolve from the vault by name and never leave the server.
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { Agent, fetch as undiciFetch } from "undici";
import type { Response as UndiciResponse } from "undici";
import type { RouteHandler } from "../server-context.js";
import { jsonResponse, safeErrorMessage } from "../server-utils.js";
import { getSecretsStoreSingleton } from "../secrets.js";
import { getLaxDir } from "../lax-data-dir.js";
import { createLogger } from "../logger.js";
import { type SignedAuthConfig, validateSignedAuth, signRequest } from "./connector-signing.js";
import { wakeDevServer } from "../tools/dev-server-access.js";
import { createPinningDispatcher, assertLiteralIpEgressAllowed } from "../tools/web-egress.js";
import { isLocalOnlyMode, isLoopbackUrl, LOCAL_ONLY_BLOCK_MESSAGE } from "../local-only-policy.js";

const logger = createLogger("routes.connector-proxy");
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
// The sole sanctioned non-https upstream: a loopback dev server the operator
// started locally. Single source of truth for the parse-time gate AND the
// connect-time carve-out below (they must not drift — a host the parser calls
// "local" is exactly the host forwarding lets skip the SSRF-pinning dispatcher).
const LOCAL_UPSTREAM_RE = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;
// Client headers a manifest may never forward: they carry LAX's own session
// auth, which must not leak upstream.
const FORBIDDEN_FORWARD = new Set(["authorization", "cookie"]);

export interface ConnectorManifest {
  upstream: string;
  auth:
    | { type: "bearer"; secret: string }
    | { type: "header"; header: string; secret: string }
    | SignedAuthConfig
    | { type: "none" };
  allow: string[];
  forwardHeaders?: string[];
  timeoutMs?: number;
}

export function connectorsDir(): string {
  return join(getLaxDir(), "connectors");
}

/** Persist a validated manifest as the canonical connector file. The single
 *  writer — connector_create and the dev-server lifecycle both call this so the
 *  on-disk shape can't drift between them. */
export function saveConnectorManifest(name: string, manifest: ConnectorManifest): void {
  const dir = connectorsDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(manifest, null, 2) + "\n");
}

/** Remove a connector file (e.g. when its owning app is deleted). Best-effort. */
export function deleteConnectorManifest(name: string): void {
  try { rmSync(join(connectorsDir(), `${name}.json`), { force: true }); } catch { /* already gone */ }
}

export function parseManifest(raw: string): { ok: true; manifest: ConnectorManifest } | { ok: false; error: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, error: "manifest is not valid JSON" }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "manifest must be a JSON object" };
  }
  const m = parsed as Record<string, unknown>;

  const upstream = typeof m.upstream === "string" ? m.upstream.replace(/\/+$/, "") : "";
  const isLocal = LOCAL_UPSTREAM_RE.test(upstream);
  if (!/^https:\/\/[^\s/]+$/.test(upstream) && !isLocal) {
    return { ok: false, error: "upstream must be an https:// origin (or http://localhost for local services), no path" };
  }

  const auth = m.auth as Record<string, unknown> | undefined;
  const authType = auth?.type;
  if (authType === "bearer" || authType === "header") {
    if (typeof auth?.secret !== "string" || !auth.secret) return { ok: false, error: `auth.type "${authType}" requires auth.secret (a vault secret name)` };
    if (authType === "header" && (typeof auth?.header !== "string" || !auth.header)) return { ok: false, error: `auth.type "header" requires auth.header` };
  } else if (authType === "signed") {
    const err = validateSignedAuth(auth);
    if (err) return { ok: false, error: `auth.type "signed": ${err}` };
  } else if (authType !== "none") {
    return { ok: false, error: `auth.type must be "bearer", "header", "signed", or "none"` };
  }

  if (!Array.isArray(m.allow) || m.allow.length === 0) {
    return { ok: false, error: "allow must be a non-empty array of \"METHOD /path\" entries" };
  }
  for (const entry of m.allow) {
    if (typeof entry !== "string" || !/^(GET|POST|PUT|PATCH|DELETE|HEAD) \/\S*$/.test(entry)) {
      return { ok: false, error: `invalid allow entry ${JSON.stringify(entry)} — expected "METHOD /path" (optionally ending in /*)` };
    }
  }

  if (m.forwardHeaders !== undefined) {
    if (!Array.isArray(m.forwardHeaders) || m.forwardHeaders.some(h => typeof h !== "string")) {
      return { ok: false, error: "forwardHeaders must be an array of header names" };
    }
    const banned = (m.forwardHeaders as string[]).filter(h => FORBIDDEN_FORWARD.has(h.toLowerCase()));
    if (banned.length) return { ok: false, error: `forwardHeaders may not include ${banned.join(", ")} — those carry LAX's own session auth` };
  }

  const timeoutMs = m.timeoutMs === undefined ? undefined
    : Math.min(Math.max(Number(m.timeoutMs) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);

  return {
    ok: true,
    manifest: {
      upstream,
      auth: (authType === "none" ? { type: "none" } : auth) as ConnectorManifest["auth"],
      allow: m.allow as string[],
      forwardHeaders: m.forwardHeaders as string[] | undefined,
      timeoutMs,
    },
  };
}

/** True when `method` + `path` matches an allow entry ("METHOD /p" exact, "METHOD /p/*" subtree). */
export function matchAllow(allow: string[], method: string, path: string): boolean {
  for (const entry of allow) {
    const sp = entry.indexOf(" ");
    if (entry.slice(0, sp) !== method) continue;
    const pattern = entry.slice(sp + 1);
    if (pattern.endsWith("/*")) {
      if (path.startsWith(pattern.slice(0, -1)) || path === pattern.slice(0, -2)) return true;
    } else if (path === pattern) {
      return true;
    }
  }
  return false;
}

function loadManifest(name: string): { ok: true; manifest: ConnectorManifest } | { ok: false; status: number; error: string } {
  const file = join(connectorsDir(), `${name}.json`);
  if (!existsSync(file)) {
    return { ok: false, status: 404, error: `No connector "${name}". Create ${file} to define one.` };
  }
  const parsed = parseManifest(readFileSync(file, "utf-8"));
  if (!parsed.ok) return { ok: false, status: 500, error: `Connector "${name}" manifest invalid: ${parsed.error}` };
  return parsed;
}

async function readRawBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

interface ForwardInit {
  method: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}

// One long-lived SSRF-pinning dispatcher for all connector traffic. The pin is
// applied per-CONNECT (resolveAndPinHost runs inside connect.lookup), so a
// shared pool still revalidates DNS for every new connection; reuse is faster
// and avoids Agent.close() stalls on unread bodies (see web-egress.ts).
let sharedDispatcher: Agent | null = null;
function pinnedDispatcher(): Agent {
  if (!sharedDispatcher) sharedDispatcher = createPinningDispatcher();
  return sharedDispatcher;
}

/** Forward to the upstream with a timeout AND a connect-time SSRF guard.
 *
 *  Parse-time validation only sees the manifest STRING, so a public wildcard-DNS
 *  host like `https://169.254.169.254.nip.io` (or a DNS-rebind) passes it yet
 *  resolves to a private/metadata IP at connect time — the SSRF this route must
 *  block. Every non-local (https) upstream is therefore dialed through the
 *  canonical pinning dispatcher: it resolves the host, rejects the connection if
 *  ANY A/AAAA record is private/loopback/link-local/CGNAT/ULA, and pins the
 *  socket to the validated IP (no rebind TOCTOU). A literal-IP upstream never
 *  reaches the dispatcher's lookup, so it is checked synchronously first.
 *
 *  The sanctioned loopback dev carve-out (http://localhost|127.0.0.1) keeps a
 *  plain fetch — the pinning dispatcher would (correctly) refuse a loopback
 *  resolve, but these are operator-started local dev servers. */
export async function forwardWithTimeout(
  u: string,
  init: ForwardInit,
  timeoutMs: number,
  isLocalUpstream: boolean,
): Promise<Response | UndiciResponse> {
  if (isLocalOnlyMode() && !isLoopbackUrl(u)) throw new Error(LOCAL_ONLY_BLOCK_MESSAGE);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    if (isLocalUpstream) {
      return await fetch(u, { ...init, signal: ctrl.signal });
    }
    await assertLiteralIpEgressAllowed(u);
    return await undiciFetch(u, { ...init, signal: ctrl.signal, dispatcher: pinnedDispatcher() });
  } finally {
    clearTimeout(timer);
  }
}

export const handleConnectorProxyRoutes: RouteHandler = async (method, url, req, res) => {
  const json = (s: number, d: unknown) => jsonResponse(res, s, d, req);

  // Listing — lets the UI/agent discover configured connectors (no secrets).
  if (method === "GET" && url.pathname === "/api/connectors") {
    const dir = connectorsDir();
    const names = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".json")).map(f => f.slice(0, -5)) : [];
    const connectors = names.filter(n => NAME_RE.test(n)).map(name => {
      const loaded = loadManifest(name);
      return loaded.ok
        ? { name, upstream: loaded.manifest.upstream, allow: loaded.manifest.allow }
        : { name, error: loaded.error };
    });
    json(200, { connectors, dir });
    return true;
  }

  if (!url.pathname.startsWith("/api/connectors/")) return false;

  const rest = url.pathname.slice("/api/connectors/".length);
  const slash = rest.indexOf("/");
  const name = slash === -1 ? rest : rest.slice(0, slash);
  const upstreamPath = slash === -1 ? "/" : rest.slice(slash);
  if (!NAME_RE.test(name)) { json(400, { error: "Connector name must be a lowercase slug." }); return true; }

  // Traffic to a dev-<appId> connector means the app is in use: bump its
  // activity (keeps idle-stop off) and restart it if idle-stop took it down
  // while the app stayed open.
  if (name.startsWith("dev-")) wakeDevServer(name.slice(4));

  const loaded = loadManifest(name);
  if (!loaded.ok) { json(loaded.status, { error: loaded.error }); return true; }
  const manifest = loaded.manifest;

  if (isLocalOnlyMode() && !isLoopbackUrl(manifest.upstream)) {
    json(403, { error: LOCAL_ONLY_BLOCK_MESSAGE, code: "LOCAL_ONLY" });
    return true;
  }

  if (!matchAllow(manifest.allow, method, upstreamPath)) {
    json(403, { error: `${method} ${upstreamPath} is not in connector "${name}"'s allow list.`, allow: manifest.allow });
    return true;
  }

  const headers: Record<string, string> = { "Accept": "application/json" };
  if (manifest.auth.type === "bearer" || manifest.auth.type === "header") {
    const secret = getSecretsStoreSingleton()?.get(manifest.auth.secret);
    if (!secret) { json(401, { error: `Vault secret "${manifest.auth.secret}" is not configured — add it before using connector "${name}".` }); return true; }
    if (manifest.auth.type === "bearer") headers["Authorization"] = `Bearer ${secret}`;
    else headers[manifest.auth.header] = secret;
  }
  const clientContentType = req.headers["content-type"];
  if (typeof clientContentType === "string") headers["Content-Type"] = clientContentType;
  for (const h of manifest.forwardHeaders ?? []) {
    const v = req.headers[h.toLowerCase()];
    if (typeof v === "string") headers[h] = v;
  }

  let body: Buffer | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const raw = await readRawBody(req);
    if (raw === null) { json(413, { error: `Request body exceeds ${MAX_BODY_BYTES / 1024 / 1024}MB limit.` }); return true; }
    body = raw;
  }

  // Request signing (auth.type "signed") runs after the body is read so a body
  // hash covers the real bytes. The signature may append a query param, so the
  // forwarded search string is mutable from here. See connector-signing.ts.
  let upstreamSearch = url.search || "";
  if (manifest.auth.type === "signed") {
    const cfg = manifest.auth;
    const store = getSecretsStoreSingleton();
    const keyMaterial = store?.get(cfg.secret);
    if (!keyMaterial) { json(401, { error: `Vault secret "${cfg.secret}" is not configured — add it before using connector "${name}".` }); return true; }
    const vault: Record<string, string> = {};
    for (const tmpl of Object.values(cfg.headers ?? {})) {
      for (const ref of tmpl.matchAll(/\{vault:([^}]+)\}/g)) {
        const nm = ref[1];
        if (vault[nm] !== undefined) continue;
        const v = store?.get(nm);
        if (!v) { json(401, { error: `Vault secret "${nm}" required by connector "${name}" is not configured.` }); return true; }
        vault[nm] = v;
      }
    }
    try {
      const signed = signRequest({
        config: cfg, keyMaterial, vault,
        method, path: upstreamPath, query: upstreamSearch.replace(/^\?/, ""),
        host: new URL(manifest.upstream).hostname, body,
        now: new Date(), nonce: randomUUID(),
      });
      Object.assign(headers, signed.headers);
      if (signed.queryAppend) {
        const sep = upstreamSearch ? "&" : "?";
        upstreamSearch += `${sep}${encodeURIComponent(signed.queryAppend.name)}=${encodeURIComponent(signed.queryAppend.value)}`;
      }
    } catch (e) {
      json(500, { error: `Connector "${name}" signing failed: ${safeErrorMessage(e)}` });
      return true;
    }
  }

  try {
    const up = await forwardWithTimeout(
      manifest.upstream + upstreamPath + upstreamSearch,
      { method, headers, ...(body !== undefined ? { body: new Uint8Array(body) } : {}) },
      manifest.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      LOCAL_UPSTREAM_RE.test(manifest.upstream),
    );
    const responseBody = Buffer.from(await up.arrayBuffer());
    res.writeHead(up.status, { "Content-Type": up.headers.get("content-type") || "application/json" });
    res.end(responseBody);
  } catch (e) {
    logger.warn(`[connector.${name}] ${method} ${upstreamPath} failed: ${safeErrorMessage(e)}`);
    json(502, { error: { upstream: safeErrorMessage(e) } });
  }
  return true;
};
