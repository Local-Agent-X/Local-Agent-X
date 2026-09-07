/**
 * Device emulation + layout diagnostics — the `emulate` and `layout_report`
 * actions.
 *
 * `emulate` sets the viewport, device metrics and user agent for the rest of
 * the session. `layout_report` answers, in ONE call, the questions an agent
 * previously hand-rolled as a dozen ad-hoc evaluate scripts (and, worse, as
 * scratch HTML files written to disk): what overflows, which @media queries
 * match, what colour is painted behind the page, where the fixed/sticky
 * furniture sits.
 *
 * Why they live together: `layout_report` is only half a diagnostic without
 * `emulate`. A site that serves phones a different document renders clean at
 * 1280x800 forever.
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
import { LAYOUT_REPORT_LIST_CAP, LAYOUT_REPORT_SCRIPT } from "../../browser/layout-report.js";
import { USER_AGENTS } from "../../browser/launcher.js";
import { isBlankish } from "../../browser/blankish.js";
import { scanEvaluateScript, sensitivePageStub } from "../../browser/guards.js";
import { wrapExternalContent } from "../../sanitize.js";
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
    "from the previous context did NOT carry over. Take a snapshot or run layout_report to see " +
    "the page as the emulated device sees it — a site can serve a different document per user agent.\n\n" +
    "This was NOT a private change. Every subagent or scheduled run spawned from this chat drives THIS " +
    "browser, so closing the context closed their tabs as well and every ref they hold is now stale — " +
    "their next click/fill by ref will miss. They were not notified (there is no channel to tell them), " +
    "and this tool cannot enumerate them, so it cannot say how many there are. If any are running, tell " +
    "them to re-observe before acting.",
  );
}

/** Report shape is documented for the agent; the numbers come from the page. */
export async function handleLayoutReport(manager: BrowserBackend): Promise<ToolResult> {
  const sensitive = sensitivePageStub(manager.getCurrentUrl());
  if (sensitive) {
    return { content: sensitive, status: "blocked", isError: true, metadata: { browserStatus: "sensitive-content-withheld" } };
  }
  // Deliberate internal call: LAYOUT_REPORT_SCRIPT is a fixed, read-only
  // constant, not agent input, so the `evaluate` mutation heuristic (which
  // exists to judge UNTRUSTED script text) is not applied to it.
  //
  // The blocklist is NOT skipped - but it is not inherited either. Only
  // ElectronInAppBackend.evaluate scans internally; BrowserManager.evaluate
  // hands the text straight to the page. layout_report (unlike emulate) runs on
  // WHICHEVER backend the session has, so on the CDP arm nothing would scan it
  // at all. The scan therefore runs HERE, on the path both backends share,
  // instead of being asserted by a comment. The constant
  // passes it (pinned in test/browser-layout-report-script.test.ts); this arm
  // fires only if the script is ever edited into something the blocklist
  // rejects, and refuses rather than relaxing the blocklist for it.
  const blocked = scanEvaluateScript(LAYOUT_REPORT_SCRIPT);
  if (blocked) {
    return err(
      "layout_report did not run: its own diagnostic script was rejected by the evaluate blocklist " +
      `(pattern ${blocked}). That is a bug in the script, not in the page - report it rather than working around it.`,
    );
  }
  const raw = await manager.evaluate(LAYOUT_REPORT_SCRIPT);
  return {
    content: `${layoutSummary(raw)}\n\n${wrapExternalContent(raw, "browser.layout_report")}`,
    metadata: { browserStatus: "layout-report" },
  };
}

interface LayoutJson {
  documentScroll?: { horizontalOverflowPx?: number };
  overflowingElementsTotal?: number;
  fixedAndStickyTotal?: number;
  matchingMediaQueriesTotal?: number;
  elementsScanned?: number;
  scanTruncated?: boolean;
  unreadableStyleSheets?: number;
  cssRulesTruncated?: boolean;
  cssDepthTruncated?: boolean;
  openShadowRoots?: number;
  iframes?: number;
  /** The script's OWN account of why each count is a floor - one field per
   *  count, naming every reason. Preferred over re-deriving from the raw
   *  counters below, which is how the depth cap went unreported: it had a
   *  counter nobody added to the OR. */
  cssWalkIncomplete?: string | null;
  elementScanIncomplete?: string | null;
}

/** Why the @media count is a floor, or null if the walk really was complete.
 *  Trusts the script's own reason string; the derived arm is a floor of its own,
 *  for a report produced before a field existed - it can only ADD a caveat. */
