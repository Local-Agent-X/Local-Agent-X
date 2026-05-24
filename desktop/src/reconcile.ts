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

import { spawn } from "child_process";
import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join, relative } from "path";
import { homedir } from "os";

const STATE_PATH = join(homedir(), ".lax", "reconcile-state.json");

interface ReconcileState {
  version: 1;
  rootLock: string;
  desktopLock: string;
  desktopSrc: string;
  lastReconciledAt: string;
}

export interface ReconcileResult {
  /** Whether desktop/src was rebuilt. When true, caller MUST app.relaunch()
   *  so Electron loads the freshly-compiled dist/main.js. */
  needsRelaunch: boolean;
  /** Human-readable list of steps that ran, for logging. Empty on a
   *  clean-launch hit (no changes detected). */
  ranSteps: string[];
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

function runStep(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderrTail = "";
    proc.stdout?.on("data", (b: Buffer) => process.stdout.write(b));
    proc.stderr?.on("data", (b: Buffer) => {
      stderrTail += b.toString();
      if (stderrTail.length > 4000) stderrTail = stderrTail.slice(-4000);
      process.stderr.write(b);
    });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} (cwd=${cwd}) exited ${code}. Last stderr:\n${stderrTail.slice(-1500)}`));
    });
  });
}

// sha256 of an empty buffer — sha256SrcTree returns this when the walk
// finds zero .ts files (typically: projectRoot points at a directory that
// doesn't contain desktop/src). Hardcoded so the comparison is obvious at
// the call site below.
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export async function runReconcile(opts: ReconcileOpts): Promise<ReconcileResult> {
  const { projectRoot, onStatus } = opts;
  const ranSteps: string[] = [];

  const currentRootLock = sha256File(join(projectRoot, "package-lock.json"));
  const currentDesktopLock = sha256File(join(projectRoot, "desktop", "package-lock.json"));
  const currentDesktopSrc = sha256SrcTree(join(projectRoot, "desktop", "src"), projectRoot);

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
      lastReconciledAt: new Date().toISOString(),
    });
    return { needsRelaunch: false, ranSteps: ["first-launch (recorded baseline)"] };
  }

  const rootChanged    = stored.rootLock    !== currentRootLock;
  const desktopChanged = stored.desktopLock !== currentDesktopLock;
  const srcChanged     = stored.desktopSrc  !== currentDesktopSrc;

  if (rootChanged) {
    onStatus?.("Updating components…");
    await runStep("npm", ["install", "--no-audit", "--no-fund"], projectRoot);
    ranSteps.push("root npm install");
  }
  if (desktopChanged) {
    onStatus?.("Updating desktop components…");
    await runStep("npm", ["install", "--no-audit", "--no-fund"], join(projectRoot, "desktop"));
    ranSteps.push("desktop npm install");
  }
  if (srcChanged) {
    onStatus?.("Building app updates…");
    await runStep("npm", ["run", "build"], join(projectRoot, "desktop"));
    ranSteps.push("desktop tsc build");
  }

  saveState({
    version: 1,
    rootLock: currentRootLock,
    desktopLock: currentDesktopLock,
    desktopSrc: currentDesktopSrc,
    lastReconciledAt: new Date().toISOString(),
  });

  return { needsRelaunch: srcChanged, ranSteps };
}
