/**
 * Device emulation — the `emulate` action.
 *
 * `emulate` sets the viewport, device metrics and user agent for the rest of
 * the session. A site that serves phones a different document renders clean
 * at 1280x800 forever; this is the only way the agent can SEE the mobile
 * rendering (pair it with screenshot / snapshot).
 *
 * Emulation is expressed as a profile (browser/emulation.ts) and applied by
 * the context runtime when it mints a fresh QUARANTINED Playwright context —
 * never as a raw CDP call (the Emulation domain) against a live page, which
 * would attach a debugger to the browser the user is looking at.
 *
 * TWO ARMS. On the CDP route the session's own context is re-minted emulated.
 * On the IN-APP route (the default) the session's browser is the window the
 * user is looking at, so emulation is minted in a PRIVATE headless context
 * BESIDE it and the session's page actions are routed there until
 * `device='desktop'` clears it — see browser/emulation-route.ts. This used to
 * be a flat refusal, which left the capability nonexistent on the default route.
 */

import type { ToolResult } from "../../types.js";
import type { BrowserBackend } from "../../browser/backend.js";
import type { BrowserManager } from "../../browser/manager.js";
// Concrete modules, not the barrel: the dispatcher's tests mock
// ../../browser/index.js with a hand-written factory, and a handler that
// reaches for extra barrel exports would break every one of them.
import {
  CdpOnlyOperationError,
  getCdpBrowserManager,
  releaseEmulatedBrowser,
  resolveBrowserBackendKind,
  type BrowserBackendKind,
} from "../../browser/instance.js";
import { resolveBrowserSessionId } from "../../browser/session-owner-registry.js";
import { describeEmulation, resolveEmulationProfile, setSessionEmulation } from "../../browser/emulation.js";
import { USER_AGENTS } from "../../browser/launcher.js";
import { isBlankish } from "../../browser/blankish.js";
import { ok, err } from "./shared.js";

/** The in-app view is the browser the USER is looking at, and its page is a
 *  bridge adapter with a read-only viewportSize() (in-app-observe.ts). Nothing
 *  here may resize, re-UA, navigate or close it — so on that route emulation
 *  runs in a PRIVATE headless context beside it (see browser/emulation-route.ts)
 *  and the session's page actions are routed there until it is cleared. */
const WAY_BACK = "Run emulate with device='desktop' to close the emulated context and put this session " +
  "back on the in-app browser view.";

/** A subagent (or any child run) resolves to its ROOT CHAT's browser session:
 *  registerChildSessionOwner flattens every spawned run onto the parent chat,
 *  and every browser seam - cdpManagers, the emulation profile map, the tab
 *  registry - is keyed by that RESOLVED id. `emulate` is the one action that
 *  changes a browser IDENTITY rather than a page: it rewrites the profile and
 *  then closes the context so the next access re-mints it. Run by a non-owner
 *  that is a cross-session hijack - the parent chat and every sibling silently
 *  lose their cookies, logins and viewport, and only the caller is told. So the
 *  caller must own the browser it is about to re-identify. Refuse, name the
 *  reason, name the way forward. */
function sharedBrowserRefusal(sessionId: string, ownerId: string, route: BrowserBackendKind): string {
  // The consequence and the way forward both depend on the OWNER's route. On
  // the in-app route emulate no longer destroys anything: it stands a private
  // emulated context up beside the user's untouched view. What it still does is
  // MOVE the whole shared session onto that context - silently, for the parent
  // and every sibling - which is exactly what a non-owner may not do.
  const consequence = route === "in-app"
    ? "emulate re-identifies that browser. On this route it leaves the user's in-app window alone, but it " +
      "REDIRECTS every page action of the parent and each sibling onto a private emulated context: their next " +
      "click/fill by ref misses, their next snapshot describes a different page, and none of them are told."
    : "emulate re-identifies that browser: it installs a new viewport and user agent and DESTROYS the shared " +
      "context, so every logged-in tab the parent has open would come back cookieless, and the parent would " +
      "never be told.";
  const forward = route === "in-app"
    ? "The parent chat CAN run emulate here (and undo it with device='desktop'), but doing so moves the parent's " +
      "WHOLE session onto the emulated context, not just yours - so ask for it explicitly rather than assuming " +
      "it is free. Prefer doing this work in a session that owns its own browser."
    : "The parent chat CAN run emulate (and clear it with device='desktop' afterwards) - but that is not free: it " +
      "closes the shared context, so this session's own tabs close too and every ref it holds goes stale, with no " +
      "notification to anyone but the caller. Prefer doing this work in a session that owns its own browser.";
  return (
    `emulate is not available here: this session (${sessionId}) does not own its browser - it drives ` +
    `the browser of session ${ownerId} (the chat that spawned it), which its parent and any sibling ` +
    `agents are using at the same time. ${consequence} ${forward}`
  );
}

/** Which browser this session's route selects — it picks the arm below AND the
 *  wording of the ownership refusal. A pure read of the routing matrix (config +
 *  env); it opens nothing and mints nothing. A throw here must not turn a
 *  refusal into a crash, so it fails to "cdp", whose arm re-checks the route at
 *  getCdpBrowserManager and falls back to the in-app arm if it was wrong. */
function sessionRouteKind(): BrowserBackendKind {
  try { return resolveBrowserBackendKind(); } catch { return "cdp"; }
}

