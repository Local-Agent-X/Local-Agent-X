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

import { ChildProcess, execSync, spawn } from "child_process";
import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, cpSync, rmSync } from "fs";
import { join, relative } from "path";
import { homedir } from "os";
import { Script } from "vm";
import { serverDistIsFresh } from "./dist-freshness";

// GUI-launched Mac apps (Finder/Launchpad/Spotlight) inherit a minimal
// PATH that excludes Homebrew, nvm, and asdf. Without this augment, our
// runStep() invocations of `npm` ENOENT — the splash hangs with
// "Update failed — spawn npm ENOENT" and the user is stuck. Same set of
// paths as server-process.ts uses when spawning `node`. Kept duplicated
// here rather than extracted because a third spawning site doesn't exist
// yet (the abstraction would have only two callers).
function buildAugmentedPath(): string {
  const augments = [
    "/opt/homebrew/bin", "/opt/homebrew/sbin",
    "/usr/local/bin", "/usr/local/sbin",
    join(homedir(), ".nvm/versions/node/current/bin"),
  ];
  const existing = (process.env.PATH || "").split(":");
  return [...augments, ...existing].filter((p, i, a) => p && a.indexOf(p) === i).join(":");
}

const STATE_PATH = join(homedir(), ".lax", "reconcile-state.json");

interface ReconcileState {
  version: 1;
  rootLock: string;
  desktopLock: string;
  desktopSrc: string;
  /** Hash of the server's src/ tree. Optional because pre-existing state
   *  files don't have it — absence reads as "changed", which forces one
   *  root build on first launch after this field shipped. That's the heal
   *  for installs whose dist froze while updates only touched src/ (the
   *  2026-06-09 failure: dist stuck at Jun 7 while the user pulled updates
   *  all day, every boot falling back to slow tsx). */
  rootSrc?: string;
  lastReconciledAt: string;
}

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
}

export interface ReconcileOpts {
  projectRoot: string;
  /** Called with short status strings ("Updating components…",
   *  "Building app…") so the caller can update the splash. */
  onStatus?: (text: string) => void;
}

