/**
 * Outbound egress guard for http_request.
 *
 * Enforces two tool-layer checks that complement the network-layer
 * SecurityLayer (SSRF/private-IP/cloud-metadata):
 *
 *   1. GET/HEAD body rejection — RFC 9110 §9.3.1/9.3.2. A body on GET/HEAD
 *      is a data-exfiltration vector (smuggling past URL-only logging).
 *
 *   2. Outbound secret-shape scan — scans the pre-resolution URL, body, and
 *      header values (every method — a GET query string is the classic exfil
 *      vector) for hardcoded credentials (model-emitted, possibly from a
 *      prompt-injected web page). Blocks unless the destination host is in
 *      the trusted-destinations list (~/.lax/egress-allowlist.json).
 *      {{SECRET_NAME}} placeholders are not secret-shaped so they pass
 *      cleanly; the secrets store resolves them only after this gate.
 */

import { existsSync, readFileSync } from "node:fs";
import { containsNulByte } from "../binary-sniff.js";
import { join } from "node:path";
import { scanForSecrets, decodedPayloadViews } from "../security/secrets/index.js";
import { outboundPayloadParts } from "../security/secrets/index.js";
import { matchEgressList } from "../security/layer/index.js";
import { classifyData } from "../threat/classification.js";
import { loadDataEgressGuard } from "../security/layer/index.js";
import { getLaxDir } from "../lax-data-dir.js";
import { getOwnEmailAddresses } from "./email-config.js";
import { isSensitiveAttachmentPath } from "../data-lineage/index.js";
import { realpathDeep } from "../security/layer/index.js";
import { destinationSpecsOf } from "../tool-registry.js";
import { resolveAgentPath } from "../workspace/paths.js";
import { unvouchedSecretMatches } from "../browser/site-provenance.js";

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
  /** True when the refusal may be downgraded to an interactive user
   *  confirmation instead of a hard block: the payload is suspicious only
   *  because the destination is unrecognized, and a human vouching for the
   *  destination resolves exactly that doubt. Silent (unattended) runs still
   *  hard-block — an approval with no one watching is a block. */
  confirmable?: boolean;
}

/** Returns null if the call may proceed, or a GuardBlock describing the refusal.
 *  `vouchedToken` clears an entropy-heuristic hit the destination's own site
 *  showed (site-provenance.ts vouchedFor). */
