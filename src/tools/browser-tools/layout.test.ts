/**
 * Behaviour of the `emulate` and `layout_report` actions, driven end-to-end
 * through the tool's execute() so the gate pipeline (sensitive page → human
 * verification → dispatch → progress guard) is exercised, not bypassed.
 *
 * Mocked at the BACKEND boundary only: no real browser, no real page. The
 * layout script's own read-only behaviour is proven against a real DOM in
 * test/browser-layout-report-script.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const seam = vi.hoisted(() => {
  class FakeCdpOnlyOperationError extends Error {
    constructor(sessionId: string) {
      super(`in-app backend for ${sessionId}`);
      this.name = "CdpOnlyOperationError";
    }
  }
  return {
    manager: {} as Record<string, unknown>,
    cdp: {} as Record<string, unknown>,
    cdpThrows: null as Error | null,
    blockedPattern: null as string | null,
    FakeCdpOnlyOperationError,
  };
});

vi.mock("../../browser/index.js", () => ({
  getBrowserManager: () => seam.manager,
  closeBrowser: vi.fn(async () => {}),
  withBrowserLock: (_sid: string, fn: () => Promise<unknown>) => fn(),
  resetWedgedBrowser: vi.fn(async () => "recovered-in-place"),
  BrowserWedgeError: class BrowserWedgeError extends Error {},
}));
vi.mock("../../browser/instance.js", () => ({
  CdpOnlyOperationError: seam.FakeCdpOnlyOperationError,
  getCdpBrowserManager: (sessionId: string) => {
    if (seam.cdpThrows) throw seam.cdpThrows;
    void sessionId;
    return seam.cdp;
  },
}));

vi.mock("../../browser/guards.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../browser/guards.js")>();
  return {
    ...actual,
    scanEvaluateScript: (script: string) => seam.blockedPattern ?? actual.scanEvaluateScript(script),
  };
});

import { createBrowserTools } from "./index.js";
import { scanEvaluateScript } from "../../browser/guards.js";
import { LAYOUT_REPORT_SCRIPT } from "../../browser/layout-report.js";
import {
  clearSessionOwner,
  registerChildSessionOwner,
  resolveBrowserSessionId,
} from "../../browser/session-owner-registry.js";
import { _resetSessionEmulationForTest, getSessionEmulation } from "../../browser/emulation.js";

const SESSION = "layout-session";
const PAGE = "https://shop.example.com/products";

const CLEAN_REPORT = {
  url: PAGE,
  viewport: { clientWidth: 390, clientHeight: 844, innerWidth: 390, innerHeight: 844, devicePixelRatio: 3, userAgent: "iPhone", maxTouchPoints: 5 },
  documentScroll: { scrollWidth: 390, clientWidth: 390, horizontalOverflowPx: 0, scrollHeight: 2400, clientHeight: 844 },
  overflowingElements: [],
  overflowingElementsTotal: 0,
  overflowingElementsListed: 0,
  fixedAndStickyElements: [],
  fixedAndStickyTotal: 0,
  matchingMediaQueries: ["(max-width: 767px)"],
  matchingMediaQueriesTotal: 1,
  unreadableStyleSheets: 0,
  backgrounds: { html: "rgb(255, 255, 255)", body: "rgb(255, 255, 255)", canvas: "rgb(255, 255, 255)" },
  listCap: 20,
  elementsScanned: 312,
  scanTruncated: false,
};

const OVERFLOW_REPORT = {
  ...CLEAN_REPORT,
  documentScroll: { scrollWidth: 427, clientWidth: 390, horizontalOverflowPx: 37, scrollHeight: 2400, clientHeight: 844 },
  overflowingElements: [
    { selector: "div#promo-strip", text: "Free shipping over $50", rect: { x: 0, y: 0, width: 427, height: 32, right: 427, bottom: 32 }, overflowRightPx: 37, overflowLeftPx: 0, position: "static", zIndex: "auto", backgroundColor: "rgb(221, 221, 221)" },
  ],
  overflowingElementsTotal: 3,
  overflowingElementsListed: 1,
  fixedAndStickyElements: [
    { selector: "nav.site-nav", text: "Home Shop Cart", position: "fixed", rect: { x: 0, y: 32, width: 390, height: 56, right: 390, bottom: 88 }, backgroundColor: "rgb(255, 255, 255)", zIndex: "10" },
  ],
  fixedAndStickyTotal: 1,
};

/** The scan walked only the first LAYOUT_REPORT_SCAN_CAP nodes: every element
 *  count in it is a floor over the START of the document. */