/**
 * The IN-APP route. The user's WebContentsView is read (its URL) and otherwise
 * never touched: not resized, not re-UA'd, not navigated, not closed. The
 * profile is installed, any previous emulated context is dropped, and a private
 * quarantined headless Chromium context is minted in its place — after which
 * browser/emulation-route.ts routes this session's page actions there until
 * `device='desktop'` clears it.
 */
async function emulateBesideInAppView(
  manager: BrowserBackend,
  args: Record<string, unknown>,
  ownerId: string,
): Promise<ToolResult> {
  // The in-app view is Chromium; there is no engine to choose here.
  const resolved = resolveEmulationProfile(args, USER_AGENTS.chromium);
  if ("error" in resolved) return err(resolved.error);
  const { profile } = resolved;
  const previousUrl = manager.getCurrentUrl();
  const carryUrl = previousUrl && !isBlankish(previousUrl) ? previousUrl : null;

  setSessionEmulation(ownerId, profile);
  // Drops a PREVIOUS emulated context (repeat emulate) or, when the profile was
  // just cleared, the emulated context itself. Never touches the in-app backend.
  await releaseEmulatedBrowser(ownerId);
  if (!profile) {
    return ok(
      "Emulation cleared. The private emulated context is closed and this session is back on the in-app " +
      "browser view — which was unchanged throughout: same window, same size, same user agent, same page.",
    );
  }

  let carried = "No page was open, so nothing was opened in it.";
  if (carryUrl) {
    try {
      await getCdpBrowserManager(ownerId).navigate(carryUrl);
      carried = `Opened ${carryUrl} in it.`;
    } catch (error) {
      carried = `Could not open ${carryUrl}: ${(error as Error).message} — navigate again to continue.`;
    }
  }
  return ok(
    `Emulating: ${describeEmulation(profile)}\n${carried}\n\n` +
    "This runs in a PRIVATE, isolated, headless Chromium context — NOT the in-app browser window. That " +
    "window is untouched: same size, same user agent, same page, still open in front of the user.\n\n" +
    "Until you clear it, this session's page actions — navigate, snapshot, screenshot, extract, evaluate, " +
    "layout_report, click/fill/scroll, tabs — run against the EMULATED context, which starts with no cookies " +
    "or logins. read_console / read_network / read_response read the in-app browser and are unavailable " +
    `while emulating.\n\n${WAY_BACK}\n\n` +
    "Next: layout_report to get the raw layout data for this width (what overflows, which @media conditions " +
    "match, what the fixed/sticky elements are), or screenshot to see the rendering.",
  );
}

export async function handleEmulate(
  manager: BrowserBackend,
  args: Record<string, unknown>,
  sessionId: string,
): Promise<ToolResult> {
  // BEFORE any state is touched - the profile write and cdp.close() below are
  // both unrecoverable for the owner.
  const actingId = sessionId || "default";
  const ownerId = resolveBrowserSessionId(actingId);
  if (ownerId !== actingId) return err(sharedBrowserRefusal(actingId, ownerId, sessionRouteKind()));
  if (sessionRouteKind() === "in-app") return await emulateBesideInAppView(manager, args, ownerId);
  let cdp: BrowserManager;
  try {
    cdp = getCdpBrowserManager(sessionId);
  } catch (error) {
    // The route flipped between the read above and this call (a mid-session
    // mode change, or the desktop bridge coming back). Same answer, one seam.
    if (error instanceof CdpOnlyOperationError) return await emulateBesideInAppView(manager, args, ownerId);
    throw error;
  }
  const engine = cdp.getEngine();
  if (engine !== "chromium") {
    return err(
      `emulate is Chromium-only (isMobile/hasTouch are unsupported on ${engine}). ` +
      "Switch the session to the chromium engine and try again.",
    );
  }
  const resolved = resolveEmulationProfile(args, USER_AGENTS[engine]);
  if ("error" in resolved) return err(resolved.error);
  const { profile } = resolved;

  const previousUrl = manager.getCurrentUrl();
  const carryUrl = previousUrl && !isBlankish(previousUrl) ? previousUrl : null;
  // The profile is keyed by the RESOLVED session id — the same ownerId the
  // manager passes to the context runtime. The guard at the top of this
  // function has already established that ownerId === actingId, so this can
  // only ever re-identify the CALLER's own browser.
  setSessionEmulation(ownerId, profile);
  // Playwright cannot mutate these options on a live context, so the session's
  // context is dropped here and re-minted (emulated) on the next page access.
  await cdp.close();

  let carried = "No page was open, so nothing was re-opened.";
  if (carryUrl) {
    try {
      await cdp.navigate(carryUrl);
      carried = `Re-opened ${carryUrl} in the new context.`;
    } catch (error) {
      carried = `Could not re-open ${carryUrl}: ${(error as Error).message} — navigate again to continue.`;
    }
  }
  const header = profile
    ? `Emulating: ${describeEmulation(profile)}`
    : "Emulation cleared — back to the default desktop viewport and user agent.";
  return ok(
    `${header}\n${carried}\n\n` +
    "This session's browser now runs in a FRESH isolated context: cookies, logins and storage " +
    "from the previous context did NOT carry over. Take a screenshot or snapshot to see the page " +
    "as the emulated device sees it — a site can serve a different document per user agent.\n\n" +
    "This was NOT a private change. Every subagent or scheduled run spawned from this chat drives THIS " +
    "browser, so closing the context closed their tabs as well and every ref they hold is now stale — " +
    "their next click/fill by ref will miss. They were not notified (there is no channel to tell them), " +
    "and this tool cannot enumerate them, so it cannot say how many there are. If any are running, tell " +
    "them to re-observe before acting.",
  );
}
