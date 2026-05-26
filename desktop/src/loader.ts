// Thin bootstrap loader. The .app's package.json "main" points here, not at
// main.ts directly. Purpose: hot-load the on-disk desktop/dist/main.js when
// it exists, falling back to the bundled main.js otherwise.
//
// Why: electron-builder bakes the compiled main process into app.asar, but
// reconcile.ts rebuilds desktop/dist/ on disk after a `git pull`. Without
// this loader, those rebuilt files never run — the .app keeps loading the
// frozen asar version, and changes to app-menu.ts / ipc.ts / splash.ts etc.
// silently take no effect until the user reinstalls the .dmg. The server is
// already disk-loaded (tsx spawn), so source changes there worked; this
// closes the same loop for the Electron main process.
//
// Fresh install path (no on-disk dist yet): existsSync returns false →
// require the bundled main.js next door. Once the user runs the app once,
// reconcile compiles dist/main.js to disk, app.relaunch() fires, and the
// next launch picks up the disk copy. All subsequent launches use disk.

import { app } from "electron";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// Pin the userData folder name BEFORE Electron resolves app.getPath('userData').
// Without this, Electron falls back to package.json's `name` field — which
// is sometimes correct, but on Windows + with our loader bootstrap pattern
// can race and resolve to the literal default "electron", landing localStorage
// + IndexedDB + cookies at %APPDATA%\electron\ (mac: ~/Library/Application
// Support/electron/). Setting the name here makes the location deterministic
// across platforms: <appData>/Local Agent X/.
//
// Important: must run before any code that calls app.getPath('userData') or
// triggers Electron to resolve the userData path internally (BrowserWindow,
// session, etc.). The loader runs ahead of any of that, so this is the
// right place — earlier than even main.ts.
app.setName("Local Agent X");

function resolveDiskMain(): string | null {
  // config.json's projectRoot is the source-of-truth for where the user's
  // source tree lives. We read it directly here rather than importing
  // config.ts because that would create a circular dependency (config
  // loads at module-eval, and we want this loader to run BEFORE any of
  // the bundled main's modules touch the filesystem).
  try {
    const cfgPath = join(homedir(), ".lax", "config.json");
    if (!existsSync(cfgPath)) return null;
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) as { projectRoot?: string };
    if (!cfg.projectRoot) return null;
    const diskMain = join(cfg.projectRoot, "desktop", "dist", "main.js");
    return existsSync(diskMain) ? diskMain : null;
  } catch {
    return null;
  }
}

const diskMain = resolveDiskMain();
if (diskMain) {
  console.log(`[loader] using on-disk main: ${diskMain}`);
  try {
    require(diskMain);
  } catch (e) {
    // On-disk main is corrupted / version-mismatched / a syntax error
    // landed in source. Don't strand the user — fall back to the bundled
    // copy. They can delete desktop/dist/main.js to force a rebuild next
    // launch. We log loudly so the failure is visible in stdio.log.
    console.error(`[loader] on-disk main failed (${(e as Error).message}); falling back to bundled`);
    require("./main.js");
  }
} else {
  console.log(`[loader] no on-disk main found, using bundled`);
  require("./main.js");
}
