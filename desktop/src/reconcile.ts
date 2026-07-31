// Pre-launch reconcile: detect whether package-lock.json files or
// desktop/src have changed since the last successful boot, and run the
// corresponding npm install / tsc steps before letting Electron continue.
// Closes the "I just pulled and the app silently runs old/broken code"
// failure class — the same one that bit on 2026-05-21 when the diff
// package was added to package.json but never installed, and when
// desktop/src/main.ts was split but desktop/dist/main.js stayed stale.
//
// State stored in ~/.lax/reconcile-state.json (separate from config.json
// so a corrupt state file never threatens port/authToken). Hashes are
// sha256 of the relevant inputs.
//
// Failure mode: any reconcile step exiting non-zero leaves the state
// file untouched (so the next launch retries) and propagates an error
// to the caller. main.ts surfaces it via the splash and does NOT proceed
// to start the server — running with mismatched code is the failure
// we're trying to prevent.

import { existsSync, cpSync, rmSync } from "fs";
import { join, relative } from "path";
import { serverDistIsFresh, desktopDistIsFresh, desktopDistMtimeFresh } from "./dist-freshness";
import { EMPTY_SHA256, sha256File, srcTreeHashCached, loadState, saveState, depsInstalled, foreignPmCorruption, staleDistDecision, desktopRebuildRequired, readDesktopPrebuildMarker, clearDesktopPrebuildMarker } from "./reconcile-hash";
import { firstUnparseableJs, rebuildDesktopDist, runStep } from "./reconcile-build";
import { surfaceForeignPmRewrite } from "./reconcile-surface";

export { killReconcileStepsSync } from "./reconcile-build";

export interface ReconcileResult {
  /** Whether desktop/src was rebuilt. When true, caller MUST app.relaunch()
   *  so Electron loads the freshly-compiled dist/main.js. */
  needsRelaunch: boolean;
  /** Human-readable list of steps that ran, for logging. Empty on a
   *  clean-launch hit (no changes detected). */
  ranSteps: string[];
  /** Non-fatal degradations the caller MUST surface to the user (e.g. the
   *  server build failed and the app is running source via tsx). Reconcile
   *  deliberately does not throw for these — but silence is not an option
   *  either. */
  warnings: string[];
  /** Reason string when desktop/dist is stale and NOTHING this boot will fix it
   *  (null = quiet). Caller MUST pass it to surfaceStaleDesktopDist — loud, not log-only. */
  staleDesktopDist: string | null;
}

export interface ReconcileOpts {
  projectRoot: string;
  /** Called with short status strings ("Updating components…",
   *  "Building app…") so the caller can update the splash. */
  onStatus?: (text: string) => void;
}

