/**
 * Declarative request signing for the connector proxy's `signed` auth type.
 *
 * A `signed` connector manifest expresses an HMAC request-signing scheme as
 * DATA — algorithm, key material, a canonical-string recipe, and where the
 * signature goes — so signed external APIs (Webull, and similar OAuth1-style
 * HMAC schemes) are user-data manifests in `<lax data dir>/connectors/`
 * instead of per-service core code. The recipe vocabulary is fixed and
 * substituted, never evaluated — the agent can configure a signer but can't
 * inject code into the trusted server process.
 *
 * v1 covers the HMAC-over-canonical-string family. Schemes that derive the key
 * (AWS SigV4's region/service chain) or hash in extra rounds (Kraken's
 * SHA256(nonce+body) inside an HMAC-SHA512) are out of scope — they'd extend
 * the part vocabulary here, not fork a new signer.
 *
 * The signer is pure: it takes already-resolved secret values (not the vault)
 * and an injected clock/nonce, so it's deterministic under test.
 */
import { createHmac, createHash } from "node:crypto";

export type SignedAlgorithm = "hmac-sha1" | "hmac-sha256";
export type HashAlgorithm = "md5" | "sha256";
export type Encoding = "base64" | "hex";
export type TimestampFormat = "iso" | "iso-no-ms" | "epoch-ms" | "epoch-s";

/** One segment of the canonical string. Parts that render empty (e.g. a body
 *  hash on a bodyless request) are dropped before joining, so no dangling
 *  separators appear. */
export type CanonicalPart =
  | { kind: "literal"; value: string }
  | { kind: "method" }
  | { kind: "path" }
  | { kind: "query" }
  | { kind: "params"; include?: ("query" | "signedHeaders")[]; sorted?: boolean; lowerKeys?: boolean }
  | { kind: "bodyHash"; algorithm: HashAlgorithm; encoding?: Encoding; upper?: boolean };

export interface SignedAuthConfig {
  type: "signed";
  algorithm: SignedAlgorithm;
  /** Vault secret NAME holding the HMAC key material. */
  secret: string;
  /** Wrap the resolved key material to form the actual HMAC key (Webull: keySuffix "&"). */
  keyPrefix?: string;
  keySuffix?: string;
  /** Signature encoding (default "base64"). */
  encoding?: Encoding;
  /** Headers attached to the outbound request. Values may contain {timestamp},
   *  {nonce}, or {vault:SECRET_NAME}; anything else is a literal. */
  headers?: Record<string, string>;
  /** Header names (matched case-insensitively, plus the synthetic "host") that
   *  a `params` part folds in when its include lists "signedHeaders". */
  signedHeaders?: string[];
  canonical: CanonicalPart[];
  /** Joins the rendered canonical parts (default "&"). */
  separator?: string;
  /** Format for the {timestamp} placeholder (default "iso-no-ms"). */
  timestampFormat?: TimestampFormat;
  signature: { in: "header"; name: string } | { in: "query"; name: string };
}

const ALGOS = new Set<string>(["hmac-sha1", "hmac-sha256"]);
const HASHES = new Set<string>(["md5", "sha256"]);
const ENCODINGS = new Set<string>(["base64", "hex"]);
const TS_FORMATS = new Set<string>(["iso", "iso-no-ms", "epoch-ms", "epoch-s"]);

/** Validate a `signed` auth manifest. Returns an error string, or null if ok. */
export function validateSignedAuth(auth: Record<string, unknown> | undefined): string | null {
  if (!auth) return "missing auth object";
  if (!ALGOS.has(String(auth.algorithm))) return `algorithm must be one of ${[...ALGOS].join(", ")}`;
  if (typeof auth.secret !== "string" || !auth.secret) return "secret (a vault secret name) is required";
  if (auth.encoding !== undefined && !ENCODINGS.has(String(auth.encoding))) return `encoding must be base64 or hex`;
  if (auth.timestampFormat !== undefined && !TS_FORMATS.has(String(auth.timestampFormat))) return `timestampFormat must be one of ${[...TS_FORMATS].join(", ")}`;
  if (auth.keyPrefix !== undefined && typeof auth.keyPrefix !== "string") return "keyPrefix must be a string";
  if (auth.keySuffix !== undefined && typeof auth.keySuffix !== "string") return "keySuffix must be a string";
  if (auth.separator !== undefined && typeof auth.separator !== "string") return "separator must be a string";

  if (auth.headers !== undefined) {
    if (typeof auth.headers !== "object" || auth.headers === null || Array.isArray(auth.headers)) return "headers must be an object";
    for (const [k, v] of Object.entries(auth.headers)) if (typeof v !== "string") return `headers["${k}"] must be a string`;
  }
  if (auth.signedHeaders !== undefined) {
    if (!Array.isArray(auth.signedHeaders) || auth.signedHeaders.some(h => typeof h !== "string")) return "signedHeaders must be an array of header names";
  }

  if (!Array.isArray(auth.canonical) || auth.canonical.length === 0) return "canonical must be a non-empty array of parts";
  for (const part of auth.canonical as Array<Record<string, unknown>>) {
    const kind = part?.kind;
    if (kind === "literal") { if (typeof part.value !== "string") return "canonical literal part requires a string value"; }
    else if (kind === "method" || kind === "path" || kind === "query" || kind === "params") { /* no required subfields */ }
    else if (kind === "bodyHash") { if (!HASHES.has(String(part.algorithm))) return "canonical bodyHash part requires algorithm md5 or sha256"; }
    else return `canonical part has unknown kind ${JSON.stringify(kind)}`;
  }

  const sig = auth.signature as Record<string, unknown> | undefined;
  if (!sig || (sig.in !== "header" && sig.in !== "query")) return `signature.in must be "header" or "query"`;
  if (typeof sig.name !== "string" || !sig.name) return "signature.name is required";
  return null;
}

