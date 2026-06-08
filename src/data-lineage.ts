/**
 * Data Lineage Tracker
 *
 * Tracks the flow of data through tool calls within a session.
 * When data is read from a sensitive source, it gets a taint label.
 * If that tainted data flows into an egress channel (http, browser),
 * the call is blocked — even if the data was transformed (base64, chunked, etc).
 *
 * Unlike regex-based detection, this tracks by CALL SEQUENCE:
 *   read(sensitive_file) → bash(any_transform) → http_request = BLOCKED
 *
 * The key insight: any data that entered the LLM context from a sensitive
 * source is tainted for the rest of the run. The LLM can't "un-see" it.
 */

import { homedir } from "node:os";
import { scanForSecrets } from "./security/secret-scanner.js";

export type TaintSource = "sensitive_file" | "secret" | "memory" | "web" | "user_data";

interface TaintEntry {
  source: TaintSource;
  target: string;     // file path, secret name, URL, etc.
  timestamp: number;
  runId: string;
}

// Per-session taint state
const sessionTaint = new Map<string, TaintEntry[]>();

/** Record a sensitive data read */
export function recordSensitiveRead(sessionId: string, source: TaintSource, target: string): void {
  if (!sessionTaint.has(sessionId)) sessionTaint.set(sessionId, []);
  sessionTaint.get(sessionId)!.push({
    source,
    target,
    timestamp: Date.now(),
    runId: sessionId,
  });
}

/** Check if a session has tainted data that should block egress */
export function checkEgressTaint(sessionId: string): { blocked: boolean; reason?: string } {
  const taints = sessionTaint.get(sessionId);
  if (!taints || taints.length === 0) return { blocked: false };

  // STICKY taint: once a session has read sensitive data it stays tainted for
  // the session's life. The recorded timestamp is kept for audit/display only —
  // it does NOT expire the taint (a 5-min decay window silently un-tainted
  // sessions and weakened enforcement; the model can't "un-see" the bytes).
  const sources = [...new Set(taints.map(t => `${t.source}:${t.target.slice(0, 40)}`))];
  return {
    blocked: true,
    reason: `Egress blocked: session contains tainted data from sensitive sources (${sources.join(", ")}). ` +
      `Data lineage tracking prevents exfiltration even through transforms.`,
  };
}

/** Clear taint for a session (e.g., on new chat) */
export function clearSessionTaint(sessionId: string): void {
  sessionTaint.delete(sessionId);
}

// LAX → AriKernel taint-source mapping. The kernel's behavioral deny rules
// (deny-tainted-shell / deny-tainted-http-write) key on the kernel's untrusted-
// content sources ["web","rag","email"]; the kernel also recognizes
// "user-provided" (NOT in the deny set — the user's own input is trusted).
//
// LAX's taint model is COARSER than the kernel's: "the session touched sensitive
// bytes" rather than a fine-grained provenance lattice. So every LAX source that
// represents untrusted-or-sensitive content the model has now seen maps onto a
// kernel source the deny rules recognize, so a sensitive read here lights up the
// kernel's tainted-shell / tainted-egress enforcement. `user_data` is the one
// trusted source and maps to "user-provided" (intentionally outside the deny set).
const KERNEL_TAINT_SOURCE: Record<TaintSource, string> = {
  web: "web",
  memory: "rag",
  sensitive_file: "rag",
  secret: "rag",
  user_data: "user-provided",
};

/**
 * Read the current session's taint as AriKernel taint-source strings, for
 * feeding into ariEvaluate's 4th `taintLabels` arg. STICKY: every recorded
 * sensitive read counts regardless of elapsed time (mirrors checkEgressTaint —
 * a sensitive read keeps the session tainted for its life). Returns deduped
 * kernel sources; [] when the session is clean.
 *
 * This is the bridge between chunk 3's recordSensitiveRead and the kernel's
 * behavioral taint rules: the kernel only blocks tainted shell/egress if it
 * actually receives non-empty taint, and this is where LAX hands it over.
 */
export function getKernelTaintSources(sessionId: string): string[] {
  const taints = sessionTaint.get(sessionId);
  if (!taints || taints.length === 0) return [];
  const sources = new Set<string>();
  for (const t of taints) {
    sources.add(KERNEL_TAINT_SOURCE[t.source]);
  }
  return [...sources];
}

