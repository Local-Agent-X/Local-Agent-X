import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { readFile } from "fs/promises";
import { relative, join } from "path";
import { homedir } from "os";

export const STATE_PATH = join(homedir(), ".lax", "reconcile-state.json");

// sha256 of an empty buffer — sha256SrcTree returns this when the walk
// finds zero .ts files (typically: projectRoot points at a directory that
// doesn't contain desktop/src). Hardcoded so the comparison is obvious at
// the call site in reconcile.ts.
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** One .ts file's stat fingerprint. path is relative to projectRoot with
 *  posix separators — same normalization sha256SrcTree feeds the hash. */
export interface SrcManifestEntry {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface ReconcileState {
  version: 2;
  rootLock: string;
  desktopLock: string;
  desktopSrc: string;
  desktopSrcManifest: SrcManifestEntry[];
  /** Hash of the server's src/ tree. Optional: withheld after a failed
   *  server build so the next boot retries (see reconcile.ts saveState
   *  call), and absent on states carried over from before the field
   *  shipped — absence reads as "changed", forcing one healing build. */
  rootSrc?: string;
  /** Stat manifest paired with rootSrc — always withheld/recorded together
   *  so a stale hash can never ride a fresh manifest through the fast path. */
  rootSrcManifest?: SrcManifestEntry[];
  lastReconciledAt: string;
}

export function loadState(): ReconcileState | null {
  if (!existsSync(STATE_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf-8"));
    // Any other version (including pre-manifest v1 files) reads as no-state:
    // reconcile's first-launch path re-baselines without triggering a build.
    if (parsed && parsed.version === 2) return parsed as ReconcileState;
  } catch {}
  return null;
}

export function saveState(state: ReconcileState): void {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

export function sha256File(path: string): string {
  if (!existsSync(path)) return "";
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// The ONE walk both the content hash and the stat manifest are built from,
// so the two can never disagree about which files make up the tree.
// Skips node_modules/dist, collects *.ts, sorted for determinism; captures
// each file's stat so the manifest needs no second pass.
function listSrcTs(dirPath: string): { full: string; size: number; mtimeMs: number }[] {
  const files: { full: string; size: number; mtimeMs: number }[] = [];
  const walk = (p: string): void => {
    if (!existsSync(p)) return;
    for (const name of readdirSync(p)) {
      const full = join(p, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (name === "node_modules" || name === "dist") continue;
        walk(full);
      } else if (st.isFile() && name.endsWith(".ts")) {
        files.push({ full, size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  };
  walk(dirPath);
  files.sort((a, b) => (a.full < b.full ? -1 : a.full > b.full ? 1 : 0));
  return files;
}

function relPosix(full: string, projectRoot: string): string {
  return relative(projectRoot, full).replace(/\\/g, "/");
}

export async function sha256SrcTree(dirPath: string, projectRoot: string): Promise<string> {
  const hash = createHash("sha256");
  for (const f of listSrcTs(dirPath)) {
    hash.update(relPosix(f.full, projectRoot));
    hash.update("\0");
    // await an ASYNC read so this yields the event loop between files. Hashing
    // the whole src tree (~1200 .ts files) with readFileSync blocked the main
    // thread for tens of seconds on a cold disk (Defender scanning each read),
    // and because runReconcile runs before the first await in the boot path,
    // the splash window's ready-to-show couldn't fire — so the app showed
    // NOTHING and never auto-displayed (only a manual tray click, which calls
    // show() directly, surfaced it). Same hash bytes, just non-blocking.
    hash.update(await readFile(f.full));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Stat-only fingerprint of the tree — zero content reads (nothing for
 *  Defender to scan), which is the whole point of the fast path below. */
export function buildSrcManifest(dirPath: string, projectRoot: string): SrcManifestEntry[] {
  return listSrcTs(dirPath).map((f) => ({ path: relPosix(f.full, projectRoot), size: f.size, mtimeMs: f.mtimeMs }));
}

function manifestsEqual(a: SrcManifestEntry[], b: SrcManifestEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    // Strict equality on mtimeMs in BOTH directions — a rolled-back file
    // (older mtime) is just as changed as an edited one.
    if (a[i].path !== b[i].path || a[i].size !== b[i].size || a[i].mtimeMs !== b[i].mtimeMs) return false;
  }
  return true;
}

/**
 * Content hash of the src tree, skipping the actual content reads when the
 * stored stat manifest matches the tree exactly. Any difference — entry
 * count, path, size, or mtime moved in either direction — or a missing
 * stored manifest/hash falls back to sha256SrcTree for the definitive
 * answer. Returns the fresh manifest either way so the caller can persist it
 * alongside the hash it belongs to.
 */
export async function srcTreeHashCached(
  dirPath: string,
  projectRoot: string,
  storedManifest: SrcManifestEntry[] | undefined,
  storedHash: string | undefined,
): Promise<{ hash: string; manifest: SrcManifestEntry[] }> {
  const manifest = buildSrcManifest(dirPath, projectRoot);
  if (storedManifest !== undefined && storedHash !== undefined && manifestsEqual(storedManifest, manifest)) {
    return { hash: storedHash, manifest };
  }
  return { hash: await sha256SrcTree(dirPath, projectRoot), manifest };
}
