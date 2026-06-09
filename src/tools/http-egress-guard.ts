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
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { scanForSecrets } from "../security/secret-scanner.js";
import { matchEgressList } from "../security/network-policy.js";
import { getLaxDir } from "../lax-data-dir.js";
import { isSensitiveAttachmentPath } from "../data-lineage.js";
import { realpathDeep } from "../security/file-access.js";

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

// Max attachment bytes scanned for secret-shaped content. Mirrors the scanner's
// 256KB budget (security/secret-scanner.ts MAX_DECODED_BUDGET, data-lineage's
// SECRET_SCAN_CAP): a secret in the head of a file is caught; a buried key past
// 256KB of a huge attachment is the accepted edge and keeps the regex pass cheap.
const ATTACHMENT_SCAN_CAP = 256 * 1024;

/**
 * Canonicalize an attachment path the SAME way the email tool's resolvePath
 * does (tilde-expand → resolve), then follow every symlink segment via
 * realpathDeep. Used by BOTH the guard (check) and the email tool (read) so the
 * checked inode IS the read inode — no check-path/read-path divergence.
 *
 * Throws on ELOOP (a symlink cycle is an attack) so callers fail closed.
 */
export function canonicalizeAttachmentPath(p: string): string {
  let abs: string;
  if (p === "~") abs = homedir();
  else if (p.startsWith("~/") || p.startsWith("~\\")) abs = resolve(homedir(), p.slice(2));
  else abs = resolve(p);
  return realpathDeep(abs);
}

/**
 * Reject an egress attachment that points at a sensitive file (e.g. ~/.lax
 * secrets, an SSH key, a .env). `paths` is the list of file paths the sink
 * would read+attach (e.g. email_send attachments). Returns null if clean.
 *
 * TOCTOU close (C3-9): the sensitivity predicate runs on the REALPATH, not the
 * supplied string — so a symlink `/tmp/notes.txt → ~/.ssh/id_rsa` is caught
 * because the predicate now sees the real `.ssh` target. A symlink CYCLE
 * (ELOOP) is treated as an attack and blocked. Beyond the path check, the
 * attachment BYTES are streamed through scanForSecrets (C3-9 second leg): a
 * file whose path looks innocent but whose contents are a key is still blocked.
 * Residual window: a swap between this check's realpath and the tool's later
 * read is not closed by realpath alone (would need O_NOFOLLOW+fstat); the email
 * tool re-canonicalizes via the SAME canonicalizeAttachmentPath, so both sides
 * resolve to one inode and the window is the narrow check→read gap only.
 */
export function checkAttachmentPaths(sink: string, paths: readonly string[]): GuardBlock | null {
  const offending: string[] = [];
  for (const p of paths) {
    let real: string;
    try {
      real = canonicalizeAttachmentPath(p);
    } catch (e) {
      // ELOOP (symlink cycle) — realpathDeep only rethrows this. Treat as an
      // attack and refuse the attachment rather than letting the read follow it.
      if ((e as NodeJS.ErrnoException).code === "ELOOP") { offending.push(p); continue; }
      // Any other resolution failure: fall back to the lexical string so a
      // genuinely sensitive literal path is still caught.
      real = p;
    }
    // Check BOTH the realpath (catches a symlink to a sensitive target) and the
    // supplied string (catches a sensitive literal even if it doesn't exist yet).
    if (isSensitiveAttachmentPath(real) || isSensitiveAttachmentPath(p)) { offending.push(p); continue; }

    // Byte scan: the path may be innocent while the CONTENTS are a secret.
    try {
      const buf = readFileSync(real, { flag: "r" });
      const slice = buf.length > ATTACHMENT_SCAN_CAP ? buf.subarray(0, ATTACHMENT_SCAN_CAP) : buf;
      if (!scanForSecrets(slice.toString("utf-8")).clean) { offending.push(p); continue; }
    } catch {
      // Unreadable / not-a-file: the email tool's own readFile will surface the
      // error. We don't block solely on a read failure here.
    }
  }
  if (offending.length === 0) return null;
  return {
    message:
      `Refusing ${sink}: cannot attach sensitive file(s) (${offending.join(", ")}). ` +
      `Credential / secret files (.env, SSH keys, ~/.lax secrets, keychains), symlinks to them, ` +
      `or files whose contents are secret-shaped may not be sent off-box as attachments.`,
    meta: { sink, blocked_by: "sensitive-attachment", paths: offending },
  };
}