export interface SignRequestInput {
  config: SignedAuthConfig;
  /** Resolved value of config.secret (the HMAC key material). */
  keyMaterial: string;
  /** Resolved values for every {vault:NAME} referenced by config.headers. */
  vault: Record<string, string>;
  method: string;
  path: string;
  /** url.search with the leading "?" stripped, or "". */
  query: string;
  host: string;
  body?: Buffer;
  now: Date;
  nonce: string;
}

export interface SignResult {
  headers: Record<string, string>;
  /** Present when signature.in === "query": the param to append to the request URL. */
  queryAppend?: { name: string; value: string };
}

function formatTimestamp(now: Date, fmt: TimestampFormat): string {
  switch (fmt) {
    case "iso": return now.toISOString();
    case "epoch-ms": return String(now.getTime());
    case "epoch-s": return String(Math.floor(now.getTime() / 1000));
    case "iso-no-ms": default: return now.toISOString().replace(/\.\d{3}Z$/, "Z");
  }
}

function substitute(template: string, ctx: { timestamp: string; nonce: string; vault: Record<string, string> }): string {
  return template
    .replace(/\{timestamp\}/g, ctx.timestamp)
    .replace(/\{nonce\}/g, ctx.nonce)
    .replace(/\{vault:([^}]+)\}/g, (_m, name: string) => {
      const v = ctx.vault[name];
      if (v === undefined) throw new Error(`signing header references unresolved vault secret "${name}"`);
      return v;
    });
}

export function signRequest(input: SignRequestInput): SignResult {
  const { config, keyMaterial, vault, method, path, query, host, body, now, nonce } = input;
  const timestamp = formatTimestamp(now, config.timestampFormat ?? "iso-no-ms");

  const attached: Record<string, string> = {};
  for (const [name, tmpl] of Object.entries(config.headers ?? {})) {
    attached[name] = substitute(tmpl, { timestamp, nonce, vault });
  }

  // Case-insensitive lookup over attached headers plus the synthetic "host".
  const headerByLower = new Map<string, string>();
  for (const [name, value] of Object.entries(attached)) headerByLower.set(name.toLowerCase(), value);
  headerByLower.set("host", host);

  const renderPart = (part: CanonicalPart): string => {
    switch (part.kind) {
      case "literal": return part.value;
      case "method": return method.toUpperCase();
      case "path": return path;
      case "query": return query;
      case "params": {
        const include = part.include ?? ["query", "signedHeaders"];
        const pairs: Array<[string, string]> = [];
        if (include.includes("query")) for (const [k, v] of new URLSearchParams(query)) pairs.push([k, v]);
        if (include.includes("signedHeaders")) for (const h of config.signedHeaders ?? []) pairs.push([h, headerByLower.get(h.toLowerCase()) ?? ""]);
        const norm = part.lowerKeys ? pairs.map(([k, v]) => [k.toLowerCase(), v] as [string, string]) : pairs;
        if (part.sorted) norm.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
        return norm.map(([k, v]) => `${k}=${v}`).join("&");
      }
      case "bodyHash": {
        if (!body || body.length === 0) return "";
        const digest = createHash(part.algorithm).update(body).digest(part.encoding ?? "hex");
        return part.upper ? digest.toUpperCase() : digest;
      }
    }
  };

  const canonical = config.canonical.map(renderPart).filter(s => s !== "").join(config.separator ?? "&");
  const key = (config.keyPrefix ?? "") + keyMaterial + (config.keySuffix ?? "");
  const hmacAlgo = config.algorithm === "hmac-sha1" ? "sha1" : "sha256";
  const signature = createHmac(hmacAlgo, key).update(canonical, "utf8").digest(config.encoding ?? "base64");

  if (config.signature.in === "query") {
    return { headers: attached, queryAppend: { name: config.signature.name, value: signature } };
  }
  attached[config.signature.name] = signature;
  return { headers: attached };
}