/**
 * Propagate taint from one session into another (parent ← child).
 *
 * When a sub-agent (child session) has read sensitive data, its taint must
 * follow the result back to the parent so the parent's egress / kernel gates
 * see it. Copies ALL of the child's taint entries into the target session
 * (taint is sticky — no active-window filter), preserving the original
 * source/target. recordSensitiveRead re-stamps the timestamp to the
 * propagation moment for audit only. No-op when the child is clean.
 *
 * Returns the number of taint entries propagated (for logging / tests).
 */
export function propagateTaint(fromSessionId: string, toSessionId: string): number {
  if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) return 0;
  const fromTaints = sessionTaint.get(fromSessionId);
  if (!fromTaints || fromTaints.length === 0) return 0;
  let count = 0;
  for (const t of fromTaints) {
    recordSensitiveRead(toSessionId, t.source, t.target);
    count++;
  }
  return count;
}

// Basenames that are credential files regardless of where they live on disk.
// Match is case-insensitive but exact — `secrets.json` matches, `mysecrets.json`
// and `secrets.py` do not.
const SENSITIVE_BASENAMES: ReadonlySet<string> = new Set([
  // Shell / package auth dotfiles.
  ".env", ".envrc", ".npmrc", ".pypirc", ".netrc",
  // SSH private keys (canonical algorithm names).
  "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa",
  // Generic credential / secrets files.
  "auth.json",
  "secrets.json", "secrets.yaml", "secrets.yml", "secrets.toml",
  "credentials.json", "credentials.db",
  // Windows DPAPI-protected master keys (Chromium, etc.).
  "master.dpapi", "master.key",
]);

// Suffix matches for key material containers. Endpoint-anchored, so a
// `notes.key.md` file doesn't trip on `.key`.
const SENSITIVE_EXTENSIONS: ReadonlyArray<string> = [
  ".pem", ".key", ".p12", ".pfx", ".keystore", ".keychain-db",
];

// (parent-directory, basename) pairs. The file is sensitive only when its
// immediate parent directory has the named identity — so `~/.aws/credentials`
// trips, but `~/notes/credentials` does not, and a stray `config` file is
// only flagged inside a known config-dir (.ssh, .aws, .kube).
const DIR_SCOPED_FILES: ReadonlyArray<readonly [string, string]> = [
  [".aws", "credentials"],
  [".aws", "config"],
  [".ssh", "config"],
  [".docker", "config.json"],
  [".kube", "config"],
  // gcloud + gh credential stores live under ~/.config/<tool>/...
  ["gcloud", "credentials.db"],
  ["gcloud", "access_tokens.db"],
  ["gcloud", "legacy_credentials"],
  ["gh", "hosts.yml"],
];

// Directories whose entire contents are credential material. Any file at any
// depth inside one of these is flagged.
const SENSITIVE_DIR_NAMES: ReadonlySet<string> = new Set([".gnupg"]);

function pathSegments(p: string): string[] {
  return p.split(/[\\/]/).filter(Boolean);
}

/**
 * Check if a file path is sensitive (triggers taint on read).
 *
 * Matches by file shape, NOT by substring. The prior implementation used
 * unanchored patterns like `/password/i` and `/credentials/i` that fired on
 * `password_audit.log`, `tokenizer.py`, and any README mentioning secrets —
 * generating enough false positives that users stopped trusting the gate.
 * This version anchors on basename, extension, or known credential-directory
 * locations only.
 */
export function isSensitivePath(filePath: string): boolean {
  if (!filePath) return false;
  const segs = pathSegments(filePath);
  if (segs.length === 0) return false;
  const segsLower = segs.map(s => s.toLowerCase());
  const base = segsLower[segsLower.length - 1];

  if (SENSITIVE_BASENAMES.has(base)) return true;
  // `.env.local`, `.env.production`, etc. Open-ended, so not in the basename set.
  if (base.startsWith(".env.")) return true;
  for (const ext of SENSITIVE_EXTENSIONS) {
    if (base.endsWith(ext)) return true;
  }

  if (segsLower.length >= 2) {
    const parent = segsLower[segsLower.length - 2];
    for (const [dir, name] of DIR_SCOPED_FILES) {
      if (parent === dir && base === name) return true;
    }
  }

  for (const seg of segsLower) {
    if (SENSITIVE_DIR_NAMES.has(seg)) return true;
  }

  return false;
}

