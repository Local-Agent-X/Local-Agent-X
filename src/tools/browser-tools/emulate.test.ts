/**
 * Behaviour of the `emulate` action, driven end-to-end through the tool's
 * execute() so the gate pipeline (sensitive page → human verification →
 * dispatch → progress guard) is exercised, not bypassed.
 *
 * Mocked at the BACKEND boundary only: no real browser, no real page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
    routeKind: "cdp" as "cdp" | "in-app",
    releaseEmulated: vi.fn(async (_sessionId?: string) => {}),
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
  resolveBrowserBackendKind: () => seam.routeKind,
  getCdpBrowserManager: (sessionId: string) => {
    if (seam.cdpThrows) throw seam.cdpThrows;
    void sessionId;
    return seam.cdp;
  },
  releaseEmulatedBrowser: seam.releaseEmulated,
}));

import { createBrowserTools } from "./index.js";
import {
  clearSessionOwner,
  registerChildSessionOwner,
  resolveBrowserSessionId,
} from "../../browser/session-owner-registry.js";
import { _resetSessionEmulationForTest, getSessionEmulation } from "../../browser/emulation.js";

const SESSION = "emulate-session";
const PAGE = "https://shop.example.com/products";

function tool(sessionId: string = SESSION) {
  const [browser] = createBrowserTools(() => sessionId);
  return browser;
}

/** Every way the tool layer could MOVE the browser it was handed. On the in-app
 *  route that browser is the window the user is looking at, so after `emulate`
 *  every one of these must still be untouched — the invariant the old refusal
 *  was protecting, now proven instead of avoided. */
const MUTATING_BACKEND_CALLS = [
  "navigate", "newTab", "close", "closeTab", "switchTab", "click", "clickByRef", "clickByText",
  "fill", "fillByRef", "select", "scroll", "evaluate", "screenshot", "snapshot",
] as const;

const untouched = (): void => {
  for (const name of MUTATING_BACKEND_CALLS) {
    expect(seam.manager[name], `in-app view was driven via ${name}`).not.toHaveBeenCalled();
  }
};