export async function runReconcile(opts: ReconcileOpts): Promise<ReconcileResult> {
  const { projectRoot, onStatus } = opts;
  const ranSteps: string[] = [];
  const warnings: string[] = [];
  let rootBuildSucceeded = false;

  const stored = loadState();
  const currentRootLock = sha256File(join(projectRoot, "package-lock.json"));
  const currentDesktopLock = sha256File(join(projectRoot, "desktop", "package-lock.json"));
  // Stat-manifest fast path: when the stored manifest matches the tree, the
  // stored hash is reused with ZERO content reads (Defender scans every read
  // on Windows — this was the dominant deterministic launch cost).
  const { hash: currentDesktopSrc, manifest: desktopManifest } = await srcTreeHashCached(
    join(projectRoot, "desktop", "src"), projectRoot, stored?.desktopSrcManifest, stored?.desktopSrc);
  const { hash: currentRootSrc, manifest: rootManifest } = await srcTreeHashCached(
    join(projectRoot, "src"), projectRoot, stored?.rootSrcManifest, stored?.rootSrc);

  // Misconfigured projectRoot guard. If we found zero .ts files under
  // desktop/src AND the root package-lock.json is missing, the path
  // is almost certainly not a LAX repo — refuse to write a baseline of
  // empty hashes that would make every subsequent launch silently skip
  // its rebuild. Caller (main.ts) surfaces the error on the splash.
  if (currentDesktopSrc === EMPTY_SHA256 && !currentRootLock) {
    throw new Error(
      `Reconcile aborted: projectRoot "${projectRoot}" has no desktop/src/*.ts files and no package-lock.json. ` +
      `This is almost certainly the wrong projectRoot. Check ~/.lax/config.json.`,
    );
  }

  // Foreign-package-manager rewrite guard (the 2026-07 pnpm incident: a coding
  // agent ran pnpm in this npm-managed repo — pnpm rewrote node_modules MID-RUN
  // and gutted desktop/node_modules/electron, silently breaking desktop rebuilds
  // for 3 days). Surface LOUDLY, then wipe the tree so the heal npm-install
  // below rebuilds a clean npm layout — `npm install` over pnpm's symlink forest
  // leaves .pnpm/.modules.yaml behind and would re-flag this on every boot.
  // Runs after the misconfigured-projectRoot guard so we never wipe a stranger's
  // node_modules; depsInstalled() below independently reads the wiped tree as
  // missing, which is what routes both launch paths into the existing heal.
  for (const dir of [projectRoot, join(projectRoot, "desktop")]) {
    const cause = foreignPmCorruption(dir);
    if (!cause) continue;
    const label = dir === projectRoot ? "" : "desktop ";
    surfaceForeignPmRewrite(label + cause);
    rmSync(join(dir, "node_modules"), { recursive: true, force: true });
    ranSteps.push(`wiped foreign-package-manager ${label}node_modules`);
  }

  // node_modules can be gone/incomplete without the lockfile changing — a fresh
  // checkout, an interrupted install, or (the macOS bug this guards) an update
  // whose worktree merge deleted node_modules. Heal it regardless of the
  // hash-based change detection, on BOTH the first-launch and steady paths.
  // "electron" = desktop's load-bearing marker package (see depsInstalled: a
  // gutted node_modules/electron passed the manifest-only check for 3 days).
  const rootDepsMissing    = !depsInstalled(projectRoot);
  const desktopDepsMissing = !depsInstalled(join(projectRoot, "desktop"), "electron");

  // Dist staleness is consulted at EVERY boot — a stale dist with no rebuild
  // scheduled used to have no signal at all. The WARNING signal is mtime-only
  // (see desktopDistMtimeFresh: the stale-stamp case is unfixable noise); the
  // REBUILD decision stays stamp-aware. Captured before steps can touch dist.
  const desktopDistFresh = await desktopDistIsFresh(projectRoot);
  const desktopMtimeFresh = await desktopDistMtimeFresh(projectRoot);
  const prebuildMarker = readDesktopPrebuildMarker();
  const decideStale = (rebuildPlanned: boolean) => staleDistDecision({
    distFresh: desktopMtimeFresh, rebuildPlanned, depsWereMissing: desktopDepsMissing, prebuildFailDetail: prebuildMarker?.detail ?? null });

  // First-ever launch (no state file): trust the installer's build is fresh and
  // just record current hashes, to avoid a 30s+ delay when everything is already
  // correct. EXCEPTION: if deps are missing, heal first — the Repair button wipes
  // reconcile-state.json to force this path, so without this Repair couldn't fix
  // a gutted node_modules (it'd skip the install and relaunch into the same brick).
  if (!stored) {
    if (rootDepsMissing) {
      onStatus?.("Restoring components…");
      await runStep("npm", ["install", "--no-audit", "--no-fund"], projectRoot, 300_000);
    }
    if (desktopDepsMissing) {
      onStatus?.("Restoring desktop components…");
      await runStep("npm", ["install", "--no-audit", "--no-fund"], join(projectRoot, "desktop"), 300_000);
    }
    const needsDesktopBuild = desktopRebuildRequired({
      srcChanged: false,
      depsWereMissing: desktopDepsMissing,
      distFresh: desktopDistFresh,
    });
    if (needsDesktopBuild) await rebuildDesktopDist(projectRoot, onStatus);
    saveState({
      version: 2,
      rootLock: currentRootLock,
      desktopLock: currentDesktopLock,
      desktopSrc: currentDesktopSrc,
      desktopSrcManifest: desktopManifest,
      rootSrc: currentRootSrc,
      rootSrcManifest: rootManifest,
      lastReconciledAt: new Date().toISOString(),
    });
    const healed = rootDepsMissing || desktopDepsMissing;
    return {
      needsRelaunch: needsDesktopBuild,
      ranSteps: [healed ? "first-launch heal (deps were missing)" : "first-launch (recorded baseline)", ...(needsDesktopBuild ? ["desktop tsc build"] : [])],
      warnings: [],
      // First launch never rebuilds desktop AND just baselined the src hash, so
      // no later boot will either — a stale dist must be loud NOW or never.
      staleDesktopDist: decideStale(needsDesktopBuild),
    };
  }

  const rootChanged    = stored.rootLock    !== currentRootLock;
  const desktopChanged = stored.desktopLock !== currentDesktopLock;
  const srcChanged     = stored.desktopSrc  !== currentDesktopSrc;
  // Missing on pre-field state files → reads as changed → one healing build.
  const rootSrcChanged = stored.rootSrc     !== currentRootSrc;

  if (rootChanged || rootDepsMissing) {
    onStatus?.(rootDepsMissing ? "Restoring components…" : "Updating components…");
    await runStep("npm", ["install", "--no-audit", "--no-fund"], projectRoot, 300_000);
    ranSteps.push(rootDepsMissing ? "root npm install (deps were missing)" : "root npm install");
  }
  // Server build. An OTA/git update that only touches src/ used to leave
  // dist/ frozen forever (reconcile only watched lockfiles + desktop/src) —
  // the server then booted via the tsx-staleness fallback every launch:
  // correct code, but the slow path, and one fallback away from serving
  // stale builds. Runs `npm run build` (the canonical pipeline — build:ari
  // first, so workspace package .d.ts can't strand tsc) with the same
  // backup → validate → rollback contract as the desktop build below.
  //
  // Freshness short-circuit: a gated update already SHIPS a validated, freshly
  // built dist/ (the build+smoke gates compiled it in the sandbox). If dist is
  // already current for this src, rebuilding it is pure waste — the redundant
  // 1-2min "Building server updates…" on every post-update boot. Trust the same
  // signal the runtime uses to pick dist over tsx; only rebuild when dist is
  // genuinely behind (a dev editing src/ in a git checkout, or a half-applied
  // update). serverDistFresh is captured ONCE here, before any step below can
  // touch dist, so it reflects the state reconcile was handed.
  const serverDistFresh = await serverDistIsFresh(projectRoot);
  if ((rootChanged || rootSrcChanged) && !serverDistFresh) {
    onStatus?.("Building server updates…");
    const rootDist = join(projectRoot, "dist");
    const rootBackup = `${rootDist}.prev`;
    const haveRootBackup = existsSync(rootDist);
    if (haveRootBackup) {
      rmSync(rootBackup, { recursive: true, force: true });
      cpSync(rootDist, rootBackup, { recursive: true });
    }
    try {
      await runStep("npm", ["run", "build"], projectRoot, 480_000);
      const bad = firstUnparseableJs(rootDist);
      if (bad) throw new Error(`${relative(projectRoot, bad.file)} — ${bad.error}`);
      ranSteps.push("server build");
      rootBuildSucceeded = true;
    } catch (e) {
      if (haveRootBackup) {
        rmSync(rootDist, { recursive: true, force: true });
        cpSync(rootBackup, rootDist, { recursive: true });
      }
      // NON-fatal, unlike the desktop build below: the server's boot-time
      // staleness check (server-process.ts distIsFresh) sees src newer than
      // the reverted dist and runs current source via tsx — correct code,
      // slow path. Blocking launch over a build failure whose runtime cost
      // is only speed would strand the user worse than the bug being fixed.
      // Loud, not silent: surfaced as a warning the caller must show, and
      // rootSrc is NOT recorded so every boot retries until a build greens.
      warnings.push(
        `Server build failed: ${(e as Error).message}. Running from source instead ` +
        `(slower start). Will retry on next launch — if this persists, update again or report it.`,
      );
    } finally {
      rmSync(rootBackup, { recursive: true, force: true });
    }
  }
  if (desktopChanged || desktopDepsMissing) {
    onStatus?.(desktopDepsMissing ? "Restoring desktop components…" : "Updating desktop components…");
    await runStep("npm", ["install", "--no-audit", "--no-fund"], join(projectRoot, "desktop"), 300_000);
    ranSteps.push(desktopDepsMissing ? "desktop npm install (deps were missing)" : "desktop npm install");
  }
  // Same freshness short-circuit the server build uses above: a gated update
  // pre-builds desktop/dist (update-pipeline.ts), so the post-update boot loads
  // a current main process — skip the redundant tsc AND the relaunch it forces.
  const needsDesktopBuild = desktopRebuildRequired({
    srcChanged,
    depsWereMissing: desktopDepsMissing,
    distFresh: desktopDistFresh,
  });
  if (needsDesktopBuild) {
    await rebuildDesktopDist(projectRoot, onStatus);
    ranSteps.push("desktop tsc build");
  }
  // Rebuild landed or dist was already current → any pending pre-build marker is resolved.
  if (needsDesktopBuild || desktopMtimeFresh) clearDesktopPrebuildMarker();

  // Record currentRootSrc as the reconciled baseline when dist is known-good
  // for this src: a build landed, OR src didn't change, OR a gated update
  // already shipped a fresh dist (serverDistFresh). Withholding it on a FAILED
  // build is the only case we keep the stale marker, so the next boot retries.
  const rootSrcReconciled = rootBuildSucceeded || !rootSrcChanged || serverDistFresh;
  saveState({
    version: 2,
    rootLock: currentRootLock,
    desktopLock: currentDesktopLock,
    desktopSrc: currentDesktopSrc,
    desktopSrcManifest: desktopManifest,
    // Hash and manifest travel together: keeping the stale pair after a
    // failed build makes the next boot re-detect the change and retry.
    rootSrc: rootSrcReconciled ? currentRootSrc : stored.rootSrc,
    rootSrcManifest: rootSrcReconciled ? rootManifest : stored.rootSrcManifest,
    lastReconciledAt: new Date().toISOString(),
  });

  // decideStale(needsDesktopBuild): reaching here means any planned build succeeded.
  return { needsRelaunch: needsDesktopBuild, ranSteps, warnings, staleDesktopDist: decideStale(needsDesktopBuild) };
}
