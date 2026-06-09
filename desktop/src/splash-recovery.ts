/**
 * Local Agent X — Splash status + recovery affordances
 *
 * Pushes status/hint text into the splash and, on a fatal boot error, swaps
 * the spinner for Repair / Open Logs / Quit buttons. The buttons navigate to
 * a custom lax://<action> scheme (no preload on the splash) which we catch in
 * will-navigate and route to handleRecoveryAction. Extracted verbatim from
 * main.ts; wired back from there.
 */

import { app } from "electron";
import { join } from "path";

import { getMainWindow } from "./window";
import { setQuitting } from "./server-process";

// Encode an arbitrary string as a JS string literal that is safe to embed in
// code handed to executeJavaScript. JSON.stringify alone leaves U+2028/U+2029
// (legal in JSON, but a syntax error inside a JS source string) and `<`
// (which can form `</script>` / `<!--`) unescaped.
function jsLiteral(s: string): string {
  return JSON.stringify(s)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
    .replace(/</g, "\\u003C");
}

// Push status text into the splash. Splash markup lives in splash.ts —
// targets .status (main line) and #h (sub-hint). Failures are swallowed:
// the splash may have already navigated away to the real app.
export function setSplashStatus(text: string): void {
  const w = getMainWindow();
  if (!w || w.isDestroyed()) return;
  const safe = jsLiteral(text);
  w.webContents.executeJavaScript(
    `(()=>{const e=document.querySelector('.status');if(e)e.textContent=${safe};})()`
  ).catch(() => {});
}
export function setSplashHint(text: string): void {
  const w = getMainWindow();
  if (!w || w.isDestroyed()) return;
  const safe = jsLiteral(text);
  // Also clearInterval the splash's 1s ticker — otherwise its s===15 /
  // s===45 branches overwrite our hint with the default "Warming up…" /
  // "Still loading…" text a few seconds later. (splash.ts captures the
  // handle on window.__laxSplashTimer for exactly this reason.)
  w.webContents.executeJavaScript(
    `(()=>{const e=document.getElementById('h');if(e){e.textContent=${safe};e.classList.add('show');}if(window.__laxSplashTimer){clearInterval(window.__laxSplashTimer);window.__laxSplashTimer=null;}})()`
  ).catch(() => {});
}

// Fatal boot error → swap the spinner for action buttons (Repair / Open
// Logs / Quit). One universal recovery affordance that covers every
// stuck-splash class (reconcile failure, server start failure, pidfile
// conflict, internal errors) without enumerating individual causes —
// the Repair button wipes the state files boot depends on and relaunches,
// which fixes the entire class. Buttons live in splash.ts; their clicks
// navigate to lax://repair etc., intercepted below in createWindow's
// will-navigate handler installation.
export function showSplashRecovery(status: string, hint: string): void {
  setSplashStatus(status);
  setSplashHint(hint);
  const w = getMainWindow();
  if (!w || w.isDestroyed()) return;
  w.webContents.executeJavaScript("window.__laxShowRecovery&&window.__laxShowRecovery()").catch(() => {});
}

// Intercept lax://<action> clicks from the splash recovery buttons.
// data: URLs can't reach IPC (no preload), so the buttons just navigate
// to a custom scheme and we catch will-navigate. preventDefault keeps
// the renderer from chrome-erroring; we then route to the action.
export function setupSplashRecoveryIntercept(): void {
  const w = getMainWindow();
  if (!w || w.isDestroyed()) return;
  w.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("lax://")) return;
    e.preventDefault();
    const action = url.slice("lax://".length).replace(/\/+$/, "");
    handleRecoveryAction(action);
  });
}

function handleRecoveryAction(action: string): void {
  if (action === "quit") {
    setQuitting(true);
    app.quit();
    return;
  }
  if (action === "logs") {
    const fs = require("node:fs") as typeof import("node:fs");
    const logPath = join(require("os").homedir(), ".lax", "logs", "desktop-stdio.log");
    if (fs.existsSync(logPath)) {
      require("electron").shell.openPath(logPath);
    } else {
      require("electron").shell.openPath(join(require("os").homedir(), ".lax"));
    }
    return;
  }
  if (action === "repair") {
    // Wipe the state files that boot depends on. Each one corresponds to
    // a stuck-splash failure class:
    //   reconcile-state.json → reconcile thinks code is mismatched and
    //                          retries npm install/build on every boot
    //   server.pid           → "Server already running" (orphan claim)
    // We deliberately do NOT wipe config.json (port + authToken) — losing
    // those forces a fresh handshake that breaks any pinned/bookmarked
    // URLs the user has, and the user almost certainly doesn't want that.
    const fs = require("node:fs") as typeof import("node:fs");
    const lax = join(require("os").homedir(), ".lax");
    for (const file of ["reconcile-state.json", "server.pid"]) {
      try { fs.unlinkSync(join(lax, file)); } catch { /* not present — fine */ }
    }
    console.log(`[desktop] repair: wiped reconcile-state.json + server.pid, relaunching`);
    app.relaunch();
    app.exit(0);
    return;
  }
  console.warn(`[desktop] unknown recovery action: ${action}`);
}
