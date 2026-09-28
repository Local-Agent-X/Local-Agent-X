/**
 * Data Lineage — sensitive-path & secret detection (stateless)
 *
 * The shape-based classifiers that decide whether a file path is sensitive
 * (read-taint or attachment sink), whether text contains secret-shaped spans,
 * and how to redact them. Pure functions — no per-session state lives here;
 * callers feed results into the taint registry (taint.ts).
 */

import { homedir } from "node:os";
import { scanForSecrets } from "../security/secrets/index.js";
import { isAppAtRestSecretBasename } from "../security/secrets/index.js";
import { classifySensitivePath } from "../security/layer/index.js";
import { commandPositions, type CommandPosition } from "../security/layer/shell-command-positions.js";
import { getLaxDir } from "../lax-data-dir.js";

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
  const base = segs[segs.length - 1].toLowerCase();

  // The shared credential-file catalog (security/sensitive-paths.ts) owns the
  // basename / `.env.` / extension / dir-scoped / cred-dir SHAPE checks — the ONE
  // source of truth the file-access gate (matchesSensitivePath) also consumes, so
  // the gate stays a provable superset of this taint classifier.
  if (classifySensitivePath(filePath)) return true;
  // The app's OWN at-rest key/seed/vault files (audit-key, audit-key.enc,
  // secrets.salt, secrets.enc, master.*, auth.json). Derived from the ONE
  // canonical set in security/known-secrets.ts so the read-taint classifier
  // can't drift from the write-block / attachment-denylist. These basenames are
  // specific enough that matching them anywhere is not a taint-storm risk.
  // Kept here (not in the shared catalog) because each caller scopes it
  // differently (the file gate requires a `.lax` data-dir segment).
  if (isAppAtRestSecretBasename(base)) return true;

  return false;
}

// --- Egress-attachment sink: stricter than the read-taint predicate above ---
//
// `isSensitivePath` is the READ-TAINT predicate: reading a matching file taints
// the session. It is deliberately NARROW (anchored basenames / extensions /
// known cred-dir pairs) because over-flagging there causes taint storms —
// the app reads its own `.lax` data dir and routine `.enc`/key files constantly,
// and tainting on each would block every subsequent egress. The existing spec
// table even encodes that `.ssh/known_hosts`, `.ssh/*.pub`, etc. are NOT tainted.
//
// The email-attachment sink has the opposite risk profile: a file is read AND
// shipped off-box, so a miss is an exfiltration. Here we err toward blocking.
// This predicate is a SUPERSET of `isSensitivePath` plus whole-directory rules
// for the app's own secrets dir and common credential stores. It is used ONLY by
// the attachment guard (http-egress-guard.ts), never for read-taint.

// Directories whose entire contents are off-limits to attach. Any file at any
// depth inside one of these is sensitive for the attachment sink.
// `.lax` (the app's own secrets/vault dir) plus the canonical credential stores.
const ATTACHMENT_SENSITIVE_DIR_NAMES: ReadonlySet<string> = new Set([
  // NOTE: the LAX data dir (.lax / a relocated LAX_DATA_DIR) is intentionally
  // NOT here — it's handled by the laxBase rule below so the uploads/ and
  // workspace/ content-subdir carve-out applies in ONE place. Listing .lax here
  // too would short-circuit that carve-out and re-block user photos.
  ".gnupg", ".ssh", ".aws",
  // gcloud config dir holds ADC, legacy_credentials, db token stores — the whole
  // tree is off-limits as an attachment (stricter than read-taint, which only
  // flags the specific known stores to avoid tainting benign gcloud config).
  "gcloud",
  // sops age key dir + rclone config dir.
  "age", "rclone",
]);

// Basenames/extensions that signal an encrypted vault or key container and must
// never leave as an attachment. Supplements SENSITIVE_EXTENSIONS (.pem/.key/...).
const ATTACHMENT_SENSITIVE_EXTENSIONS: ReadonlyArray<string> = [".enc"];

// Inside `.ssh`, these are low-risk and may be attached (host fingerprints,
// public keys). Everything else under `.ssh` is a potential private key with an
// arbitrary filename, so it is blocked. NB: `.ssh/config` is intentionally NOT
// listed — `isSensitivePath` already flags it (DIR_SCOPED_FILES), and it can
// reference IdentityFile/ProxyCommand secrets, so blocking it is correct.
const SSH_BENIGN_BASENAMES: ReadonlySet<string> = new Set([
  "known_hosts", "known_hosts.old", "authorized_keys",
]);

