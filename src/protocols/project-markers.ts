/**
 * EXP-17: project-aware skill triggering.
 *
 * A message-only selector cannot see that the workspace IS a Supabase
 * project; the user in one says "add a customers table", not "supabase". A
 * skill may declare `project-markers` (files such as `supabase/config.toml`),
 * and a marker found on disk admits the skill the way a verbatim trigger
 * would. The lookup is bounded by the message's own words, never a walk — a
 * workspace can hold 100k files.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Protocol } from "./types.js";

const MAX_TOKENS = 200;
const MAX_DIRS = 12;

/** The directories a marker may sit in: the workspace root and any directory
 *  directly under it that the message names ("in the acme-api project"). */
export function projectDirsNamedIn(message: string, root: string): string[] {
  const dirs = [root];
  const seen = new Set<string>();
  for (const raw of message.split(/\s+/).slice(0, MAX_TOKENS)) {
    const token = raw.replace(/^[^\w.-]+|[^\w.-]+$/g, "");
    if (!token || token.length > 80 || seen.has(token) || token.includes("..") || /^[.-]/.test(token)) continue;
    seen.add(token);
    const dir = join(root, token);
    try { if (statSync(dir).isDirectory()) dirs.push(dir); } catch { /* not a directory */ }
    if (dirs.length >= MAX_DIRS) break;
  }
  return dirs;
}

/** True for a protocol whose declared marker exists in one of `dirs`. */
export function projectMarkerHitIn(dirs: string[]): (protocol: Protocol) => boolean {
  return (protocol) => (protocol.projectMarkers ?? []).some((marker) => dirs.some((dir) => existsSync(join(dir, marker))));
}