function sha256File(path: string): string {
  if (!existsSync(path)) return "";
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256SrcTree(dirPath: string, projectRoot: string): string {
  const hash = createHash("sha256");
  const files: string[] = [];
  const walk = (p: string): void => {
    if (!existsSync(p)) return;
    for (const name of readdirSync(p)) {
      const full = join(p, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (name === "node_modules" || name === "dist") continue;
        walk(full);
      } else if (st.isFile() && name.endsWith(".ts")) {
        files.push(full);
      }
    }
  };
  walk(dirPath);
  files.sort();
  for (const f of files) {
    hash.update(relative(projectRoot, f).replace(/\\/g, "/"));
    hash.update("\0");
    hash.update(readFileSync(f));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function loadState(): ReconcileState | null {
  if (!existsSync(STATE_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf-8"));
    if (parsed && parsed.version === 1) return parsed as ReconcileState;
  } catch {}
  return null;
}

function saveState(state: ReconcileState): void {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// In-flight reconcile children. Quitting mid-"Building server updates…"
// used to orphan the npm/tsc tree: it kept writing dist/ after the app
// died, so the next launch could spawn the server against a half-rebuilt
// dist (the 2026-06-09 stale-import crash rode in on exactly this race).
// main.ts calls killReconcileStepsSync() on every quit path.
const liveSteps = new Set<ChildProcess>();

/** Synchronous, unconditional kill of any in-flight reconcile step.
 *  Must be sync: Electron does not await async listeners on will-quit.
 *  Safe interruption: reconcile-state is only saved after a step
 *  succeeds, so the next launch detects the unfinished work and retries;
 *  a half-written dist/ is caught by server-process distIsFresh (falls
 *  back to tsx) and reconcile's own backup/restore. */
export function killReconcileStepsSync(): void {
  for (const proc of liveSteps) {
    if (!proc.pid) continue;
    if (process.platform === "win32") {
      try { execSync(`taskkill /PID ${proc.pid} /T /F`, { windowsHide: true, stdio: "ignore" }); } catch {}
    } else {
      // Negative pid kills the whole process group (npm + the tsc/node it
      // spawned) — runStep spawns detached on POSIX so the group is ours.
      try { process.kill(-proc.pid, "SIGKILL"); } catch {}
    }
  }
  liveSteps.clear();
}

function runStep(cmd: string, args: string[], cwd: string, timeoutMs?: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd,
      shell: process.platform === "win32",
      // POSIX: own process group, so killReconcileStepsSync can tree-kill
      // via kill(-pid). Windows tree-kills with taskkill /T instead.
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: buildAugmentedPath() },
    });
    liveSteps.add(proc);
    let stderrTail = "";

    // Hard timeout. proc.on("exit") only fires on a REAL exit; a deadlocked
    // child (esbuild service stall, a fork-bombed tsx helper) never fires it,
    // so without this the `await runStep(...)` never settles, runReconcile
    // never returns, startServer is never reached, and the splash sits on
    // "Building server updates…" forever — the exact wedge. On timeout we
    // tree-kill (same mechanism as killReconcileStepsSync) and reject so the
    // caller's existing degrade-to-tsx fallback runs.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clearTimer = () => { if (timer) { clearTimeout(timer); timer = undefined; } };
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        timer = undefined;
        if (proc.pid) {
          if (process.platform === "win32") {
            try { execSync(`taskkill /PID ${proc.pid} /T /F`, { windowsHide: true, stdio: "ignore" }); } catch {}
          } else {
            try { process.kill(-proc.pid, "SIGKILL"); } catch {}
          }
        }
        liveSteps.delete(proc);
        reject(new Error(`${cmd} ${args.join(" ")} (cwd=${cwd}) timed out after ${timeoutMs}ms — killed.`));
      }, timeoutMs);
    }

    proc.stdout?.on("data", (b: Buffer) => process.stdout.write(b));
    proc.stderr?.on("data", (b: Buffer) => {
      stderrTail += b.toString();
      if (stderrTail.length > 4000) stderrTail = stderrTail.slice(-4000);
      process.stderr.write(b);
    });
    proc.on("error", (err) => {
      clearTimer();
      liveSteps.delete(proc);
      reject(err);
    });
    proc.on("exit", (code) => {
      clearTimer();
      liveSteps.delete(proc);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} (cwd=${cwd}) exited ${code}. Last stderr:\n${stderrTail.slice(-1500)}`));
    });
  });
}

// First emitted .js file that V8 can't even parse, or null if all parse.
// A zero exit from `tsc` does NOT guarantee loadable output: a regex literal
// containing a raw U+2028/U+2029 (JS line terminator) compiles "fine" but
// throws "Invalid regular expression: missing /" the instant Node parses it,
// which bricked the main process before any window or the splash existed.
// new Script() runs the same V8 parser eagerly without executing the module.
function firstUnparseableJs(distDir: string): { file: string; error: string } | null {
  const files: string[] = [];
  const walk = (p: string): void => {
    for (const name of readdirSync(p)) {
      const full = join(p, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (name.endsWith(".js")) files.push(full);
    }
  };
  if (existsSync(distDir)) walk(distDir);
  for (const f of files) {
    try { new Script(readFileSync(f, "utf-8"), { filename: f }); }
    catch (e) { return { file: f, error: (e as Error).message }; }
  }
  return null;
}

// sha256 of an empty buffer — sha256SrcTree returns this when the walk
// finds zero .ts files (typically: projectRoot points at a directory that
// doesn't contain desktop/src). Hardcoded so the comparison is obvious at
// the call site below.
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export async function runReconcile(opts: ReconcileOpts): Promise<ReconcileResult> {
  const { projectRoot, onStatus } = opts;
  const ranSteps: string[] = [];
  const warnings: string[] = [];
  let rootBuildSucceeded = false;

  const currentRootLock = sha256File(join(projectRoot, "package-lock.json"));
  const currentDesktopLock = sha256File(join(projectRoot, "desktop", "package-lock.json"));
  const currentDesktopSrc = sha256SrcTree(join(projectRoot, "desktop", "src"), projectRoot);
  const currentRootSrc = sha256SrcTree(join(projectRoot, "src"), projectRoot);

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

  const stored = loadState();

  // First-ever launch (no state file): trust the installer's build is
  // fresh, just record current hashes. Skip running install/build to
  // avoid a 30s+ delay on first launch when everything is already
  // correct (install-common.mjs just finished).
  if (!stored) {
    saveState({
      version: 1,
      rootLock: currentRootLock,
      desktopLock: currentDesktopLock,
      desktopSrc: currentDesktopSrc,
      rootSrc: currentRootSrc,
      lastReconciledAt: new Date().toISOString(),
    });
    return { needsRelaunch: false, ranSteps: ["first-launch (recorded baseline)"], warnings: [] };
  }

  const rootChanged    = stored.rootLock    !== currentRootLock;
  const desktopChanged = stored.desktopLock !== currentDesktopLock;
  const srcChanged     = stored.desktopSrc  !== currentDesktopSrc;
  // Missing on pre-field state files → reads as changed → one healing build.
  const rootSrcChanged = stored.rootSrc     !== currentRootSrc;

  if (rootChanged) {
    onStatus?.("Updating components…");
    await runStep("npm", ["install", "--no-audit", "--no-fund"], projectRoot, 300_000);
    ranSteps.push("root npm install");
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
  const serverDistFresh = serverDistIsFresh(projectRoot);
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
  if (desktopChanged) {
    onStatus?.("Updating desktop components…");
    await runStep("npm", ["install", "--no-audit", "--no-fund"], join(projectRoot, "desktop"), 300_000);
    ranSteps.push("desktop npm install");
  }
  if (srcChanged) {
    onStatus?.("Building app updates…");
    const distDir = join(projectRoot, "desktop", "dist");
    const backupDir = `${distDir}.prev`;
    const haveBackup = existsSync(distDir);
    if (haveBackup) {
      rmSync(backupDir, { recursive: true, force: true });
      cpSync(distDir, backupDir, { recursive: true });
    }
    // tsc emits output even when it errors (noEmitOnError is off), so a
    // failed build leaves a half-written / unparseable dist on disk. Treat
    // BOTH a non-zero build exit AND unparseable emitted JS as failure, and
    // in either case roll dist/ back to the last good build rather than
    // relaunch into it. This is the path that bricked the app.
    try {
      await runStep("npm", ["run", "build"], join(projectRoot, "desktop"), 300_000);
      const bad = firstUnparseableJs(distDir);
      if (bad) throw new Error(`${relative(projectRoot, bad.file)} — ${bad.error}`);
    } catch (e) {
      if (haveBackup) {
        rmSync(distDir, { recursive: true, force: true });
        cpSync(backupDir, distDir, { recursive: true });
      }
      rmSync(backupDir, { recursive: true, force: true });
      throw new Error(
        `Desktop build failed: ${(e as Error).message}. ` +
        `Reverted dist/ to the previous build so the app isn't bricked — the splash and Repair stay usable. ` +
        `Fix the source (or update again) and relaunch.`,
      );
    }
    rmSync(backupDir, { recursive: true, force: true });
    ranSteps.push("desktop tsc build");
  }

  // Record currentRootSrc as the reconciled baseline when dist is known-good
  // for this src: a build landed, OR src didn't change, OR a gated update
  // already shipped a fresh dist (serverDistFresh). Withholding it on a FAILED
  // build is the only case we keep the stale marker, so the next boot retries.
  const rootSrcReconciled = rootBuildSucceeded || !rootSrcChanged || serverDistFresh;
  saveState({
    version: 1,
    rootLock: currentRootLock,
    desktopLock: currentDesktopLock,
    desktopSrc: currentDesktopSrc,
    rootSrc: rootSrcReconciled ? currentRootSrc : stored.rootSrc,
    lastReconciledAt: new Date().toISOString(),
  });

  return { needsRelaunch: srcChanged, ranSteps, warnings };
}
