/**
 * Client-side interactive element extraction.
 *
 * Runs inside the page via page.evaluate. Returns rich metadata for each
 * interactive element: role, name, XPath, CSS selector, bounding rect,
 * and a stable signature used by ObservationRegistry to keep refs durable.
 *
 * The signature combines role + accessible name + structural path so small
 * DOM re-renders don't rotate the ref. Order-based tie-breakers are used
 * only when the above isn't unique.
 */
import type { Page } from "playwright";

export interface RawElement {
  role: string;
  name: string;
  tag: string;
  type: string;
  xpath: string;
  signature: string;
  inViewport: boolean;
  rect: { x: number; y: number; width: number; height: number };
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

// The extraction script is a string so Playwright can inject it verbatim into
// the page context. It has no closures over Node globals.
const EXTRACTOR_SCRIPT = `(function(args) {
  const { vpWidth, vpHeight } = args;

  const interactiveSelector =
    'a, button, input, select, textarea, [role="button"], [role="link"], ' +
    '[role="menuitem"], [role="tab"], [role="checkbox"], [role="radio"], ' +
    '[role="switch"], [role="option"], [role="treeitem"], [role="combobox"], ' +
    '[role="searchbox"], [role="textbox"], [contenteditable="true"], ' +
    '[onclick], [tabindex]:not([tabindex="-1"])';

  const interactiveTagMap = {
    BUTTON: 'button', A: 'link', SELECT: 'combobox', TEXTAREA: 'textbox',
  };

  function computeRole(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName;
    if (tag === 'INPUT') {
      const t = el.type || 'text';
      if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'range') return 'slider';
      return 'textbox';
    }
    if (interactiveTagMap[tag]) return interactiveTagMap[tag];
    if (el.getAttribute('contenteditable') === 'true') return 'textbox';
    return '';
  }

  function computeName(el) {
    // Accessible name per WAI ARIA precedence.
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const ids = labelledBy.split(/\\s+/);
      const parts = ids.map(id => (document.getElementById(id) || {}).textContent || '').filter(Boolean);
      if (parts.length) return parts.join(' ').trim();
    }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      if (el.id) {
        const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (label && label.textContent) return label.textContent.trim().slice(0, 80);
      }
      if (el.placeholder) return el.placeholder.trim();
      if (el.value && (el.type === 'submit' || el.type === 'button')) return el.value.trim();
      if (el.name) return el.name.trim();
    }
    const text = (el.textContent || '').trim().replace(/\\s+/g, ' ');
    if (text) return text.slice(0, 80);
    const title = el.getAttribute('title');
    if (title) return title.trim();
    const alt = el.getAttribute('alt');
    if (alt) return alt.trim();
    return '';
  }

  function computeXPath(el) {
    // Short XPath: id wins, otherwise indexed tag path back to a stable anchor.
    if (el.id && /^[A-Za-z_][\\w-]*$/.test(el.id)) {
      // Verify id is unique — many sites reuse ids
      if (document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) {
        return '//*[@id="' + el.id + '"]';
      }
    }
    const segments = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      let idx = 1;
      let sib = node.previousElementSibling;
      while (sib) {
        if (sib.tagName === node.tagName) idx++;
        sib = sib.previousElementSibling;
      }
      segments.unshift(node.tagName.toLowerCase() + '[' + idx + ']');
      node = node.parentElement;
      if (segments.length > 8) break;  // cap depth
    }
    return '/' + segments.join('/');
  }

  function computeSignature(el, role, name) {
    // Structural signature: role + name + tag + ancestor chain (tag names only,
    // 4 deep). This survives sibling reorderings but rotates when an element is
    // moved to a different part of the tree.
    const ancestors = [];
    let node = el.parentElement;
    for (let i = 0; i < 4 && node && node !== document.body; i++) {
      ancestors.push(node.tagName.toLowerCase());
      node = node.parentElement;
    }
    return role + '|' + name.slice(0, 40) + '|' + el.tagName + '|' + ancestors.join('>');
  }

  function isVisible(el) {
    // Skip display:none, visibility:hidden, zero-size boxes.
    if (!el.getClientRects().length) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity || '1') === 0) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    return true;
  }

  // Collect interactive elements from main document AND all same-origin
  // iframes. Cross-origin iframes can't be queried (security); we skip them.
  //
  // For iframe elements we record two things the action layer needs:
  //   - frameUrl: iframe src — used to pick the right Playwright Frame
  //   - offsetX/Y: the iframe's position in the MAIN page viewport — added
  //     to each child element's rect so the coords-based click fallback
  //     hits the right pixel. Without this offset, an element at iframe-
  //     local (200,300) gets clicked at main-page (200,300), which is
  //     wherever the iframe IS NOT.
  //
  // Live failure shape (2026-05-13, the customer PO-entry workflow on both
  // providers): React-Select dropdowns rendered inside an iframe were
  // unreachable. Snapshot saw them (extract iterated iframe content) but
  // every fill/click strategy queried the main frame's xpath/role/text,
  // and the coords fallback clicked iframe-local coords on the main
  // page. Result: "all resolution strategies failed."
  const collectRoots = () => {
    const roots = [{ doc: document, frameUrl: undefined, offsetX: 0, offsetY: 0 }];
    const frames = document.querySelectorAll('iframe, frame');
    for (const f of frames) {
      try {
        const doc = f.contentDocument;
        if (!doc) continue;
        const fr = f.getBoundingClientRect();
        roots.push({
          doc,
          frameUrl: f.getAttribute('src') || '',
          offsetX: fr.x,
          offsetY: fr.y,
        });
      } catch { /* cross-origin, skip */ }
    }
    return roots;
  };

  // Track each element's source root so we can stamp frameUrl and offset
  // the rect later. Parallel arrays beat decorating DOM elements with
  // ad-hoc properties (which can break sites' own mutation observers).
  const all = [];
  const rootByEl = new Map();
  for (const root of collectRoots()) {
    for (const el of root.doc.querySelectorAll(interactiveSelector)) {
      if (!rootByEl.has(el)) {
        rootByEl.set(el, root);
        all.push(el);
      }
    }
  }
  const seen = new Set();
  const out = [];

  for (const el of all) {
    if (seen.has(el)) continue;
    seen.add(el);
    if (!isVisible(el)) continue;

    const role = computeRole(el);
    let name = computeName(el);
    // Hard scrub: for password inputs, never let the real value leak into the
    // snapshot name. Even if autofill populated the field and something in the
    // name-resolution chain picked up the raw value, force it to the neutral
    // label 'Password'.
    if (el.tagName === 'INPUT' && el.type === 'password') {
      name = 'Password';
    }
    if (!role && !name) continue;
    if (!name && role === 'link') continue;  // anonymous link, not useful

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;

    // For iframe elements, getBoundingClientRect() returns coords in the
    // iframe document's viewport. Add the iframe's main-page offset so
    // the coords-based click fallback in actions.ts hits the right pixel.
    const root = rootByEl.get(el);
    const offsetX = root ? root.offsetX : 0;
    const offsetY = root ? root.offsetY : 0;
    const absX = rect.x + offsetX;
    const absY = rect.y + offsetY;
    const absBottom = rect.bottom + offsetY;
    const absRight = rect.right + offsetX;

    const inViewport =
      absBottom > 0 && absRight > 0 &&
      absY < vpHeight && absX < vpWidth;

    const entry = {
      role,
      name: name.replace(/\\s+/g, ' ').trim().slice(0, 120),
      tag: el.tagName,
      type: el.type || '',
      xpath: computeXPath(el),
      signature: computeSignature(el, role, name),
      inViewport,
      rect: {
        x: Math.round(absX + rect.width / 2),
        y: Math.round(absY + rect.height / 2),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
    if (root && root.frameUrl !== undefined) entry.frameUrl = root.frameUrl;
    out.push(entry);
  }

  // Dedup by signature (keeps first occurrence — usually the topmost, most-visible).
  const bySig = new Map();
  for (const el of out) {
    if (!bySig.has(el.signature)) bySig.set(el.signature, el);
  }
  return [...bySig.values()];
})`;
