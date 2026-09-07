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
 * user is looking at, so emulation is minted in a PRIVATE context BESIDE it
 * (headless when this is the call that starts Chrome — runtime.ts states the
 * reuse limit) and the session's page actions are routed there until
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
  hasInAppBackend,
  hasNonEmulatedCdpBrowser,
  releaseEmulatedBrowser,
  resolveBrowserBackendKind,
  type BrowserBackendKind,
} from "../../browser/instance.js";
import { resolveBrowserSessionId } from "../../browser/session-owner-registry.js";
import { describeEmulation, getSessionEmulation, resolveEmulationProfile, setSessionEmulation } from "../../browser/emulation.js";
import { USER_AGENTS } from "../../browser/launcher.js";
import { isBlankish } from "../../browser/blankish.js";
import { ok, err } from "./shared.js";

/** The in-app view is the browser the USER is looking at, and its page is a
 *  bridge adapter with a read-only viewportSize() (in-app-observe.ts). Nothing
 *  here may resize, re-UA, navigate or close it — so on that route emulation
 *  runs in a PRIVATE context beside it (see browser/emulation-route.ts) and the
 *  session's page actions are routed there until it is cleared. */
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

/** The route says in-app, but this session already holds a REAL external Chrome
 *  with the user's tabs in it — it fell back to CDP while the desktop bridge was
 *  down (route reason "no-desktop-bridge") and the bridge has since come back.
 *  Both browsers live at the same key, so there is no way to stand an emulated
 *  context up here without destroying that one. Refuse and say so; the previous
 *  behaviour closed it and reported "the in-app view was unchanged throughout".
 *
 *  The escape it names is `browser {action:"close"}`, and that action is NOT
 *  narrow: closeBrowser (instance.ts) closes BOTH kinds of backend at the key,
 *  so on a session that also has an in-app view it takes the user's window and
 *  every tab in it with the fallback. Prescribing it without saying so told the
 *  caller to destroy exactly what this refusal exists to protect. There is no
 *  tool-level action that closes only the CDP manager, so the cost is stated
 *  instead — and stated from the ACTUAL state of the session (hasInAppBackend),
 *  not from a guess about it. */
function fallbackBrowserRefusal(ownerId: string, alsoClosesInAppView: boolean): string {
  const cost = alsoClosesInAppView
    ? "That action is not narrow: it closes BOTH browsers this session has — the leftover fallback AND the " +
      "in-app view the user is looking at, with every tab in it. Say so before you run it, or ask the user " +
      "first; there is no action that closes only the fallback."
    : "This session has no in-app view open at the moment, so that action closes the leftover fallback and " +
      "nothing the user can see. (The same action WOULD also close the in-app view if one were open — it " +
      "closes every browser backend this session holds.)";
  return (
    `emulate cannot run here yet: this session (${ownerId}) is routed to the in-app browser, but it still ` +
    "holds an external Chrome it fell back to earlier (the desktop bridge was unavailable at the time). The " +
    "emulated context would have to take that browser's place, closing its tabs and dropping its logins. " +
    `Run browser {action:"close"} to close the leftover fallback browser first, then emulate again. ${cost}`
  );
}