const TRUNCATED_REPORT = {
  ...CLEAN_REPORT,
  overflowingElements: [],
  overflowingElementsTotal: 0,
  fixedAndStickyTotal: 0,
  elementsScanned: 4000,
  scanTruncated: true,
};

/** Every stylesheet came from a CDN, so not one @media rule was readable. */
const CDN_CSS_REPORT = {
  ...CLEAN_REPORT,
  matchingMediaQueries: [],
  matchingMediaQueriesTotal: 0,
  unreadableStyleSheets: 6,
};

function tool(sessionId: string = SESSION) {
  const [browser] = createBrowserTools(() => sessionId);
  return browser;
}

beforeEach(() => {
  _resetSessionEmulationForTest();
  for (const k of Object.keys(seam.manager)) delete seam.manager[k];
  for (const k of Object.keys(seam.cdp)) delete seam.cdp[k];
  seam.cdpThrows = null;
  seam.blockedPattern = null;
  seam.manager.getCurrentUrl = () => PAGE;
  seam.manager.observe = vi.fn(async () => ({ title: "Products", url: PAGE, currentRefs: [], crossOriginIframes: [] }));
  seam.cdp.getEngine = () => "chromium";
  seam.cdp.close = vi.fn(async () => {});
  seam.cdp.navigate = vi.fn(async () => "Navigated");
});

describe("browser emulate", () => {
  it("installs a mobile viewport AND user agent, re-opening the current page in the new context", async () => {
    const result = await tool().execute({ action: "emulate", device: "iphone", _sessionId: SESSION });

    expect(result.isError).not.toBe(true);
    const profile = getSessionEmulation(SESSION);
    expect(profile?.viewport).toEqual({ width: 390, height: 844 });
    expect(profile?.isMobile).toBe(true);
    expect(profile?.hasTouch).toBe(true);
    expect(profile?.userAgent).toMatch(/iPhone/);
    // The old context cannot be re-configured in place — it is dropped and the
    // page re-opened in the emulated one.
    expect(seam.cdp.close).toHaveBeenCalled();
    expect(seam.cdp.navigate).toHaveBeenCalledWith(PAGE);
    expect(String(result.content)).toMatch(/cookies, logins and storage/i);
  });

  it("accepts an explicit viewport + user agent without a preset", async () => {
    await tool().execute({
      action: "emulate", viewport_width: 360, viewport_height: 640,
      user_agent: "CustomMobile/1.0", is_mobile: true, _sessionId: SESSION,
    });

    expect(getSessionEmulation(SESSION)).toMatchObject({
      viewport: { width: 360, height: 640 }, userAgent: "CustomMobile/1.0", isMobile: true,
    });
  });

  it("clears emulation on device=desktop", async () => {
    await tool().execute({ action: "emulate", device: "iphone", _sessionId: SESSION });
    await tool().execute({ action: "emulate", device: "desktop", _sessionId: SESSION });

    expect(getSessionEmulation(SESSION)).toBeUndefined();
  });

  it("REFUSES on an in-app session instead of resizing the browser the user is looking at", async () => {
    seam.cdpThrows = new seam.FakeCdpOnlyOperationError(SESSION);

    const result = await tool().execute({ action: "emulate", device: "iphone", _sessionId: SESSION });

    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/in-app browser/i);
    expect(String(result.content)).toMatch(/user is looking at/i);
    // Nothing was installed and nothing was torn down.
    expect(getSessionEmulation(SESSION)).toBeUndefined();
    expect(seam.cdp.close).not.toHaveBeenCalled();
  });

  it("rejects an under-specified request without touching the session", async () => {
    const result = await tool().execute({ action: "emulate", _sessionId: SESSION });

    expect(result.isError).toBe(true);
    expect(getSessionEmulation(SESSION)).toBeUndefined();
    expect(seam.cdp.close).not.toHaveBeenCalled();
  });

  it("refuses a non-chromium engine rather than minting a context that would throw", async () => {
    seam.cdp.getEngine = () => "firefox";

    const result = await tool().execute({ action: "emulate", device: "iphone", _sessionId: SESSION });

    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/Chromium-only/i);
    expect(getSessionEmulation(SESSION)).toBeUndefined();
  });
});

