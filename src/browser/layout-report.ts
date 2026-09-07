/**
 * The layout diagnostic script — ONE read-only page probe that answers the
 * questions an agent otherwise hand-rolls (and, before this existed, wrote to
 * scratch HTML files on disk to answer): is the document wider than the
 * viewport, WHICH elements stick out, which @media queries are actually
 * matching, what colour is actually painted behind the page, and where the
 * fixed/sticky furniture sits.
 *
 * INVARIANTS (do not break these — the action's safety case rests on them):
 *  - READ-ONLY. It calls getBoundingClientRect / getComputedStyle / matchMedia
 *    and reads document.styleSheets. It assigns nothing, adds/removes no node,
 *    fires no event, and navigates nowhere.
 *  - It is a FIXED CONSTANT, never agent-supplied text. That is why the tool
 *    layer runs it without the `evaluate` mutation heuristic: there is no
 *    untrusted script to heuristically judge. It is still shipped through
 *    BrowserBackend.evaluate, so the in-app backend's own scanEvaluateScript
 *    check (in-app-backend.ts) runs over it unchanged — this script must keep
 *    clearing that blocklist rather than the blocklist being relaxed for it.
 *  - BOUNDED. Element scan, list lengths and label text are all capped so a
 *    100k-node page cannot produce an unbounded tool result.
 */

/** Max elements listed per section, and max nodes walked. */
export const LAYOUT_REPORT_LIST_CAP = 20;
export const LAYOUT_REPORT_SCAN_CAP = 4000;

export const LAYOUT_REPORT_SCRIPT = `(() => {
  const CAP = ${LAYOUT_REPORT_LIST_CAP};
  const SCAN = ${LAYOUT_REPORT_SCAN_CAP};
  const de = document.documentElement;
  const body = document.body;
  const vw = de.clientWidth;
  const vh = de.clientHeight;
  const round = (n) => Math.round(n * 100) / 100;
  const describe = (el) => {
    const tag = el.tagName.toLowerCase();
    if (el.id) return tag + "#" + el.id;
    let out = tag;
    const raw = typeof el.className === "string" ? el.className : "";
    const cls = raw.trim().split(/\\s+/).filter(Boolean).slice(0, 2);
    if (cls.length) out += "." + cls.join(".");
    const parent = el.parentElement;
    if (parent) {
      const sibs = Array.prototype.filter.call(parent.children, (c) => c.tagName === el.tagName);
      if (sibs.length > 1) out += ":nth-of-type(" + (sibs.indexOf(el) + 1) + ")";
    }
    return out;
  };
  const label = (el) => (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 60);
  const rectOf = (r) => ({ x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height), right: round(r.right), bottom: round(r.bottom) });
  const nodes = Array.prototype.slice.call(document.querySelectorAll("*"), 0, SCAN);
  const overflowing = [];
  const stuck = [];
  for (const el of nodes) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      const overRight = Math.max(0, round(r.right - vw));
      const overLeft = Math.max(0, round(-r.left));
      if (overRight > 1 || overLeft > 1) {
        overflowing.push({
          selector: describe(el), text: label(el), rect: rectOf(r),
          overflowRightPx: overRight, overflowLeftPx: overLeft,
          position: cs.position, zIndex: cs.zIndex, backgroundColor: cs.backgroundColor,
        });
      }
    }
    if (cs.position === "fixed" || cs.position === "sticky") {
      stuck.push({
        selector: describe(el), text: label(el), position: cs.position, rect: rectOf(r),
        backgroundColor: cs.backgroundColor, zIndex: cs.zIndex,
      });
    }
  }
  overflowing.sort((a, b) => (b.overflowRightPx + b.overflowLeftPx) - (a.overflowRightPx + a.overflowLeftPx));
  stuck.sort((a, b) => a.rect.y - b.rect.y);
  const matching = [];
  let unreadableSheets = 0;
  for (const sheet of Array.prototype.slice.call(document.styleSheets)) {
    let rules = null;
    try { rules = sheet.cssRules; } catch (e) { unreadableSheets++; continue; }
    if (!rules) continue;
    for (const rule of Array.prototype.slice.call(rules)) {
      const cond = rule && rule.media && rule.media.mediaText ? rule.media.mediaText : null;
      if (!cond || matching.indexOf(cond) !== -1) continue;
      try { if (matchMedia(cond).matches) matching.push(cond); } catch (e) { /* invalid condition */ }
    }
  }
  const htmlBg = getComputedStyle(de).backgroundColor;
  const bodyBg = body ? getComputedStyle(body).backgroundColor : null;
  const clear = (c) => !c || c === "transparent" || c.replace(/ /g, "") === "rgba(0,0,0,0)";
  const canvas = !clear(htmlBg) ? htmlBg : (!clear(bodyBg) ? bodyBg : "rgb(255, 255, 255) (browser default — neither html nor body paints one)");
  return {
    url: location.href,
    viewport: {
      clientWidth: vw, clientHeight: vh,
      innerWidth: innerWidth, innerHeight: innerHeight,
      devicePixelRatio: devicePixelRatio,
      userAgent: navigator.userAgent,
      maxTouchPoints: navigator.maxTouchPoints,
    },
    documentScroll: {
      scrollWidth: de.scrollWidth, clientWidth: de.clientWidth,
      horizontalOverflowPx: de.scrollWidth - de.clientWidth,
      scrollHeight: de.scrollHeight, clientHeight: de.clientHeight,
    },
    overflowingElements: overflowing.slice(0, CAP),
    overflowingElementsTotal: overflowing.length,
    overflowingElementsListed: Math.min(overflowing.length, CAP),
    fixedAndStickyElements: stuck.slice(0, CAP),
    fixedAndStickyTotal: stuck.length,
    matchingMediaQueries: matching.slice(0, CAP),
    matchingMediaQueriesTotal: matching.length,
    unreadableStyleSheets: unreadableSheets,
    backgrounds: { html: htmlBg, body: bodyBg, canvas: canvas },
    listCap: CAP,
    elementsScanned: nodes.length,
    scanTruncated: nodes.length >= SCAN,
  };
})()`;
