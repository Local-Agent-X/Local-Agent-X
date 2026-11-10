/**
 * The picture a web page shows for itself, read in a hidden one-off browser
 * tab: a card's product photo when the page will not give it to a plain fetch
 * (stores answer a server-side fetch with a bot page, a captcha, 403 or 429;
 * 2026-11-09) but will to the agent's own browser.
 *
 * The tab is its own browser session, off screen (off-screen-sessions.ts), so
 * nothing appears in the desktop's Browser pane, and it is closed when the
 * lookup ends, whatever happens. It carries the asking session's security
 * lineage (taint and canaries, as aggregateBrowserSessionLineage does for a
 * sub-agent), so a page request from it is judged exactly as one from the
 * asking chat would be. One lookup runs at a time: the desktop keeps at most
 * four hidden agent views and closes the oldest past that, which must never be
 * a view a chat is using.
 */
import { randomUUID } from "node:crypto";
import { closeBrowser, getBrowserManager } from "./instance.js";
import { resolveBrowserRoute } from "./route-resolve.js";
import { markBrowserOffScreen, releaseOffScreenSession } from "./off-screen-sessions.js";
import { PAGE_IMAGES_SCRIPT } from "./page-images.js";
import { scanEvaluateScript, sensitivePageStub } from "./guards.js";
import { clearSessionTaint, propagateTaint } from "../data-lineage/taint.js";
import { clearSessionCanaries, getSessionCanaries, registerSessionCanaries } from "../threat/canaries.js";

/** How long one lookup may take before the card goes without the picture. */
export const PAGE_PICTURE_TIMEOUT_MS = 8_000;

let queue: Promise<unknown> = Promise.resolve();

/** The page's own picture (its preview image, else its first large picture),
 *  or null when the page has none, is sensitive, or did not load in time. */
export function pagePicture(url: string, onBehalfOf: string): Promise<string | null> {
  const run = queue.then(() => lookUp(url, onBehalfOf), () => lookUp(url, onBehalfOf));
  queue = run.catch(() => null);
  return run;
}

async function lookUp(url: string, onBehalfOf: string): Promise<string | null> {
  // Only the desktop's in-app views can be hidden; the external Chrome is a window.
  if (resolveBrowserRoute().kind !== "in-app") return null;
  if (sensitivePageStub(url) || scanEvaluateScript(PAGE_IMAGES_SCRIPT)) return null;
  const sessionId = `card-picture-${randomUUID()}`;
  markBrowserOffScreen(sessionId);
  propagateTaint(onBehalfOf, sessionId);
  const canaries = getSessionCanaries(onBehalfOf);
  if (canaries.length > 0) registerSessionCanaries(sessionId, canaries);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const browser = getBrowserManager(sessionId);
    const look = (async () => {
      await browser.navigate(url);
      if (sensitivePageStub(browser.getCurrentUrl())) return null;
      return firstPicture(await browser.evaluate(PAGE_IMAGES_SCRIPT));
    })();
    const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), PAGE_PICTURE_TIMEOUT_MS); });
    return await Promise.race([look.catch(() => null), late]);
  } finally {
    if (timer) clearTimeout(timer);
    await closeBrowser(sessionId).catch(() => { /* the view is already gone */ });
    releaseOffScreenSession(sessionId);
    clearSessionTaint(sessionId);
    clearSessionCanaries(sessionId);
  }
}

/** The first picture the page-images script listed (its preview image leads). */
export function firstPicture(raw: string): string | null {
  try {
    const list = JSON.parse(raw) as Array<{ src?: unknown }>;
    const src = Array.isArray(list) ? list.find((item) => typeof item?.src === "string")?.src : undefined;
    return typeof src === "string" ? src : null;
  } catch {
    return null;
  }
}
