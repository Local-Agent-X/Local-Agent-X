import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { readFile } from "fs/promises";
import { relative, join } from "path";
import { homedir } from "os";

export const STATE_PATH = join(homedir(), ".lax", "reconcile-state.json");

/**
 * A node_modules npm finished installing carries a `.package-lock.json` manifest.
 * Its absence — or a missing node_modules — means the install is incomplete: a
 * fresh tree, an interrupted install, or (the bug this guards) an update whose
 * worktree merge deleted node_modules on macOS while package-lock.json stayed
 * put. Reconcile keys its `npm install` on lockfile-hash CHANGES, so without this
 * a gutted node_modules boots the server straight into "Cannot find package" and
 * bricks the app with no self-recovery — Repair re-runs reconcile and skips the
 * install for the same reason. Cheap (two stats); npm writes this on every install.
 *
 * markerPkg: a load-bearing package whose package.json must ALSO exist. The
 * manifest alone is not proof — a gutted tree (observed: an EMPTY
 * node_modules/electron) can keep `.package-lock.json` and pass for days while
 * the loader silently falls back to the bundled main. Desktop passes "electron";
 * root has no equally clear single marker, so it stays manifest-only.
 *
 * Also false when foreignPmCorruption (below) flags the tree — a node_modules
 * rewritten by pnpm is corrupt for an npm-managed repo even if the manifest
 * and marker package survived the rewrite.
 */
export function depsInstalled(dir: string, markerPkg?: string): boolean {
  if (!existsSync(join(dir, "node_modules"))) return false;
  // Covers BOTH a missing .package-lock.json manifest and a tree rewritten by
  // a foreign package manager (pnpm) — either way this is not a healthy npm
  // install, so the heal npm-install path must run.
  if (foreignPmCorruption(dir) !== null) return false;
  if (markerPkg !== undefined && !existsSync(join(dir, "node_modules", markerPkg, "package.json"))) return false;
  return true;
}

/**
 * Foreign-package-manager corruption of an npm-managed node_modules (the
 * 2026-07 incident: a coding-agent session ran `pnpm` in this npm repo; pnpm
 * rewrote node_modules MID-RUN — vitest vanished while tests were executing —
 * and had previously gutted desktop/node_modules/electron into an empty dir,
 * silently breaking desktop rebuilds for 3 days). pnpm's layout is a symlink
 * forest into node_modules/.pnpm plus a .modules.yaml manifest; npm's is flat
 * with a .package-lock.json manifest. Any pnpm marker — or a node_modules
 * that exists WITHOUT npm's manifest — means the tree cannot be trusted.
 *
 * Returns the human-readable cause, or null when the tree is either absent
 * (deps MISSING, not corrupt — the plain heal handles that) or a healthy npm
 * layout. Callers that heal a corrupt tree must WIPE node_modules first:
 * `npm install` over pnpm's symlink forest leaves .pnpm/.modules.yaml behind,
 * which would re-flag corruption on every subsequent boot.
 */
export function foreignPmCorruption(dir: string): string | null {
  const nm = join(dir, "node_modules");
  if (!existsSync(nm)) return null;
  if (existsSync(join(nm, ".pnpm")))
    return "node_modules was rewritten by another package manager (pnpm) — found node_modules/.pnpm";
  if (existsSync(join(nm, ".modules.yaml")))
    return "node_modules was rewritten by another package manager (pnpm) — found node_modules/.modules.yaml";
  if (!existsSync(join(nm, ".package-lock.json")))
    return "node_modules exists but npm's .package-lock.json manifest is missing — the tree was rewritten by another package manager or an install was interrupted";
  return null;
}

// ── Desktop pre-build marker (cross-side, sibling of reconcile-state.json) ──
// The SERVER-side update pipeline (src/desktop-prebuild-marker.ts) writes this
// file when an update's desktop pre-build fails, so the next desktop boot knows
// a rebuild was expected and can escalate loudly if dist is still stale. The
// two sides share the path by convention (desktop is CJS, server is ESM — they
// cannot import each other); test/desktop-reconcile-deps.test.ts pins it.
export const DESKTOP_PREBUILD_MARKER_PATH = join(homedir(), ".lax", "desktop-prebuild-pending.json");

export interface DesktopPrebuildMarker { failedAt: string; detail: string }

export function readDesktopPrebuildMarker(markerPath: string = DESKTOP_PREBUILD_MARKER_PATH): DesktopPrebuildMarker | null {
  if (!existsSync(markerPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(markerPath, "utf-8"));
    if (parsed && typeof parsed.detail === "string") return parsed as DesktopPrebuildMarker;
  } catch { /* corrupt marker reads as absent — never blocks boot */ }
  return null;
}

export function clearDesktopPrebuildMarker(markerPath: string = DESKTOP_PREBUILD_MARKER_PATH): void {
  try { rmSync(markerPath, { force: true }); } catch { /* leftover marker just re-notifies */ }
}

/**
 * Pure decision: does a boot need to SURFACE a stale desktop dist? Returns the
 * human-readable reason to show, or null to stay quiet. Quiet when dist is
 * fresh, or when a rebuild is planned this boot (the rebuild + relaunch fixes
 * it — nothing to warn about). Otherwise the app is about to run old desktop
 * code with no self-recovery scheduled — the 3-day-silent failure class.
 */
export function staleDistDecision(opts: {
  distFresh: boolean;
  rebuildPlanned: boolean;
  depsWereMissing: boolean;
  prebuildFailDetail: string | null;
}): string | null {
  if (opts.distFresh || opts.rebuildPlanned) return null;
  const base = "Desktop build (desktop/dist) is older than its source and no rebuild is scheduled this boot";
  if (opts.prebuildFailDetail) {
    return `${base} — the last update's desktop build failed: ${opts.prebuildFailDetail.split("\n")[0].slice(0, 200)}`;
  }
  if (opts.depsWereMissing) {
    return `${base} — desktop dependencies were incomplete (e.g. node_modules/electron gutted)`;
  }
  return `${base} — the app is likely running an older desktop build`;
}

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
