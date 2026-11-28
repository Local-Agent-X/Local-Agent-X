/**
 * Which folder POST /api/memory/ingest-path may read into searchable memory.
 *
 * Importing a chat export legitimately reads a folder the user chose outside
 * the workspace (~/Downloads, a USB drive), so the route cannot allowlist the
 * workspace. It refuses instead: a folder that holds credentials (~/.ssh,
 * ~/.aws) and the app's own data dir, which would pull secrets and the app's
 * state into memory the agent searches. The folder is scanned non-recursively
 * (conversation/ingest.ts), so the root is the only path that gets read.
 *
 * The folder is judged by what it is, not by how the path spells it: with
 * links followed (realpathDeep) and by the name the filesystem gives it
 * (onDiskPath), so an 8.3 short name (`AWS~1`), another casing or a
 * trailing dot reaches the same refusal as the folder's own name.
 */
import { sep } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { matchesSensitivePath, pathIsWithin } from "../security/layer/file-access.js";
import { onDiskPath } from "../security/layer/on-disk-name.js";
import { realpathDeep } from "../workspace/paths.js";

export type IngestRoot = { root: string } | { refused: "not-accessible" | "sensitive" };

const fold = (p: string): string => (process.platform === "win32" ? p.toLowerCase() : p);

export function resolveIngestRoot(path: string): IngestRoot {
  let realRoot: string;
  let dataDirs: string[];
  try {
    realRoot = realpathDeep(path);
    dataDirs = [realpathDeep(getLaxDir()), onDiskPath(getLaxDir())].map(fold);
  } catch {
    return { refused: "not-accessible" };
  }
  for (const name of new Set([realRoot, onDiskPath(realRoot)])) {
    const folded = fold(name);
    if (matchesSensitivePath(folded.endsWith(sep) ? folded : folded + sep)) return { refused: "sensitive" };
    if (dataDirs.some((dir) => pathIsWithin(dir, folded))) return { refused: "sensitive" };
  }
  return { root: realRoot };
}
