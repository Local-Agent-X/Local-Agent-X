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
 *  here may resize or re-UA it. */
const IN_APP_REFUSAL =
  "emulate is not available on the in-app browser: that view is the window the user is " +
  "looking at, so resizing it or changing its user agent would move the user's own browser. " +
  "Emulation runs in a separate, isolated Chrome context — set browserMode to an external-Chrome " +
  "mode (or run with LAX_BROWSER_HEADLESS=1) for this session and try again.";

/** A subagent (or any child run) resolves to its ROOT CHAT's browser session:
 *  registerChildSessionOwner flattens every spawned run onto the parent chat,
 *  and every browser seam - cdpManagers, the emulation profile map, the tab
 *  registry - is keyed by that RESOLVED id. `emulate` is the one action that
 *  changes a browser IDENTITY rather than a page: it rewrites the profile and
 *  then closes the context so the next access re-mints it. Run by a non-owner
 *  that is a cross-session hijack - the parent chat and every sibling silently
 *  lose their cookies, logins and viewport, and only the caller is told. So the
 *  caller must own the browser it is about to re-identify. Same shape as the
 *  in-app refusal above: refuse, name the reason, name the way forward. */
function sharedBrowserRefusal(sessionId: string, ownerId: string, route: BrowserBackendKind): string {
  // The way forward has to match the OWNER's route. On the in-app route (the
  // default) "ask the parent to run emulate" is a dead end: the parent hits
  // IN_APP_REFUSAL, because the shared browser there is the view the user is
  // looking at. Only the CDP route can honour the suggestion at all.
  const forward = route === "in-app"
    ? "Telling the parent to run emulate will NOT work either on this session's route: the shared browser is the " +
      "in-app view the user is looking at, and emulate refuses there. Do this work in a session whose browserMode " +
      "selects external Chrome (or run with LAX_BROWSER_HEADLESS=1), where the browser is the agent's own."
    : "The parent chat CAN run emulate (and clear it with device='desktop' afterwards) - but that is not free: it " +
      "closes the shared context, so this session's own tabs close too and every ref it holds goes stale, with no " +
      "notification to anyone but the caller. Prefer doing this work in a session that owns its own browser.";
  return (
    `emulate is not available here: this session (${sessionId}) does not own its browser - it drives ` +
    `the browser of session ${ownerId} (the chat that spawned it), which its parent and any sibling ` +
    "agents are using at the same time. emulate re-identifies that browser: it installs a new viewport " +
    "and user agent and DESTROYS the shared context, so every logged-in tab the parent has open would " +
    `come back cookieless, and the parent would never be told. ${forward}`
  );
}

/** Which browser this session would get, for message accuracy only. A pure read
 *  of the routing matrix (config + env); it opens nothing and mints nothing. A
 *  throw here must not turn a refusal into a crash, so it fails to "cdp" - the
 *  arm whose advice is merely less specific, never the arm that is a dead end. */
function routeKindForMessage(): BrowserBackendKind {
  try { return resolveBrowserBackendKind(); } catch { return "cdp"; }
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
  if (ownerId !== actingId) return err(sharedBrowserRefusal(actingId, ownerId, routeKindForMessage()));
  let cdp: BrowserManager;
  try {
    // Doubles as THE in-app refusal: this throws rather than opening a second
    // browser identity beside the session's live view.
    cdp = getCdpBrowserManager(sessionId);
  } catch (error) {
    if (error instanceof CdpOnlyOperationError) return err(IN_APP_REFUSAL);
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