/**
 * The IN-APP route. The user's WebContentsView is read (its URL) and otherwise
 * never touched: not resized, not re-UA'd, not navigated, not closed. The
 * profile is installed, any previous emulated context is dropped, and a private
 * quarantined Chromium context is minted in its place — after which
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
  if (profile && hasNonEmulatedCdpBrowser(ownerId)) {
    return err(fallbackBrowserRefusal(ownerId, hasInAppBackend(ownerId)));
  }
  const previousUrl = manager.getCurrentUrl();
  const carryUrl = previousUrl && !isBlankish(previousUrl) ? previousUrl : null;
  // Read BEFORE the write below: the clearing arm reports what it actually
  // changed, and "was a profile installed" is not recoverable afterwards.
  const wasEmulating = getSessionEmulation(ownerId) !== undefined;
  // Whether this session has an in-app view AT ALL. The emulate result used to
  // say the user's window is "still open in front of the user" unconditionally,
  // which is a claim about a window that may never have been created — a
  // session whose first browser call is `emulate` has no ElectronInAppBackend.
  const hasView = hasInAppBackend(ownerId);

  // ORDER IS LOAD-BEARING, and pinned by emulate-in-app-hazards.test.ts: the
  // profile is set FIRST, then the context dropped. Release only drops; the next
  // page access re-mints from whatever the profile then says — so releasing
  // first would let an action that interleaves on the await mint an
  // UNEMULATED context and hand it back as the emulated one.
  setSessionEmulation(ownerId, profile);
  // Drops a PREVIOUS emulated context (repeat emulate) or, when the profile was
  // just cleared, the emulated context itself. Never touches the in-app backend,
  // and never touches a CDP browser that was not minted as the emulated
  // stand-in (instance.releaseEmulatedBrowser checks that). Its return value is
  // whether a context was ACTUALLY closed — the desktop arm below reports from
  // that, not from having run.
  const closedContext = await releaseEmulatedBrowser(ownerId);
  if (!profile) {
    // device='desktop' with nothing installed is a no-op, and used to announce a
    // teardown and a restoration that never happened. Three distinguishable
    // states, three sentences.
    const leftoverFallback = hasNonEmulatedCdpBrowser(ownerId);
    const head = closedContext
      ? "Emulation cleared: the profile is removed and the private emulated context is closed. Emulation " +
        "never touched the in-app view while it was installed — it did not resize, re-UA, navigate or close " +
        "it — so that view still shows whatever it showed before, as far as this tool is concerned (the " +
        "user, or another tool, may have moved it in the meantime)."
      : wasEmulating
        ? "Emulation cleared: the profile is removed. No emulated context had been minted for it yet (no " +
          "page action ran while it was installed), so there was nothing to close."
        : "Nothing to clear: this session was not emulating. No profile was removed and no context was " +
          "closed — this call changed nothing.";
    const tail = leftoverFallback
      ? " This session is NOT on the in-app view: it still holds the external Chrome it fell back to earlier " +
        "(the desktop bridge was down at the time), so that browser is what page actions drive, what `tabs` " +
        "lists, and why read_console / read_network / read_response still refuse. It also still blocks " +
        "emulate; close it first, and read what that costs in emulate's own refusal before you do."
      : " This session is on the in-app browser view: tabs / switch_tab can reach the user's real tabs " +
        "again, and read_console / read_network / read_response work again.";
    return ok(`${head}${tail}`);
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
  // What is true about the user's window depends on whether there IS one. With
  // no ElectronInAppBackend at this key, nothing is open in front of the user
  // on this session's account and "untouched … still open" would be inventing
  // a window; the promise that matters (emulation is not driving their view) is
  // the same either way, so only the second clause moves.
  const windowClause = hasView
    ? "This session's in-app browser view was not touched by this call: not resized, not re-UA'd, not " +
      "navigated, not closed — it still holds the page it held. (Whether it is on screen at this instant is " +
      "the desktop's to say: a user ✕ on the view is not visible to this seam until the next action.)"
    : "This session has no in-app browser view open right now (nothing has opened one yet), so there is no " +
      "window of yours in front of the user to touch, and this call opened none.";
  return ok(
    `Emulating: ${describeEmulation(profile)}\n${carried}\n\n` +
    `This runs in a PRIVATE, isolated Chromium context — NOT the in-app browser window. ${windowClause} ` +
    "The context is asked for headless, and is headless unless this session's Chrome had already been " +
    "started visible by an earlier external-Chrome fallback — there is one shared Chrome process and it " +
    "cannot be relaunched without closing other sessions' tabs, so in that case a window does appear.\n\n" +
    "Until you clear it, this session's page actions — navigate, snapshot, screenshot, extract, evaluate, " +
    "layout_report, click/fill/scroll, tabs, and the secret fill/capture tools — run against the EMULATED " +
    "context. read_console / read_network / read_response read the in-app browser and are unavailable " +
    "while emulating.\n\n" +
    "THREE THINGS THAT FOLLOW, because this context is brand new and separate:\n" +
    "1. It has NO cookies and NO logins — not even the ones the user is signed in with in the window in " +
    "front of them. A login-gated page renders LOGGED OUT here, so comparing it against the desktop " +
    "rendering compares a logged-out mobile document with a logged-in desktop one. That is a different " +
    "page, not a mobile layout defect.\n" +
    "2. `tabs` now lists only THIS context's tabs. The [user tab] rows are gone and `switch_tab` can no " +
    "longer reach the tabs the user has open — so the usual escape hatch for a login-gated page (\"the user " +
    "says they're already logged in, switch to their tab\") is unavailable until you clear emulation.\n" +
    "3. A credential filled into this context is discarded with it — the next `emulate`, the next wedge " +
    "recovery, or `device='desktop'` all drop the context and the login with it.\n\n" +
    `${WAY_BACK}\n\n` +
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
