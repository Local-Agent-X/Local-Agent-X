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
import { scanForSecrets } from "../secret-scanner.js";
import { matchEgressList } from "../security/network-policy.js";
import { getLaxDir } from "../lax-data-dir.js";

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
