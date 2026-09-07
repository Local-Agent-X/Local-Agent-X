/**
 * THE emulation override on the browser routing seam.
 *
 * `emulate` changes a browser's IDENTITY — viewport, device metrics, user
 * agent — and in Playwright those are context-CREATION options, so it needs a
 * context of its own. On the in-app route the session's browser is the window
 * the USER is looking at, which must never be resized, re-UA'd, navigated or
 * closed. So while a profile is installed the session's page actions are routed
 * to a private, quarantined CDP context instead (runtime.ts mints it from the
 * profile), and the in-app backend is left untouched and still in the map. That
 * context is asked for headless and IS headless when this is the call that
 * starts Chrome; there is one shared Chrome process, so a Chrome another
 * session already started headful is reused headful and a window does appear —
 * runtime.ts getSharedBrowser is where that limit is stated. Clearing the profile — emulate device='desktop', or closeBrowser —
 * restores the in-app route and hands back the SAME backend, view and page.
 *
 * This used to be a refusal ("emulate is not available on the in-app browser"),
 * which left the capability nonexistent on the DEFAULT route and pushed agents
 * into hand-written Playwright scratch scripts.
 */

import type { BrowserRoute } from "./route-resolve.js";
import { getSessionEmulation } from "./emulation.js";

/** The route a session gets once its emulation profile is taken into account.
 *  ONLY the in-app arm is overridden: a CDP session already owns its context,
 *  and re-labelling it "emulation" would make the route log claim an in-app view
 *  is untouched for a session that has no in-app view at all. The
 *  route.kind === "in-app" guard is what makes emulationRouteLine's sentence
 *  true; emulation-route-guard.test.ts kills the mutant that drops it. */
export function applyEmulationRoute(route: BrowserRoute, ownerId: string): BrowserRoute {
  if (route.kind === "in-app" && getSessionEmulation(ownerId)) return { kind: "cdp", reason: "emulation" };
  return route;
}

/** What the route log says when a session is on its private emulated context. */
export function emulationRouteLine(who: string): string {
  return (
    `[browser-route] private emulated Chrome context ${who} — a device-emulation profile is installed; ` +
    "the user's in-app view is untouched. browser emulate device='desktop' returns to it."
  );
}