/**
 * Stricter sensitive-path check for the egress-attachment sink (email_send
 * attachments, etc.). Returns true if attaching this file would ship credential
 * or secret material off-box.
 *
 * Superset of {@link isSensitivePath}, plus:
 *  - any file under `.ssh` / `.aws` / `.lax` / `.gnupg` (whole-dir), EXCEPT a
 *    short allowlist of benign `.ssh` files (`known_hosts`, `config`, `*.pub`);
 *  - the resolved LAX data dir basename, so a relocated `LAX_DATA_DIR` (a dir not
 *    literally named `.lax`) is still covered;
 *  - `.enc` containers (e.g. the `secrets.enc` vault).
 *
 * Segment-based matching, so `~/.lax/secrets.enc`, `/Users/x/.lax/secrets.enc`,
 * and a `LAX_DATA_DIR`-relocated dir all resolve identically — a leading `~`
 * does not need expansion to match a directory-name segment.
 */
export function isSensitiveAttachmentPath(filePath: string): boolean {
  if (!filePath) return false;
  // The narrow read-taint predicate already covers the anchored cases
  // (.env, id_rsa, *.pem, .aws/credentials, .gnupg/*, ...).
  if (isSensitivePath(filePath)) return true;

  const segs = pathSegments(filePath);
  if (segs.length === 0) return false;
  const segsLower = segs.map(s => s.toLowerCase());
  const base = segsLower[segsLower.length - 1];

  // Whole-directory rules. `.ssh` is handled separately (benign-file allowlist).
  for (const seg of segsLower) {
    if (seg === ".ssh") {
      if (base.endsWith(".pub")) return false;
      if (SSH_BENIGN_BASENAMES.has(base)) return false;
      return true;
    }
    if (ATTACHMENT_SENSITIVE_DIR_NAMES.has(seg)) return true;
  }

  // The LAX data dir holds the app's secrets (config.json's authToken, auth.json,
  // keypair, memory), so files under it are sensitive by default — EXCEPT two
  // content subdirs that exist to be USED and sent off-box: `uploads/` (photos a
  // paired device attached) and `workspace/` (media the agent generates). The
  // blanket rule was false-blocking those as "sensitive attachments", which
  // bricked generate_video-from-a-photo and sending an image over WhatsApp/
  // Telegram. Specific secret files anywhere (auth.json, *.pem, secrets.enc) are
  // still caught by isSensitivePath above + the attachment byte-scan, so
  // exempting these two dirs loses no real coverage.
  const laxBase = pathSegments(getLaxDir()).pop()?.toLowerCase();
  const laxIdx = laxBase ? segsLower.indexOf(laxBase) : -1;
  if (laxIdx >= 0) {
    const sub = segsLower[laxIdx + 1];
    if (sub !== "uploads" && sub !== "workspace") return true;
  }

  // Encrypted vault containers (e.g. secrets.enc).
  for (const ext of ATTACHMENT_SENSITIVE_EXTENSIONS) {
    if (base.endsWith(ext)) return true;
  }

  return false;
}

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

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return homedir() + p.slice(1);
  return p;
}

// Max bytes scanned for secrets. Larger inputs are sliced; missed taint on a
// >256KB response is acceptable (rare) and bounded scan keeps the regex pass
// cheap on huge stdout dumps. Shared with the value masker (secret-values.ts)
// so detection and masking cover the same head of a large output.
export const SECRET_SCAN_CAP = 256 * 1024;

/**
 * Scan text (bash stdout, http response body, web fetch body) for secret-shaped
 * substrings. Returns `kinds` (canonical pattern names) only — NEVER the matched
 * value, so logging the result can't leak the secret. `kinds` is informational
 * (taint-target label / log line); no downstream logic keys on specific strings.
 *
 * A pure adapter over the canonical scanForSecrets (security/secret-scanner.ts):
 * taint, redaction and the http egress guard share ONE catalog
 * (credential-patterns.ts) so they can never drift on "what is a secret". The
 * former supplemental set (Google/OpenAI-scoped keys, JWTs, bare PEM markers)
 * now lives in that catalog.
 *
 * Caller responsibility: if `matched` is true, call recordSensitiveRead with
 * source "secret" to taint the session.
 */
