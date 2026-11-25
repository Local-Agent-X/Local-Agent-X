// Single-instance lock with stuck-holder displacement. The baseline
// Electron pattern (lock-fails → app.quit) assumes the existing holder
// is healthy. When the existing holder is hung on the splash — failed
// reconcile, dead server, etc. — that pattern strands the user with no
// way out: every shortcut click silently quits the new launch while
// the broken instance keeps the lock. The user thinks the app is dead.
//
// Fix is two-sided:
//   • New launch (acquireSingleInstance): pass a {tag:"shortcut-relaunch"}
//     payload to signal "I'm a deliberate user retry, yield if you're stuck."
//     On lock-fail, poll briefly (3s) for the lock in case the old
//     instance is in the middle of exiting.
//   • Old launch (the second-instance handler): if we receive the
//     yield-signal AND we've been on the splash past a 10s grace
//     period, exit so the new launch can take over. Outside the grace
//     window or once we've navigated to the real app, just focus.
//
// `LocalAgentX.exe --quit` asks the running instance to quit the way the
// tray's Quit does, then exits itself. A restart from outside (a coding agent
// rebuilding the app) used to force-kill it, which skips every exit step and,
// with crash reports on, reads as a crash (crash-report.ts, 2026-11-25).

import { app } from "electron";
import { setQuitting } from "./server-process";
import { isStuckOnSplash, showWindow } from "./window";

const LOCK_PAYLOAD = { tag: "shortcut-relaunch" } as const;
const QUIT_PAYLOAD = { tag: "quit" } as const;
const QUIT_FLAG = "--quit";
const STUCK_GRACE_MS = 10_000;
const LOCK_RETRY_DEADLINE_MS = 3_000;
const LOCK_RETRY_DELAY_MS = 250;

/** Take the lock, or quit this launch and return false when a healthy
 *  instance holds it. The holder then answers later launches; `onQuitRequest`
 *  is how it answers one started with --quit. A --quit launch never becomes
 *  the app: it signals the holder, if any, and exits. */
export async function acquireSingleInstance(onQuitRequest: () => void, argv: string[] = process.argv): Promise<boolean> {
  if (argv.includes(QUIT_FLAG)) {
    const nothingRunning = app.requestSingleInstanceLock(QUIT_PAYLOAD);
    console.log(nothingRunning ? "[desktop] --quit: no running instance" : "[desktop] --quit: asked the running instance to quit");
    app.quit();
    return false;
  }
  let gotLock = app.requestSingleInstanceLock(LOCK_PAYLOAD);
  if (!gotLock) {
    const retryDeadline = Date.now() + LOCK_RETRY_DEADLINE_MS;
    while (!gotLock && Date.now() < retryDeadline) {
      await new Promise((r) => setTimeout(r, LOCK_RETRY_DELAY_MS));
      gotLock = app.requestSingleInstanceLock(LOCK_PAYLOAD);
    }
    if (!gotLock) {
      // Existing holder is responsive (didn't yield within the grace
      // window). Quit and let it handle the user.
      app.quit();
      return false;
    }
    console.log("[desktop] took over from a stuck previous instance");
  }

  app.on("second-instance", (_event, _argv, _cwd, additionalData) => {
    const data = additionalData as { tag?: string } | undefined;
    if (data?.tag === QUIT_PAYLOAD.tag) {
      console.log("[desktop] a --quit launch asked this instance to quit");
      onQuitRequest();
      return;
    }
    const isShortcutRelaunch = data?.tag === "shortcut-relaunch";
    if (isShortcutRelaunch && isStuckOnSplash(STUCK_GRACE_MS)) {
      console.warn(
        "[desktop] second-instance fired while still on splash past grace period — " +
        "yielding to the new launch (user's shortcut click is the recovery signal).",
      );
      setQuitting(true);
      app.exit(0);
      return;
    }
    showWindow();
  });
  return true;
}