/** Get session taint summary */
export function getTaintSummary(sessionId: string): { count: number; sources: string[] } {
  const taints = sessionTaint.get(sessionId) || [];
  return {
    count: taints.length,
    sources: [...new Set(taints.map(t => t.source))],
  };
}

// Shell metacharacters that separate tokens we care about. We intentionally
// keep this conservative — false positives here mean a legitimate http call
// gets blocked, which is worse than missing an exotic obfuscation.
const SHELL_SPLIT_RE = /[\s|<>;()&]+/;

function looksLikePathToken(token: string): boolean {
  if (!token) return false;
  if (token.startsWith("/")) return true;
  if (token.startsWith("~")) return true;
  if (/^[A-Za-z]:[\\/]/.test(token)) return true;
  // Relative or bare token with a separator — only treat as path if it has
  // a dot or recognisable directory segment so things like `echo foo/bar`
  // (no extension, no leading dot) don't false-positive on the `.ssh`
  // pattern when the substring happens to appear.
  if ((token.includes("/") || token.includes("\\")) && /\./.test(token)) return true;
  return false;
}

function stripQuotes(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return token.slice(1, -1);
    }
  }
  return token;
}

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return homedir() + p.slice(1);
  return p;
}

// Max bytes scanned for secrets. Larger inputs are sliced; missed taint on a
// >256KB response is acceptable (rare) and bounded scan keeps the regex pass
// cheap on huge stdout dumps.
const SECRET_SCAN_CAP = 256 * 1024;

// Supplemental secret shapes the CANONICAL catalog (security/credential-patterns.ts
// CREDENTIAL_PATTERNS) does NOT yet cover. The taint/redaction path here used to
// carry its own ~9-pattern set that DRIFTED below the egress guard (scanForSecrets),
// so a Stripe/Supabase/npm/SendGrid key the egress path caught did not taint the
// session. That drift is now gone: detectSecretsInOutput / redactSecretSpans run the
// canonical scanForSecrets (all 27 shapes), and this list only adds the few shapes
// canonical lacks — so the taint path is a strict SUPERSET of both the old inline set
// and the egress guard, with no detection regression.
//
// REMAINING DRIFT (intentional, reported in S1): these four belong in the canonical
// catalog; converging them there is out of scope for S1 (it forbids editing the
// catalog). Until then they live here so Google keys, JWTs, OpenAI project/service
// keys, and bare PEM BEGIN markers still taint.
const SUPPLEMENTAL_SECRET_PATTERNS: ReadonlyArray<{ kind: string; re: RegExp }> = [
  // OpenAI project/service/admin keys: typed prefix then CONTIGUOUS base62 body.
  // Canonical's "OpenAI API Key" (/sk-[a-zA-Z0-9]{20,}/) stops at the `-` after
  // `proj`/`svcacct`/`admin`, so these need their own shape. The contiguous body
  // (no inner `-`/`_`) keeps a hyphenated product slug from false-positiving.
  { kind: "openai-scoped-key", re: /sk-(?:proj|svcacct|admin)-[A-Za-z0-9]{20,}/ },
  // Google API key (AIza…) — not in canonical.
  { kind: "google-key", re: /AIza[0-9A-Za-z_-]{35}/ },
  // JWT (three base64url segments) — not in canonical.
  { kind: "jwt", re: /eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/ },
  // Bare PEM BEGIN marker. Canonical "Private Key (PEM)" requires a matching END
  // block; a truncated/streamed key that shows only the header must still taint.
  { kind: "private-key-block", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/ },
];

/**
 * Scan text (bash stdout, http response body, web fetch body) for secret-shaped
 * substrings. Returns `kinds` (canonical pattern names + the supplemental kinds
 * above) only — NEVER the matched value, so logging the result can't leak the
 * secret. `kinds` is informational (taint-target label / log line); no downstream
 * logic keys on specific strings.
 *
 * Sources its catalog from the canonical scanForSecrets (security/secret-scanner.ts)
 * so taint, redaction and the http egress guard agree on "what is a secret", plus
 * the supplemental shapes canonical doesn't yet cover.
 *
 * Caller responsibility: if `matched` is true, call recordSensitiveRead with
 * source "secret" to taint the session.
 */
