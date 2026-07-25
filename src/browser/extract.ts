/**
 * Client-side interactive element extraction — the Node-side runner and the
 * RawElement shape. The in-page script itself lives in extract-script.ts.
 *
 * Returns rich metadata for each interactive element: role, name, XPath,
 * bounding rect, a stable signature used by ObservationRegistry to keep refs
 * durable, and the element's DURABLE IDENTIFIERS (unique id / test hook / HTML
 * name / placeholder — see stable-ids.ts) which the resolution chains match
 * exactly.
 */
import type { Page } from "playwright";
import { EXTRACTOR_SCRIPT } from "./extract-script.js";
import type { StableIds } from "./stable-ids.js";

export { EXTRACTOR_SCRIPT };

export interface RawElement {
  role: string;
  name: string;
  tag: string;
  type: string;
  xpath: string;
  signature: string;
  /** Durable identity (unique id / test hook / HTML name / placeholder) when
   *  the element has any. This is what makes resolution EXACT: the fuzzy
   *  accessible `name` below is a label, not a key — `<input id="po-number"
   *  name="PO NUMBER">` has an empty accessible name and is observed under a
   *  name no locator can match back. See stable-ids.ts. */
  ids?: StableIds;
  inViewport: boolean;
  rect: { x: number; y: number; width: number; height: number };
  /** Live control state for form elements, so a snapshot shows whether a
   *  checkbox is checked or a field is filled without the agent hand-rolling a
   *  DOM sweep. Never carries the field's VALUE (leak guard) — only booleans.
   *  Absent for elements with no meaningful state (links, plain buttons). */
  state?: { checked?: boolean; disabled?: boolean; filled?: boolean };
  /** When the element lives inside a same-origin iframe, this is the
   *  iframe's `src` URL (or empty string for srcdoc/about:blank frames
   *  with no src). undefined for main-frame elements. Used by actions.ts
   *  to pick the right Playwright Frame for fill/click resolution; if
   *  resolution still fails, the rect (which we recompute in main-page
   *  coordinates below) lets the coords fallback hit the right pixel. */
  frameUrl?: string;
}

/**
 * Run the extractor inside the page. Returns a list of interactive elements.
 * Offscreen elements are included so signature tracking survives scrolling.
 */
export async function extractInteractiveElements(page: Page): Promise<RawElement[]> {
  const viewport = page.viewportSize() || { width: 1280, height: 800 };
  // Playwright's page.evaluate(string, arg) evaluates the string as an
  // EXPRESSION — it does NOT call a function literal with the arg. So we need
  // to build the string as an IIFE that has the args baked in.
  const argsJson = JSON.stringify({ vpWidth: viewport.width, vpHeight: viewport.height });
  const script = `${EXTRACTOR_SCRIPT}(${argsJson})`;
  const result = await page.evaluate(script);
  return (Array.isArray(result) ? result : []) as RawElement[];
}

