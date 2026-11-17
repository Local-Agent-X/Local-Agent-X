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
 *
 * A relative path is read against every folder the request names as well as
 * the session's root (locateNamedPath): "in the project at C:\work\shop,
 * fix src/cart.ts" means the shop's src/cart.ts, and a session rooted elsewhere
 * would otherwise report it missing. Parity battery 2026-11-16: the digest told
 * the model an existing src/domain/index.ts was "not on disk" in 5 of 39 runs,
 * and each spent one or two steps proving it was there.
 */
import { existsSync } from "node:fs";

const PATH_IN_REQUEST = /(?:^|[\s"'`(\[])((?:\/|~\/|\.{1,2}\/)?[\w.-]+(?:\/[\w.-]+)+|\/[\w.-]+)/g;
const MAX_NAMED_PATHS = 12;
// A Windows folder or file named with its drive: the path reader above takes
// only slash-joined tokens, so "C:\work\shop" would never be a root.
const DRIVE_PATH_IN_REQUEST = /(?:^|[\s"'`(\[])([A-Za-z]:[\\/][^\s"'`)\]]*)/g;

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

/** The folders a request names by an absolute path, a relative path's other
 *  possible anchors. A named file among them only costs a lookup that finds
 *  nothing, so they are not told apart. */
export function rootsNamedIn(request: string): string[] {
  const roots = pathsNamedIn(request).filter((p) => /^(?:\/|~\/)/.test(p));
  for (const m of request.matchAll(DRIVE_PATH_IN_REQUEST)) {
    const p = m[1].replace(/[.,:;\\/]+$/, "");
    if (p.length > 3 && !roots.includes(p) && roots.length < MAX_NAMED_PATHS) roots.push(p);
  }
  return roots;
}

function isRelative(p: string): boolean {
  return !/^(?:[\\/~]|[A-Za-z]:[\\/])/.test(p);
}

/**
 * Where a named path is on disk: the session's own reading of it first, then,
 * for a relative path, the same path under each folder the request names. The
 * first reading that exists wins; when none does, the session's reading stands
 * as the one the request most likely means. Undefined when the resolver refuses
 * every reading.
 */
export function locateNamedPath(
  p: string,
  roots: readonly string[],
  resolve: (p: string) => string,
  exists: (abs: string) => boolean = existsSync,
): { abs: string; exists: boolean } | undefined {
  const readings = isRelative(p) ? [p, ...roots.map((r) => `${r.replace(/[\\/]+$/, "")}/${p}`)] : [p];
  let first: string | undefined;
  for (const reading of readings) {
    let abs: string;
    try { abs = resolve(reading); } catch { continue; }
    if (exists(abs)) return { abs, exists: true };
    first ??= abs;
  }
  return first === undefined ? undefined : { abs: first, exists: false };
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
  const roots = rootsNamedIn(request);
  const missing: string[] = [];
  for (const p of pathsNamedIn(request)) {
    if (!isFileShaped(p)) continue;
    const found = locateNamedPath(p, roots, resolve, exists);
    if (found && !found.exists) missing.push(p);
  }
  return missing;
}
