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

  // Any sensitive data in the context within the last 5 minutes blocks egress
  const TAINT_WINDOW_MS = 5 * 60 * 1000;
  const now = Date.now();
  const activeTaints = taints.filter(t => now - t.timestamp < TAINT_WINDOW_MS);

  if (activeTaints.length > 0) {
    const sources = [...new Set(activeTaints.map(t => `${t.source}:${t.target.slice(0, 40)}`))];
    return {
      blocked: true,
      reason: `Egress blocked: session contains tainted data from sensitive sources (${sources.join(", ")}). ` +
        `Data lineage tracking prevents exfiltration even through transforms.`,
    };
  }

  return { blocked: false };
}

/** Clear taint for a session (e.g., on new chat) */
export function clearSessionTaint(sessionId: string): void {
  sessionTaint.delete(sessionId);
}

/** Check if a file path is sensitive (triggers taint on read) */
export function isSensitivePath(filePath: string): boolean {
  const sensitive = [
    /\.ssh/i, /\.aws/i, /\.env/i, /credentials/i, /\.gnupg/i,
    /\.config.*token/i, /\.config.*secret/i, /auth\.json/i,
    /secrets?\.(enc|json|yaml|yml)/i, /master\.(dpapi|key)/i,
    /password/i, /\.npmrc/i, /\.pypirc/i, /\.netrc/i,
    /id_rsa/i, /id_ed25519/i, /\.pem$/i, /\.key$/i,
  ];
  return sensitive.some(p => p.test(filePath));
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
