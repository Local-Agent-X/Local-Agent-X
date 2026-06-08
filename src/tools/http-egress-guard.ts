/**
 * Outbound egress guard for http_request.
 *
 * Enforces two tool-layer checks that complement the network-layer
 * SecurityLayer (SSRF/private-IP/cloud-metadata):
 *
 *   1. GET/HEAD body rejection — RFC 9110 §9.3.1/9.3.2. A body on GET/HEAD
 *      is a data-exfiltration vector (smuggling past URL-only logging).
 *
 *   2. Outbound secret-shape scan — scans pre-resolution body and header
 *      values for hardcoded credentials (model-emitted, possibly from a
 *      prompt-injected web page). Blocks unless the destination host is in
 *      the trusted-destinations list (~/.lax/egress-allowlist.json).
 *      {{SECRET_NAME}} placeholders are not secret-shaped so they pass
 *      cleanly; the secrets store resolves them only after this gate.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scanForSecrets } from "../security/secret-scanner.js";
import { matchEgressList } from "../security/network-policy.js";
import { getLaxDir } from "../lax-data-dir.js";
import { isSensitiveAttachmentPath } from "../data-lineage.js";

let trustedDestinationsCache: { fingerprint: number; set: Set<string> } | null = null;

function loadTrustedDestinations(): Set<string> {
  const path = join(getLaxDir(), "egress-allowlist.json");
  if (!existsSync(path)) {
    trustedDestinationsCache = null;
    return new Set();
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const fingerprint = raw.length;
    if (trustedDestinationsCache && trustedDestinationsCache.fingerprint === fingerprint) {
      return trustedDestinationsCache.set;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    const set = new Set<string>(parsed.map((d: unknown) => String(d).toLowerCase()));
    trustedDestinationsCache = { fingerprint, set };
    return set;
  } catch {
    return new Set();
  }
}

export interface GuardArgs {
  url: string;
  method: string;
  body?: unknown;
  headers?: unknown;
}

export interface GuardBlock {
  message: string;
  meta: Record<string, unknown>;
}

/** Returns null if the call may proceed, or a GuardBlock describing the refusal. */
export function checkOutboundRequest(args: GuardArgs): GuardBlock | null {
  const { url, method } = args;

  if ((method === "GET" || method === "HEAD") && args.body) {
    return {
      message:
        `HTTP ${method} requests must not have a body — bodies on GET/HEAD are a data-exfiltration vector. ` +
        `Use POST/PUT/PATCH for requests that carry data.`,
      meta: { url, method, blocked_by: "get-head-body-forbidden" },
    };
  }

  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;

  const preScanParts: string[] = [];
  if (args.body) preScanParts.push(String(args.body));
  if (args.headers && typeof args.headers === "object") {
    for (const v of Object.values(args.headers as Record<string, unknown>)) {
      preScanParts.push(String(v));
    }
  }
  const preScanText = preScanParts.join("\n");
  if (!preScanText) return null;

  const scan = scanForSecrets(preScanText);
  if (scan.clean) return null;

  let targetHost = "";
  try { targetHost = new URL(url).hostname.toLowerCase(); } catch { /* invalid URL handled upstream */ }

  const trusted = loadTrustedDestinations();
  if (targetHost && matchEgressList(targetHost, trusted)) return null;

  const kinds = [...new Set(scan.matches.map(m => m.pattern))].join(", ");
  return {
    message:
      `Refusing ${method} to ${targetHost || url}: request contains secret-shaped content (${kinds}) ` +
      `and the destination is not in the trusted-destinations list. ` +
      `If this destination should receive credentials, add it to ~/.lax/egress-allowlist.json. ` +
      `For stored secrets prefer {{SECRET_NAME}} placeholders over hardcoded values.`,
    meta: { url, method, blocked_by: "outbound-secret-scan", secret_kinds: kinds },
  };
}

/**
 * Generic outbound-secret scan for NON-http egress sinks (email_send body,
 * clipboard_write content, process_start command/args, browser navigation data,
 * ari_http body). Mirrors the secret-shape half of {@link checkOutboundRequest}
 * but without an HTTP destination: there is no per-host allowlist to fall back
 * on, so any secret-shaped span is refused — these channels can't carry an
 * exfiltration allowlist exemption. `sink` names the egress tool for the message.
 *
 * Returns null if the payload may proceed. `{{SECRET_NAME}}` placeholders are not
 * secret-shaped, so they pass cleanly (the secrets store resolves them later).
 */
export function checkOutboundPayload(sink: string, text: string): GuardBlock | null {
  if (!text) return null;
  const scan = scanForSecrets(text);
  if (scan.clean) return null;
  const kinds = [...new Set(scan.matches.map(m => m.pattern))].join(", ");
  return {
    message:
      `Refusing ${sink}: outbound payload contains secret-shaped content (${kinds}). ` +
      `This channel can carry data off-box and has no destination allowlist, so credentials may not leave through it. ` +
      `Prefer {{SECRET_NAME}} placeholders over hardcoded values, or remove the credential from the payload.`,
    meta: { sink, blocked_by: "outbound-secret-scan", secret_kinds: kinds },
  };
}

/**
 * Reject an egress attachment that points at a sensitive file (e.g. ~/.lax
 * secrets, an SSH key, a .env). `paths` is the list of file paths the sink
 * would read+attach (e.g. email_send attachments). Returns null if clean.
 */
export function checkAttachmentPaths(sink: string, paths: readonly string[]): GuardBlock | null {
  const offending = paths.filter(p => isSensitiveAttachmentPath(p));
  if (offending.length === 0) return null;
  return {
    message:
      `Refusing ${sink}: cannot attach sensitive file(s) (${offending.join(", ")}). ` +
      `Credential / secret files (.env, SSH keys, ~/.lax secrets, keychains) may not be sent off-box as attachments.`,
    meta: { sink, blocked_by: "sensitive-attachment", paths: offending },
  };
}
