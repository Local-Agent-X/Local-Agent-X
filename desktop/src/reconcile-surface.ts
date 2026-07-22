// Loud boot-health surfacing for reconcile findings — extracted from
// reconcile.ts (400-LOC ceiling) when the foreign-package-manager guard
// joined the stale-dist warning. ONE mechanism, warn-and-continue (never
// throws): OS notification + splash hint now, plus a renderer health-banner
// via the "desktop-build-stale" channel (send → preload onDesktopBuildStale
// → shared-desktop.js). The send is registered on every did-finish-load —
// the listener only exists once the real app page loads (the splash ignores
// it), and re-sends survive in-app reloads.
import { showNotification } from "./hotkey-notifications";
import { setSplashHint } from "./splash-recovery";
import { getMainWindow } from "./window";

export interface DesktopHealthIssue {
  /** OS-notification title. */
  title: string;
  /** The cause sentence — shown on every surface. */
  reason: string;
  /** Action guidance appended to the OS-notification body. */
  advice: string;
  /** Short lead-in for the renderer banner ("Desktop app build is out of date"). */
  headline: string;
}

export function surfaceDesktopHealth(issue: DesktopHealthIssue): void {
  console.warn(`[desktop] ${issue.headline}: ${issue.reason}`);
  try {
    showNotification(issue.title, `${issue.reason}. ${issue.advice}`);
    setSplashHint(issue.reason);
    const w = getMainWindow();
    w?.webContents.on("did-finish-load", () => {
      try { w.webContents.send("desktop-build-stale", { reason: issue.reason, headline: issue.headline }); } catch { /* window tearing down */ }
    });
  } catch (e) { console.warn(`[desktop] could not surface health issue: ${(e as Error).message}`); }
}

/** Stale desktop dist with no rebuild scheduled — the 3-day-silent failure class. */
export function surfaceStaleDesktopDist(reason: string): void {
  surfaceDesktopHealth({
    title: "Local Agent X — app build is stale",
    reason,
    advice: "Restart, update again, or use the splash Repair button to rebuild.",
    headline: "Desktop app build is out of date",
  });
}

/** node_modules rewritten by a foreign package manager (pnpm) — reconcile is
 *  wiping and reinstalling with npm, but the user must know another tool
 *  corrupted the tree or it WILL happen again. */
export function surfaceForeignPmRewrite(reason: string): void {
  surfaceDesktopHealth({
    title: "Local Agent X — dependencies were corrupted",
    reason,
    advice: "Reinstalling with npm now. This repo is npm-managed — avoid running pnpm/yarn in it.",
    headline: "Dependencies were corrupted and reinstalled",
  });
}
