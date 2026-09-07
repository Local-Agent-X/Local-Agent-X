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
import { CdpOnlyOperationError, getCdpBrowserManager } from "../../browser/instance.js";
import { resolveBrowserSessionId } from "../../browser/session-owner-registry.js";
import { describeEmulation, resolveEmulationProfile, setSessionEmulation } from "../../browser/emulation.js";
import { LAYOUT_REPORT_LIST_CAP, LAYOUT_REPORT_SCRIPT } from "../../browser/layout-report.js";
import { USER_AGENTS } from "../../browser/launcher.js";
import { isBlankish } from "../../browser/blankish.js";
import { sensitivePageStub } from "../../browser/guards.js";
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

export async function handleEmulate(
  manager: BrowserBackend,
  args: Record<string, unknown>,
  sessionId: string,
): Promise<ToolResult> {
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
  // manager passes to the context runtime.
  setSessionEmulation(resolveBrowserSessionId(sessionId || "default"), profile);
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
    "the page as the emulated device sees it — a site can serve a different document per user agent.",
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
  // exists to judge UNTRUSTED script text) is not applied to it. The backend's
  // own scanEvaluateScript blocklist still runs over it — it is not bypassed
  // and was not relaxed.
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
}

/** One honest headline over the JSON so the agent does not have to parse the
 *  body to learn whether the page overflows at all. */
function layoutSummary(raw: string): string {
  let parsed: LayoutJson | null = null;
  try { parsed = JSON.parse(raw) as LayoutJson; } catch { parsed = null; }
  if (!parsed || typeof parsed.documentScroll?.horizontalOverflowPx !== "number") {
    return "Layout report (the page returned an unexpected shape — read the raw report below):";
  }
  const overflow = parsed.documentScroll.horizontalOverflowPx;
  const offenders = parsed.overflowingElementsTotal ?? 0;
  const verdict = overflow > 0
    ? `Horizontal overflow: ${overflow}px (document is wider than the viewport).`
    : "Horizontal overflow: none (document fits the viewport).";
  return (
    `${verdict} ${offenders} element(s) extend past the viewport` +
    `${offenders > LAYOUT_REPORT_LIST_CAP ? ` — the ${LAYOUT_REPORT_LIST_CAP} worst are listed` : ""}; ` +
    `${parsed.fixedAndStickyTotal ?? 0} fixed/sticky element(s); ` +
    `${parsed.matchingMediaQueriesTotal ?? 0} matching @media quer(ies). Full report:`
  );
}