export function detectSecretsInOutput(text: string): { matched: boolean; kinds: string[] } {
  if (!text || typeof text !== "string") return { matched: false, kinds: [] };
  const slice = text.length > SECRET_SCAN_CAP ? text.slice(0, SECRET_SCAN_CAP) : text;
  const kinds = new Set<string>();

  for (const m of scanForSecrets(slice).matches) {
    kinds.add(m.pattern);
  }

  for (const { kind, re } of SUPPLEMENTAL_SECRET_PATTERNS) {
    if (re.test(slice)) kinds.add(kind);
  }

  return { matched: kinds.size > 0, kinds: [...kinds] };
}

/**
 * Redact secret-shaped substrings IN PLACE, returning the cleaned text + kinds.
 *
 * Unlike {@link detectSecretsInOutput} (report-only, caller taints the session),
 * this surgically replaces each matched span with `[redacted-secret:<kind>]` so
 * the surrounding content survives. Used for UNTRUSTED INBOUND content
 * (web_fetch / http_request bodies): a secret-shaped span there is coincidental
 * or an injection attempt, not a secret this system owns — so we strip it from
 * the model's view (no echo/exfil) WITHOUT discarding the whole page or tainting
 * egress. Owned-secret reads (local fs / bash / sql) keep the heavier
 * detect→taint→full-redact path.
 */
export function redactSecretSpans(text: string): { text: string; matched: boolean; kinds: string[] } {
  if (!text || typeof text !== "string") return { text: text ?? "", matched: false, kinds: [] };
  // Bounded scan, mirroring detectSecretsInOutput: redact within the cap, pass
  // the tail through unchanged (a missed secret past 256KB is the accepted edge).
  const head = text.length > SECRET_SCAN_CAP ? text.slice(0, SECRET_SCAN_CAP) : text;
  const tail = text.length > SECRET_SCAN_CAP ? text.slice(SECRET_SCAN_CAP) : "";
  const kinds = new Set<string>();

  // Collect every span to redact: canonical scanner spans (all 27 catalog shapes)
  // + the supplemental shapes canonical lacks. Replace end-to-start so earlier
  // replacements don't invalidate later indices.
  const spans: Array<{ start: number; end: number; kind: string }> = [];
  for (const m of scanForSecrets(head).matches) {
    spans.push({ start: m.startIndex, end: m.endIndex, kind: m.pattern });
  }
  for (const { kind, re } of SUPPLEMENTAL_SECRET_PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let match: RegExpExecArray | null;
    while ((match = g.exec(head)) !== null) {
      spans.push({ start: match.index, end: match.index + match[0].length, kind });
    }
  }

  // Drop spans fully contained in an earlier (kept) span so overlapping
  // canonical+supplemental matches don't double-redact the same bytes.
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: typeof spans = [];
  let coveredTo = -1;
  for (const s of spans) {
    if (s.start >= coveredTo) {
      kept.push(s);
      coveredTo = s.end;
    } else if (s.end > coveredTo) {
      // Partial overlap (different pattern extends further): keep, advance cover.
      kept.push(s);
      coveredTo = s.end;
    }
  }

  let out = head;
  for (const s of [...kept].sort((a, b) => b.start - a.start)) {
    kinds.add(s.kind);
    out = out.slice(0, s.start) + `[redacted-secret:${s.kind}]` + out.slice(s.end);
  }
  return { text: out + tail, matched: kinds.size > 0, kinds: [...kinds] };
}

/**
 * Scan a shell command for path-like tokens that match isSensitivePath.
 * Returns matched paths (deduped, original token form post-quote-strip
 * pre-tilde-expansion — callers should re-check with isSensitivePath if
 * they care about the resolved form).
 *
 * Conservative by design: only fires on tokens that clearly look like
 * filesystem paths (leading `/`, `~`, drive letter, or separator+dot).
 */
export function extractSensitivePathsFromCommand(command: string): string[] {
  if (!command) return [];
  const seen = new Set<string>();
  const matches: string[] = [];
  for (const raw of command.split(SHELL_SPLIT_RE)) {
    if (!raw) continue;
    // Strip a trailing `>` or `,` that some shells leave attached; we already
    // split on most metachars but redirects like `2>file` split to `file`.
    const token = stripQuotes(raw);
    if (!looksLikePathToken(token)) continue;
    const expanded = expandTilde(token);
    if (!isSensitivePath(expanded)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    matches.push(token);
  }
  return matches;
}