describe("browser layout_report", () => {
  it("reports the overflow and the offending elements for a page that overflows", async () => {
    seam.manager.evaluate = vi.fn(async () => JSON.stringify(OVERFLOW_REPORT, null, 2));

    const result = await tool().execute({ action: "layout_report", _sessionId: SESSION });
    const text = String(result.content);

    expect(result.isError).not.toBe(true);
    expect(text).toMatch(/Horizontal overflow: 37px/);
    expect(text).toMatch(/3 element\(s\) extend past the viewport/);
    expect(text).toContain("div#promo-strip");
    expect(text).toContain("nav.site-nav");
    expect(text).toContain("(max-width: 767px)");
  });

  it("reports a clean page as clean", async () => {
    seam.manager.evaluate = vi.fn(async () => JSON.stringify(CLEAN_REPORT, null, 2));

    const text = String((await tool().execute({ action: "layout_report", _sessionId: SESSION })).content);

    expect(text).toMatch(/Horizontal overflow: none/);
    expect(text).toMatch(/0 element\(s\) extend past the viewport/);
  });

  it("never drives a mutating backend operation — one read, nothing else", async () => {
    const evaluate = vi.fn(async () => JSON.stringify(CLEAN_REPORT));
    seam.manager.evaluate = evaluate;
    for (const method of ["click", "clickByRef", "clickByText", "fill", "fillByRef", "select", "scroll", "navigate", "newTab", "dialogAccept", "dialogDismiss"]) {
      seam.manager[method] = vi.fn(async () => { throw new Error(`layout_report must not call ${method}`); });
    }

    await tool().execute({ action: "layout_report", _sessionId: SESSION });

    expect(evaluate).toHaveBeenCalledTimes(1);
    for (const method of ["click", "fill", "select", "scroll", "navigate", "dialogAccept"]) {
      expect(seam.manager[method]).not.toHaveBeenCalled();
    }
  });

  // FINDING 4: the file used to CLAIM "the backend's own scanEvaluateScript
  // blocklist still runs over it". It does not on the external-Chrome path —
  // BrowserManager.evaluate goes straight to evaluateScript — and external
  // Chrome is the only backend these actions run on. The scan now runs in the
  // handler, so the claim is a behaviour instead of a comment.
  it("runs the evaluate blocklist over its own script rather than assuming the backend did", async () => {
    seam.manager.evaluate = vi.fn(async () => JSON.stringify(CLEAN_REPORT));
    seam.blockedPattern = "some-blocked-pattern";

    const result = await tool().execute({ action: "layout_report", _sessionId: SESSION });

    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/rejected by the evaluate blocklist/i);
    expect(String(result.content)).toContain("some-blocked-pattern");
    expect(seam.manager.evaluate).not.toHaveBeenCalled();
  });

  it("and the real script clears that blocklist, so nothing had to be relaxed for it", () => {
    expect(scanEvaluateScript(LAYOUT_REPORT_SCRIPT)).toBeNull();
  });

  // FINDING 5: the summary used to surface neither scanTruncated nor
  // unreadableStyleSheets, so a 50k-node page whose offender sat at node 20,000
  // read "0 element(s) extend past the viewport", and a CDN-served site read
  // "0 matching @media quer(ies)" — the exact wrong conclusion this action
  // exists to prevent.
  it("never presents a clean element verdict off a TRUNCATED scan", async () => {
    seam.manager.evaluate = vi.fn(async () => JSON.stringify(TRUNCATED_REPORT));

    const text = String((await tool().execute({ action: "layout_report", _sessionId: SESSION })).content);
    const headline = text.split("Full report:")[0];

    expect(headline).toMatch(/INCOMPLETE/);
    expect(headline).toMatch(/scan stopped after 4000 nodes/i);
    expect(headline).toMatch(/LOWER BOUNDS/);
    // The counts are stated as floors, and the bare "0 element(s)" claim is gone.
    expect(headline).toMatch(/at least 0 element\(s\) extend past the viewport/);
    expect(headline).not.toMatch(/(?<!at least )\b0 element\(s\) extend past/);
  });

  it("never claims a page has no responsive CSS when the stylesheets were unreadable", async () => {
    seam.manager.evaluate = vi.fn(async () => JSON.stringify(CDN_CSS_REPORT));

    const text = String((await tool().execute({ action: "layout_report", _sessionId: SESSION })).content);
    const headline = text.split("Full report:")[0];

    expect(headline).toMatch(/INCOMPLETE/);
    expect(headline).toMatch(/6 stylesheet\(s\) could not be read/);
    expect(headline).toMatch(/NOT evidence that the site lacks responsive CSS/i);
    expect(headline).toMatch(/at least 0 matching @media/);
    expect(headline).not.toMatch(/(?<!at least )\b0 matching @media/);
  });

  it("stays a plain clean headline when the scan really was complete", async () => {
    seam.manager.evaluate = vi.fn(async () => JSON.stringify(CLEAN_REPORT));

    const headline = String((await tool().execute({ action: "layout_report", _sessionId: SESSION })).content)
      .split("Full report:")[0];

    expect(headline).not.toMatch(/INCOMPLETE/);
    expect(headline).not.toMatch(/at least/);
  });

  it("withholds the report on a secret-bearing page like every other page read", async () => {
    seam.manager.getCurrentUrl = () => "https://vault.bitwarden.com/passwords";
    seam.manager.evaluate = vi.fn(async () => JSON.stringify(CLEAN_REPORT));

    const result = await tool().execute({ action: "layout_report", _sessionId: SESSION });

    expect(result.isError).toBe(true);
    expect(seam.manager.evaluate).not.toHaveBeenCalled();
  });
});

