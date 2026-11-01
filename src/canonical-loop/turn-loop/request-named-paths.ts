/**
 * The paths a request names, read once for every check that keys off them:
 * the done-claim audit's evidence (spec-audit.ts namedPathEvidence) and the
 * per-turn digest's missing-files line (situational-awareness.ts).
 *
 * The raw reading is generous: any slash-joined token, so the audit sees a
 * relative path like `src/app.ts`. That also catches prose ("cost/latency",
 * "donor/acceptor"), which the audit tolerates as evidence but which a line
 * saying "not on disk" would misreport, so the missing-files reading keeps only
 * the file-shaped ones (isFileShaped).
 */
import { existsSync } from "node:fs";

const PATH_IN_REQUEST = /(?:^|[\s"'`(\[])((?:\/|~\/|\.{1,2}\/)?[\w.-]+(?:\/[\w.-]+)+|\/[\w.-]+)/g;
const MAX_NAMED_PATHS = 12;

/** Every path-like token the request names, in order, deduped, at most twelve. */
export function pathsNamedIn(request: string): string[] {
  const seen: string[] = [];
  for (const m of request.matchAll(PATH_IN_REQUEST)) {
    const p = m[1].replace(/[.,:;]+$/, "");
    if (seen.includes(p)) continue;
    if (seen.length >= MAX_NAMED_PATHS) break;
    seen.push(p);
  }
  return seen;
}

/** A token that names a file and not a pair of words: anchored at a root, a
 *  home or the current folder, or ending in a file extension. */
export function isFileShaped(p: string): boolean {
  if (/^(?:\/|~\/|\.{1,2}\/)/.test(p)) return true;
  return /\.[A-Za-z0-9]{1,8}$/.test(p.slice(p.lastIndexOf("/") + 1));
}

/**
 * The file-shaped paths the request names that are not on disk now. A path the
 * resolver refuses is left out: what the agent may not reach is not a fact the
 * agent can act on. Terminal-Bench 2.0 (2026-10-31): four of ten losses to
 * Hermes ended with the named output never written (llm-inference-batching-
 * scheduler had a plan meeting every threshold three minutes before its
 * deadline), so the digest states which named files are still missing.
 */
export function missingNamedFiles(
  request: string,
  resolve: (p: string) => string,
  exists: (abs: string) => boolean = existsSync,
): string[] {
  const missing: string[] = [];
  for (const p of pathsNamedIn(request)) {
    if (!isFileShaped(p)) continue;
    let abs: string;
    try { abs = resolve(p); } catch { continue; }
    if (!exists(abs)) missing.push(p);
  }
  return missing;
}