export function checkOutboundRequest(args: GuardArgs, vouchedToken?: (token: string) => boolean): GuardBlock | null {
  const { url, method } = args;

  if ((method === "GET" || method === "HEAD") && args.body) {
    return {
      message:
        `HTTP ${method} requests must not have a body — bodies on GET/HEAD are a data-exfiltration vector. ` +
        `Use POST/PUT/PATCH for requests that carry data.`,
      meta: { url, method, blocked_by: "get-head-body-forbidden" },
    };
  }

  // Scan the FULL wire bytes — URL included — for EVERY method (SC-2). A secret
  // in a GET query string is the classic exfil vector: without a pre-flight URL
  // scan the request leaves before the threat tool-chain's post-execution audit
  // sees it, and a POST URL can carry a query-string secret just like its body.
  // includeUrl=true keeps this byte set identical to the exfil analyzer's
  // (egressPayload's http_request case: url + body + header values).
  const preScanText = outboundPayloadParts(args, { includeUrl: true });
  if (!preScanText) return null;

  const matches = unvouchedSecretMatches(preScanText, vouchedToken);
  if (matches.length > 0) {
    if (isTrustedDestination(url)) return null;
    const kinds = [...new Set(matches.map(m => m.pattern))].join(", ");
    return {
      message:
        `Refusing ${method} to ${hostOf(url) || url}: request contains secret-shaped content (${kinds}) ` +
        `and the destination is not in the trusted-destinations list. ` +
        `If this destination should receive credentials, ask the user to allow the host in Settings → Security → Web access. ` +
        `For stored secrets prefer {{SECRET_NAME}} placeholders over hardcoded values.`,
      meta: { url, method, blocked_by: "outbound-secret-scan", secret_kinds: kinds },
    };
  }

  // Opt-in financial-data egress guard: clean of credentials, but the payload
  // carries financial-account data (IBAN / card) — block to non-allowlisted hosts.
  if (loadDataEgressGuard() && hasSensitiveEgressData(preScanText) && !isTrustedDestination(url)) {
    return {
      message:
        `Refusing ${method} to ${hostOf(url) || url}: payload contains sensitive personal data ` +
        `(financial account or SSN) and the destination is not in the trusted-destinations list. ` +
        `If it should receive this data, ask the user to allow the host in Settings → Security → Web access.`,
      meta: { url, method, blocked_by: "data-egress-guard", data_labels: ["financial", "ssn"] },
    };
  }
  return null;
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

export function isTrustedDestination(url: string): boolean {
  const host = hostOf(url);
  return !!host && matchEgressList(host, loadTrustedDestinations());
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
export function checkOutboundPayload(
  sink: string,
  text: string,
  /** Clears an entropy-heuristic hit the caller can vouch for (browser: the
   *  destination's own site showed the agent that string). Never consulted for
   *  a known secret value or a known key format. */
  vouchedToken?: (token: string) => boolean,
): GuardBlock | null {
  if (!text) return null;
  const matches = unvouchedSecretMatches(text, vouchedToken);
  if (matches.length > 0) {
    const kinds = [...new Set(matches.map(m => m.pattern))].join(", ");
    return {
      message:
        `Refusing ${sink}: outbound payload contains secret-shaped content (${kinds}). ` +
        `This channel can carry data off-box and has no destination allowlist, so credentials may not leave through it. ` +
        `Prefer {{SECRET_NAME}} placeholders over hardcoded values, or remove the credential from the payload.`,
      meta: { sink, blocked_by: "outbound-secret-scan", secret_kinds: kinds },
    };
  }

  // Opt-in financial-data egress guard. No destination allowlist on these
  // channels, so financial-account data may not leave through them at all.
  if (loadDataEgressGuard() && hasSensitiveEgressData(text)) {
    return {
      message:
        `Refusing ${sink}: outbound payload contains sensitive personal data (financial account or SSN). ` +
        `This off-box channel has no destination allowlist, so this data may not leave through it.`,
      meta: { sink, blocked_by: "data-egress-guard", data_labels: ["financial", "ssn"] },
    };
  }
  return null;
}

/** Split a comma-separated recipient header into bare lowercase addresses,
 *  unwrapping `Name <addr@host>` display forms. */
export function parseRecipientAddresses(raw: string): string[] {
  const out: string[] = [];
  for (const token of raw.split(",")) {
    const angled = /<([^<>]+)>/.exec(token);
    const addr = (angled ? angled[1] : token).trim().toLowerCase();
    if (addr.includes("@")) out.push(addr);
  }
  return out;
}

export function isTrustedEmailRecipient(addr: string, own: ReadonlySet<string>): boolean {
  if (own.has(addr)) return true;
  const trusted = loadTrustedDestinations();
  // An allowlist entry containing "@" is an exact address; a bare entry is a
  // domain and matches the recipient's domain with the SAME semantics the
  // host allowlist uses (exact / *.wildcard) — "gmail.com" in the allowlist
  // already means "trusted egress destination", for mailboxes as for hosts.
  if (trusted.has(addr)) return true;
  const domain = addr.slice(addr.lastIndexOf("@") + 1);
  const hostEntries = new Set([...trusted].filter((e) => !e.includes("@")));
  return !!domain && matchEgressList(domain, hostEntries);
}

/** A send's recipient fields (to, cc, bcc, ...), each a comma-separated list. */
type EmailRecipients = Readonly<Record<string, string | undefined>>;

/** The recipient fields a `recipients` destination names, read off the call. */
export function recipientFields(argNames: readonly string[], args: Record<string, unknown>): EmailRecipients {
  return Object.fromEntries(argNames.map((a) => [a, args[a] == null ? "" : String(args[a])]));
}

function sortRecipients(recipients: EmailRecipients): { addrs: string[]; untrusted: string[] } {
  const addrs = Object.values(recipients).flatMap((field) => parseRecipientAddresses(field ?? ""));
  const own = new Set(getOwnEmailAddresses());
  return { addrs, untrusted: addrs.filter((a) => !isTrustedEmailRecipient(a, own)) };
}

/**
 * Whether this send goes only to destinations the user trusts, the way the
 * guard below judges them: an allowlisted site destination's host on the
 * allowlist (http_request), a recipients destination whose every recipient is
 * the user's own address or allowlisted (email_send). The other off-box
 * channels have no allowlist, so none of their sends is trusted. The threat
 * engine reads it after the call ran, so a send the guard cleared for its
 * destination is not re-judged as exfiltration.
 */
export function isTrustedSend(toolName: string, args: Record<string, unknown>): boolean {
  const specs = destinationSpecsOf(toolName, args);
  if (!specs || specs.length === 0) return false;
  return specs.every((spec) => {
    if (spec.to === "site") return spec.allowlisted === true && isTrustedDestination(String(args[spec.arg] ?? ""));
    if (spec.to !== "recipients") return false;
    const { addrs, untrusted } = sortRecipients(recipientFields(spec.args, args));
    return addrs.length > 0 && untrusted.length === 0;
  });
}

/**
 * Destination-aware outbound scan for email_send — the email analogue of
 * {@link checkOutboundRequest}. Unlike the destination-less
 * {@link checkOutboundPayload}, an email HAS destinations (its recipients), so
 * the same trusted-destination logic applies: the account's OWN address
 * (getOwnEmailAddresses — sending to yourself is delivery, not exfiltration)
 * and ~/.lax/egress-allowlist.json entries pass without question. A flagged
 * payload to an unrecognized recipient returns a CONFIRMABLE block: the gate
 * downgrades it to an interactive approval, because "is this stranger meant to
 * receive this?" is precisely the question a human can answer and a scanner
 * cannot. Recipients must ALL be trusted — one attacker cc on a self-send is
 * still exfiltration.
 */
export function checkOutboundEmail(
  recipients: EmailRecipients,
  text: string,
): GuardBlock | null {
  if (!text) return null;
  const scan = scanForSecrets(text);
  const financial = loadDataEgressGuard() && hasSensitiveEgressData(text);
  if (scan.clean && !financial) return null;

  const { addrs, untrusted } = sortRecipients(recipients);
  if (addrs.length > 0 && untrusted.length === 0) return null;

  const kinds = scan.clean ? "" : [...new Set(scan.matches.map((m) => m.pattern))].join(", ");
  const what = scan.clean
    ? "sensitive personal data (financial account or SSN)"
    : `secret-shaped content (${kinds})`;
  const dest = untrusted.length > 0 ? untrusted.join(", ") : "no parseable recipient";
  return {
    message:
      `email_send to ${dest}: the message content contains ${what} and the recipient is not a ` +
      `trusted destination (your own address and the sites allowed in Settings → Security → Web access are trusted). ` +
      `Confirm the send only if these recipients are meant to receive this content; otherwise remove it. ` +
      `A recipient's domain that should always receive such data can be allowed in Settings → Security → Web access.`,
    meta: {
      sink: "email_send",
      blocked_by: scan.clean ? "data-egress-guard" : "outbound-secret-scan",
      ...(kinds ? { secret_kinds: kinds } : {}),
      untrusted_recipients: untrusted,
    },
    confirmable: true,
  };
}

// US SSN (with separators — bare 9-digit runs are too false-positive-prone).
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/;

// High-confidence sensitive-identifier detection for the egress guard, across the
// SAME decoded views the secret scanner uses (raw + base64/hex/normalized) so an
// encoded value can't slip past. Scope is deliberately narrow to control false
// positives: financial-account data (IBAN/card) + SSN. It does NOT gate email
// addresses or phone numbers — those appear in legitimate outbound comms (every
// email_send has a recipient), so blocking them would break normal use.
function hasSensitiveEgressData(text: string): boolean {
  return decodedPayloadViews(text).some((v) => classifyData(v).labels.includes("financial") || SSN_RE.test(v));
}

// Max attachment bytes scanned for secret-shaped content. Mirrors the scanner's
// 256KB budget (security/secret-scanner.ts MAX_DECODED_BUDGET, data-lineage's
// SECRET_SCAN_CAP): a secret in the head of a file is caught; a buried key past
// 256KB of a huge attachment is the accepted edge and keeps the regex pass cheap.
const ATTACHMENT_SCAN_CAP = 256 * 1024;

/**
 * Canonicalize an attachment path with the canonical agent-path resolver and
 * the calling session — the resolution the file-access gate judged — then
 * follow every symlink segment via realpathDeep. Used by BOTH the guard (check)
 * and the email tool (read) so the checked inode IS the read inode — no
 * check-path/read-path divergence. A relative path used to resolve against the
 * server's cwd, so the gate approved one file and the guard scanned and the
 * tool sent another.
 *
 * Throws on ELOOP (a symlink cycle is an attack) so callers fail closed.
 */
export function canonicalizeAttachmentPath(p: string, sessionId: string | undefined): string {
  return realpathDeep(resolveAgentPath(p, sessionId));
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
// Binary-content sniff — same heuristic the read tool uses (read-write-tools.ts):
// a binary file almost always has a NUL byte in its head, a text file almost
// never does. Scan a bounded head so a large attachment stays cheap.
function isProbablyBinary(buf: Buffer): boolean {
  return containsNulByte(buf);
}

export function checkAttachmentPaths(sink: string, paths: readonly string[], sessionId: string | undefined): GuardBlock | null {
  const offending: string[] = [];
  for (const p of paths) {
    let real: string;
    try {
      real = canonicalizeAttachmentPath(p, sessionId);
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
      // Only TEXT content can carry a text-shaped secret (PEM key, .env line,
      // JSON service-account key). A BINARY file (png/jpg/mp4/pdf/zip) decoded as
      // utf-8 is high-entropy noise that the scanner's entropy pass flags on EVERY
      // attach — a guaranteed false positive that bricks view_image / screen_capture
      // / send_video / email_send-of-an-image. Binary secret CONTAINERS (.enc vault,
      // keystores) are caught by the PATH leg above (extension/dir), not by scanning
      // their opaque bytes, so skipping the text scan here loses no real coverage.
      if (!isProbablyBinary(slice) && !scanForSecrets(slice.toString("utf-8")).clean) {
        offending.push(p); continue;
      }
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