/**
 * FINDING 1 (critical, shipped broken): a subagent's `emulate` hijacked its
 * PARENT CHAT's browser. Every spawned run is registered against its root chat
 * (registerChildSessionOwner), and cdpManagers / the emulation profile map are
 * both keyed by that RESOLVED id — so a subagent calling emulate rewrote the
 * parent's profile, closed the parent's context, and left the parent (and every
 * sibling) on a cookieless 390x844 iPhone page. Only the subagent was told.
 *
 * Driven through execute() so the ownership check is proven where the agent
 * actually reaches it, not on the handler in isolation.
 */
describe("emulate never re-identifies a browser the caller does not own", () => {
  const PARENT = "chat-1";
  const SUBAGENT = "agent-xyz";

  beforeEach(() => {
    // Exactly what server/handler-events.ts does when it preps a spawned run.
    registerChildSessionOwner(SUBAGENT, PARENT, { agentId: "researcher" });
  });

  afterEach(() => {
    clearSessionOwner(SUBAGENT);
    clearSessionOwner(PARENT);
  });

  it("refuses the subagent, and the parent's browser identity is untouched", async () => {
    // The premise the bug rests on: the subagent's browser IS the parent's.
    expect(resolveBrowserSessionId(SUBAGENT)).toBe(PARENT);

    const result = await tool(SUBAGENT).execute({ action: "emulate", device: "iphone", _sessionId: SUBAGENT });

    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/does not own its browser/i);
    expect(String(result.content)).toContain(PARENT);
    expect(String(result.content)).toMatch(/Ask the parent chat to run emulate/i);
    // The parent's context was NOT torn down and NO profile was installed —
    // not on the parent, not on the subagent, not on the resolved id.
    expect(seam.cdp.close).not.toHaveBeenCalled();
    expect(seam.cdp.navigate).not.toHaveBeenCalled();
    expect(getSessionEmulation(PARENT)).toBeUndefined();
    expect(getSessionEmulation(SUBAGENT)).toBeUndefined();
  });

  it("still lets the OWNER of that browser emulate it", async () => {
    const result = await tool(PARENT).execute({ action: "emulate", device: "iphone", _sessionId: PARENT });

    expect(result.isError).not.toBe(true);
    expect(getSessionEmulation(PARENT)?.viewport).toEqual({ width: 390, height: 844 });
    expect(seam.cdp.close).toHaveBeenCalled();
  });

  it("refuses before it can even consult the backend", async () => {
    seam.cdp.getEngine = () => { throw new Error("emulate must refuse before touching the backend"); };

    const result = await tool(SUBAGENT).execute({ action: "emulate", device: "iphone", _sessionId: SUBAGENT });

    expect(result.isError).toBe(true);
  });
});

describe("human-verification gate covers both new actions", () => {
  const CHALLENGE = {
    title: "Just a moment...",
    url: "https://dash.cloudflare.com/",
    currentRefs: [{ id: 1, role: "checkbox", name: "Verify you are human" }],
    crossOriginIframes: [],
  };

  it.each([
    ["emulate", { device: "iphone" }],
    ["layout_report", {}],
  ])("blocks %s while a challenge is on screen", async (action, args) => {
    seam.manager.getCurrentUrl = () => "https://dash.cloudflare.com/";
    seam.manager.observe = vi.fn(async () => CHALLENGE);
    seam.manager.evaluate = vi.fn(async () => JSON.stringify(CLEAN_REPORT));

    const result = await tool().execute({ action, ...args, _sessionId: SESSION });

    expect(result.metadata?.browserStatus).toBe("human-verification-required");
    expect(seam.manager.evaluate).not.toHaveBeenCalled();
    expect(seam.cdp.close).not.toHaveBeenCalled();
    expect(getSessionEmulation(SESSION)).toBeUndefined();
  });
});