function cssIncompleteReason(p: LayoutJson): string | null {
  if (typeof p.cssWalkIncomplete === "string" && p.cssWalkIncomplete) return p.cssWalkIncomplete;
  const bits: string[] = [];
  const unreadable = p.unreadableStyleSheets ?? 0;
  if (unreadable > 0) bits.push(`${unreadable} stylesheet(s) could not be read (cross-origin CSS - e.g. served from a CDN)`);
  if (p.cssRulesTruncated === true) bits.push("the CSS rule walk hit its rule cap");
  if (p.cssDepthTruncated === true) bits.push("the CSS rule walk hit its nesting-depth cap, so every rule below those points was skipped");
  if ((p.iframes ?? 0) > 0) bits.push(`${p.iframes} iframe(s) had their stylesheets skipped`);
  return bits.length ? bits.join("; ") : null;
}

/** Why the element counts are floors, or null. Same contract as above. */
function elementIncompleteReason(p: LayoutJson): string | null {
  if (typeof p.elementScanIncomplete === "string" && p.elementScanIncomplete) return p.elementScanIncomplete;
  const bits: string[] = [];
  if (p.scanTruncated === true) bits.push(`the element scan stopped after ${p.elementsScanned ?? "its cap of"} nodes`);
  if ((p.openShadowRoots ?? 0) > 0) bits.push(`${p.openShadowRoots} open shadow root(s) were not measured`);
  if ((p.iframes ?? 0) > 0) bits.push(`${p.iframes} iframe(s) were not measured`);
  return bits.length ? bits.join("; ") : null;
}

/**
 * One honest headline over the JSON so the agent does not have to parse the
 * body to learn whether the page overflows at all.
 *
 * "Honest" is load-bearing, and is why the completeness flags are read here.
 * The script's element walk stops at LAYOUT_REPORT_SCAN_CAP nodes, and its
 * @media walk cannot read cross-origin stylesheets. A headline that says
 * "0 element(s) extend past the viewport" off a truncated scan, or
 * "0 matching @media quer(ies)" off a page whose CSS all came from a CDN, is
 * precisely the wrong conclusion this action exists to prevent - so an
 * incomplete count is reported as a LOWER BOUND and labelled INCOMPLETE, never
 * as a clean verdict.
 */
function layoutSummary(raw: string): string {
  let parsed: LayoutJson | null = null;
  try { parsed = JSON.parse(raw) as LayoutJson; } catch { parsed = null; }
  if (!parsed || typeof parsed.documentScroll?.horizontalOverflowPx !== "number") {
    return "Layout report (the page returned an unexpected shape — read the raw report below):";
  }
  const overflow = parsed.documentScroll.horizontalOverflowPx;
  const offenders = parsed.overflowingElementsTotal ?? 0;
  // Element counts come from a capped walk that does not pierce shadow DOM or
  // iframes; the media count comes from the sheets that could be read, to a
  // bounded rule count and nesting depth. Each is a floor, not a total, when its
  // own source was incomplete - and each reads exactly ONE reason field.
  const elementReason = elementIncompleteReason(parsed);
  const mediaReason = cssIncompleteReason(parsed);
  const mediaPartial = mediaReason !== null;
  const atLeast = elementReason !== null ? "at least " : "";
  const verdict = overflow > 0
    ? `Horizontal overflow: ${overflow}px (document is wider than the viewport).`
    : "Horizontal overflow: none at the document level (the document itself fits the viewport).";
  const body =
    `${verdict} ${atLeast}${offenders} element(s) extend past the viewport` +
    `${offenders > LAYOUT_REPORT_LIST_CAP ? ` — the ${LAYOUT_REPORT_LIST_CAP} worst are listed` : ""}; ` +
    `${atLeast}${parsed.fixedAndStickyTotal ?? 0} fixed/sticky element(s); ` +
    `${mediaPartial ? "at least " : ""}${parsed.matchingMediaQueriesTotal ?? 0} matching @media quer(ies).`;
  const caveats: string[] = [];
  if (elementReason) {
    caveats.push(
      `INCOMPLETE: ${elementReason}. The element counts above are LOWER BOUNDS. An element that was never ` +
      "measured cannot appear in them - a zero here does NOT mean the page has no overflowing elements. Scope the " +
      "check to the suspect subtree before concluding anything about the parts that were not scanned.",
    );
  }
  if (mediaReason) {
    caveats.push(
      `INCOMPLETE: ${mediaReason}, so some @media rules were never seen. The @media count above is a ` +
      "LOWER BOUND and is NOT evidence that the site lacks responsive CSS. Use emulate plus a real measurement " +
      "to tell whether the layout responds.",
    );
  }
  // Unconditional: unlike every caveat above, this gap has no detector - there
  // is no matchMedia for container queries, so a page driven entirely by them
  // looks identical to a page with no responsive CSS at all.
  caveats.push("Note: @container queries are never counted here and cannot be detected - see layout-report.ts.");
  return caveats.length ? `${body}\n${caveats.join("\n")}\nFull report:` : `${body} Full report:`;
}