export function detectSecretsInOutput(text: string): { matched: boolean; kinds: string[]; structured: boolean } {
  if (!text || typeof text !== "string") return { matched: false, kinds: [], structured: false };
  const slice = text.length > SECRET_SCAN_CAP ? text.slice(0, SECRET_SCAN_CAP) : text;
  const kinds = new Set<string>();
  let structured = false;

  for (const m of scanForSecrets(slice).matches) {
    kinds.add(m.pattern);
    // `structured` = a real credential SHAPE (API-key/PEM/JWT/known stored value)
    // — high confidence. The high-entropy pass is a deliberately-loose catch-all
    // for UNKNOWN secrets; it also fires on long camelCase identifiers and hashes
    // in ordinary source. Callers that gate a heavy response (tainting + shell
    // block) should key on `structured`, not `matched`, so a coincidental
    // identifier can't brick a benign read. `matched` stays for outbound/egress
    // scanning, where any secret-shaped span — even coincidental — must be caught.
    if (m.type !== "high-entropy-token") structured = true;
  }

  return { matched: kinds.size > 0, kinds: [...kinds], structured };
}

// Commands whose output never carries a byte of their path operands' CONTENTS:
// they answer about the name (exists, ignored, size, type, tracked) or move,
// create, remove or re-permission the file. Every other command word — cat,
// head, sed, awk, openssl, an interpreter, an unknown binary — is taken to
// read the operand. `git check-ignore -v .env` names the file; it does not
// read it, and on 2026-09-28 naming it withheld the whole of a three-command
// output that held no credential byte.
const NAME_ONLY_BINS: ReadonlySet<string> = new Set([
  "ls", "dir", "test", "[", "stat", "file", "du", "find", "realpath", "readlink", "dirname", "basename",
  "touch", "chmod", "chown", "chgrp", "mkdir", "rmdir", "rm", "unlink", "echo", "printf", "wc",
  "which", "where", "whereis",
]);
const GIT_NAME_ONLY: ReadonlySet<string> = new Set([
  "check-ignore", "ls-files", "add", "rm", "mv", "status", "restore", "checkout", "update-index", "check-attr",
]);
// A shell's operands are the body it re-parses (walked as its own positions)
// or a script to run; the shell itself prints nothing of them.
const SHELL_BINS: ReadonlySet<string> = new Set(["bash", "sh", "zsh", "dash", "ksh", "ash", "cmd", "powershell", "pwsh"]);
const GREP_BINS: ReadonlySet<string> = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack"]);
// grep prints matching LINES unless one of these makes it print names or counts.
const GREP_NAME_ONLY_FLAGS = /^(?:-[a-zA-Z]*[lLcq][a-zA-Z]*|--files-with(?:out)?-match(?:es)?|--count|--quiet|--silent)$/;

function readsOperands(p: CommandPosition): boolean {
  const args = p.words.slice(p.at + 1);
  if (NAME_ONLY_BINS.has(p.bin) || SHELL_BINS.has(p.bin)) return false;
  if (p.bin === "git") {
    const sub = args.find((a) => !a.startsWith("-"));
    return !(sub !== undefined && GIT_NAME_ONLY.has(sub));
  }
  if (GREP_BINS.has(p.bin)) return !args.some((a) => GREP_NAME_ONLY_FLAGS.test(a));
  return true;
}

/**
 * The sensitive paths a shell command READS: path-shaped operands (leading
 * `/`, `~`, drive letter, or separator+dot) of a command position whose output
 * can carry the file's bytes, plus any `< path` stdin redirect. A path that is
 * only NAMED — the operand of a query command like `git check-ignore`, `ls`,
 * `test -f`, `grep -l`, or a `> path` write target — is not a read. Walks the
 * same command positions the shell rules read, so a `bash -c "cat …"` body is
 * seen too. Returns the operands as written (quotes removed, `~` unexpanded),
 * deduped.
 */
export function sensitivePathsReadByCommand(command: string): string[] {
  if (!command) return [];
  const seen = new Set<string>();
  const matches: string[] = [];
  const consider = (token: string) => {
    const bare = token.replace(/^\(+/, "").replace(/\)+$/, "");
    if (!looksLikePathToken(bare)) return;
    if (!isSensitivePath(expandTilde(bare))) return;
    if (seen.has(bare)) return;
    seen.add(bare);
    matches.push(bare);
  };
  for (const p of commandPositions(command).positions) {
    const reads = readsOperands(p);
    let nextIsStdin = false;
    for (const word of p.words.slice(p.at + 1)) {
      if (nextIsStdin) { consider(word); nextIsStdin = false; continue; }
      const redirect = /^(\d*)(<+|>+)&?(.*)$/.exec(word);
      if (redirect) {
        if (redirect[2].startsWith("<") && !redirect[3].startsWith("&")) {
          if (redirect[3]) consider(redirect[3]);
          else nextIsStdin = true;
        }
        continue; // a `>` target is written, never read; `2>&1` names no file
      }
      if (reads) consider(word);
    }
  }
  return matches;
}