beforeEach(() => {
  _resetSessionEmulationForTest();
  for (const k of Object.keys(seam.manager)) delete seam.manager[k];
  for (const k of Object.keys(seam.cdp)) delete seam.cdp[k];
  seam.cdpThrows = null;
  seam.routeKind = "cdp";
  seam.releaseEmulated.mockClear();
  seam.manager.getCurrentUrl = () => PAGE;
  seam.manager.observe = vi.fn(async () => ({ title: "Products", url: PAGE, currentRefs: [], crossOriginIframes: [] }));
  for (const name of MUTATING_BACKEND_CALLS) seam.manager[name] = vi.fn(async () => "");
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
    expect(String(result.content)).toMatch(/FRESH isolated context/);
    expect(String(result.content)).toMatch(/cookies, logins and storage/i);
    expect(String(result.content)).toMatch(/did NOT carry over/);
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

/**
 * THE in-app route. `emulate` used to refuse here outright, which meant the
 * capability did not exist on the DEFAULT route: op_chat_turn_620ed38e8d2c42bf
 * asked for a mobile-view comparison, got the refusal, and spent ~60 turns
 * hand-writing ten scratch Playwright probes instead (layout_report: 0 calls).
 *
 * The refusal was protecting a real invariant — the in-app view IS the window
 * the user is looking at — so the fix keeps that invariant and drops the
 * refusal: emulation is minted in a private headless context beside the view.
 */
describe("emulate on the in-app route runs beside the user's window, not in it", () => {
  beforeEach(() => { seam.routeKind = "in-app"; });

  it("installs the profile and leaves the in-app view completely untouched", async () => {
    const result = await tool().execute({ action: "emulate", device: "iphone", _sessionId: SESSION });

    expect(result.isError).not.toBe(true);
    // The emulation the agent asked for actually exists now.
    expect(getSessionEmulation(SESSION)).toMatchObject({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    });
    expect(getSessionEmulation(SESSION)?.userAgent).toMatch(/iPhone/);
    // …and NOTHING drove the window the user is looking at: not resized, not
    // re-UA'd, not navigated, not closed. Only its URL was read.
    untouched();
    // The page was opened in the PRIVATE context instead.
    expect(seam.cdp.navigate).toHaveBeenCalledWith(PAGE);
    const text = String(result.content);
    expect(text).toMatch(/PRIVATE, isolated, headless/);
    expect(text).toMatch(/NOT the in-app browser window/);
    expect(text).toMatch(/window is untouched/i);
  });

  it("names where subsequent actions go, and the way back", async () => {
    const text = String((await tool().execute({ action: "emulate", device: "android", _sessionId: SESSION })).content);

    expect(text).toMatch(/run against the EMULATED context/);
    expect(text).toMatch(/layout_report/);
    // read_console / read_network / read_response are in-app-only; say so
    // rather than letting the agent discover it as a mystery failure.
    expect(text).toMatch(/read_console \/ read_network \/ read_response/);
    expect(text).toMatch(/unavailable\s+while emulating/);
    expect(text).toMatch(/device='desktop'/);
  });

  it("device='desktop' closes the private context and returns to the in-app view", async () => {
    await tool().execute({ action: "emulate", device: "iphone", _sessionId: SESSION });
    seam.releaseEmulated.mockClear();

    const result = await tool().execute({ action: "emulate", device: "desktop", _sessionId: SESSION });

    expect(result.isError).not.toBe(true);
    // Profile gone → the routing seam hands the session back to its in-app view.
    expect(getSessionEmulation(SESSION)).toBeUndefined();
    // …and the emulated context is actually torn down, not leaked.
    expect(seam.releaseEmulated).toHaveBeenCalledWith(SESSION);
    expect(String(result.content)).toMatch(/back on the in-app browser view/);
    untouched();
  });

  it("drops the previous emulated context before minting the next one", async () => {
    await tool().execute({ action: "emulate", device: "iphone", _sessionId: SESSION });
    await tool().execute({ action: "emulate", device: "ipad", _sessionId: SESSION });

    expect(getSessionEmulation(SESSION)?.viewport).toEqual({ width: 820, height: 1180 });
    expect(seam.releaseEmulated).toHaveBeenCalledTimes(2);
    untouched();
  });

  it("still rejects an under-specified request without installing anything", async () => {
    const result = await tool().execute({ action: "emulate", _sessionId: SESSION });

    expect(result.isError).toBe(true);
    expect(getSessionEmulation(SESSION)).toBeUndefined();
    expect(seam.releaseEmulated).not.toHaveBeenCalled();
    untouched();
  });

  // The route can change between the read and the call (mode flip, bridge
  // returning). The CDP arm must land on the same behaviour, never on a refusal.
  it("falls back to the in-app arm when the CDP manager reports an in-app session", async () => {
    seam.routeKind = "cdp";
    seam.cdpThrows = new seam.FakeCdpOnlyOperationError(SESSION);

    const result = await tool().execute({ action: "emulate", device: "iphone", _sessionId: SESSION });

    expect(result.isError).not.toBe(true);
    expect(getSessionEmulation(SESSION)?.isMobile).toBe(true);
    untouched();
  });
});

/**
 * A subagent's `emulate` must never hijack its PARENT CHAT's browser. Every
 * spawned run is registered against its root chat (registerChildSessionOwner),
 * and cdpManagers / the emulation profile map are both keyed by that RESOLVED
 * id — so without the guard a subagent calling emulate rewrites the parent's
 * profile, closes the parent's context, and leaves the parent (and every
 * sibling) on a cookieless 390x844 iPhone page. Only the subagent is told.
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
    // The way forward must NOT read as consequence-free. Handing the job to
    // the parent closes the shared context — including THIS session's tabs
    // and refs — and nobody is told.
    expect(String(result.content)).toMatch(/parent chat CAN run emulate/i);
    expect(String(result.content)).toMatch(/this session's own tabs close too/i);
    expect(String(result.content)).toMatch(/every ref it holds goes stale/i);
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

  // This used to assert only `isError === true`. With the ownership guard
  // deleted, the stubbed getEngine throw is caught upstream and ALSO returns
  // an error result — so the test passed with the guard gone. It pins the
  // specific refusal, which only the guard can produce, and asserts the
  // backend-throw message is nowhere in the output.
  it("refuses before it can even consult the backend, with the ownership refusal and not a backend error", async () => {
    seam.cdp.getEngine = () => { throw new Error("emulate must refuse before touching the backend"); };

    const result = await tool(SUBAGENT).execute({ action: "emulate", device: "iphone", _sessionId: SUBAGENT });
    const text = String(result.content);

    expect(result.isError).toBe(true);
    expect(text).toMatch(/does not own its browser/i);
    expect(text).toContain(PARENT);
    expect(text).not.toMatch(/must refuse before touching the backend/);
  });

  // On the DEFAULT (in-app) route the CONSEQUENCE is different: emulate no
  // longer destroys the parent's context — it silently moves the parent's whole
  // session onto a private emulated one. The refusal must describe THAT, not
  // cookieless tabs that no longer happen, and must not claim the in-app route
  // refuses emulate (it no longer does).
  it("describes the in-app consequence, not the CDP one, when the shared browser is the in-app view", async () => {
    seam.routeKind = "in-app";

    const text = String((await tool(SUBAGENT).execute({ action: "emulate", device: "iphone", _sessionId: SUBAGENT })).content);

    expect(text).toMatch(/does not own its browser/i);
    expect(text).toMatch(/leaves the user's in-app window alone/i);
    expect(text).toMatch(/REDIRECTS every page action of the parent and each sibling/);
    expect(text).toMatch(/moves the parent's WHOLE session/i);
    expect(text).not.toMatch(/come back cookieless/);
    // Still a refusal: nothing installed, nothing torn down.
    expect(getSessionEmulation(PARENT)).toBeUndefined();
    expect(getSessionEmulation(SUBAGENT)).toBeUndefined();
    expect(seam.releaseEmulated).not.toHaveBeenCalled();
    untouched();
  });

  // The OWNER's success is a destructive act on every session that shares the
  // browser, and only the caller is told.
  it("tells the owner that every session sharing this browser lost its tabs and refs", async () => {
    const text = String((await tool(PARENT).execute({ action: "emulate", device: "iphone", _sessionId: PARENT })).content);

    expect(text).toMatch(/NOT a private change/i);
    expect(text).toMatch(/closing the context closed their tabs/i);
    expect(text).toMatch(/every ref they hold is now stale/i);
    // Honest about the limit rather than inventing a count.
    expect(text).toMatch(/cannot enumerate them/i);
  });
});

describe("human-verification gate covers emulate", () => {
  const CHALLENGE = {
    title: "Just a moment...",
    url: "https://dash.cloudflare.com/",
    currentRefs: [{ id: 1, role: "checkbox", name: "Verify you are human" }],
    crossOriginIframes: [],
  };

  it("blocks emulate while a challenge is on screen — BEFORE the destructive close", async () => {
    seam.manager.getCurrentUrl = () => "https://dash.cloudflare.com/";
    seam.manager.observe = vi.fn(async () => CHALLENGE);

    const result = await tool().execute({ action: "emulate", device: "iphone", _sessionId: SESSION });

    expect(result.metadata?.browserStatus).toBe("human-verification-required");
    expect(seam.cdp.close).not.toHaveBeenCalled();
    expect(getSessionEmulation(SESSION)).toBeUndefined();
  });
});

/**
 * Emulation must be expressed as a Playwright context-creation profile and
 * NEVER as a raw CDP call against the session's live page: attaching a
 * debugger to drive the CDP Emulation domain re-triggers the Cloudflare
 * Turnstile detection (bad9c360), and on the in-app route that page is the one
 * the user is looking at. Pinned at the source level so a future "quick" CDP
 * shortcut cannot land silently in either the handler or the profile module.
 *
 * The domain check is word-bounded: `sessionEmulation.get(...)` is a profile
 * map lookup, not a CDP domain, and must not trip it.
 */
describe("emulate never reaches for CDP emulation", () => {
  const FORBIDDEN = [/\bnewCDPSession\b/, /\bgetPageForView\b/, /\bEmulation\./, /\bconnectElectronCdp\b/];
  const SOURCES = ["./emulate.ts", "../../browser/emulation.ts"];

  it.each(SOURCES)("%s contains none of the forbidden CDP identifiers", (rel) => {
    const source = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    for (const ident of FORBIDDEN) expect(source).not.toMatch(ident);
  });
});
