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
 *  - BOUNDED, in WORK and not merely in output. Element scan, CSS-rule walk,
 *    list lengths AND the per-element label read are all capped, so neither a
 *    100k-node page nor deep markup can make this quadratic. The label in
 *    particular reads a bounded prefix of the subtree rather than serializing
 *    the whole of it and slicing the result.
 *
 * KNOWN GAP: `@container` queries have no representation here. There is no
 * matchMedia equivalent for container queries — evaluating one needs the
 * containing element's size, per container — so this reports @media only. A
 * page whose responsiveness is entirely container-query driven will show few
 * or no matching queries; that is a limit of the report, not a finding about
 * the page.
 */

/** Max elements listed per section, and max nodes walked. */
export const LAYOUT_REPORT_LIST_CAP = 20;
export const LAYOUT_REPORT_SCAN_CAP = 4000;
/** Max CSS rules visited across all sheets while recursing into grouping rules
 *  (@layer / @supports / nested @media), and how deep that recursion may go. */
export const LAYOUT_REPORT_RULE_CAP = 20000;
export const LAYOUT_REPORT_RULE_DEPTH = 12;
/** Per-element label budget: nodes visited and characters collected BEFORE the
 *  60-char slice. Bounds the work, not just the result. */
export const LAYOUT_REPORT_LABEL_NODES = 40;
export const LAYOUT_REPORT_LABEL_CHARS = 200;

export const LAYOUT_REPORT_SCRIPT = `(() => {
  const CAP = ${LAYOUT_REPORT_LIST_CAP};
  const SCAN = ${LAYOUT_REPORT_SCAN_CAP};
  const RULE_CAP = ${LAYOUT_REPORT_RULE_CAP};
  const RULE_DEPTH = ${LAYOUT_REPORT_RULE_DEPTH};
  const LABEL_NODES = ${LAYOUT_REPORT_LABEL_NODES};
  const LABEL_CHARS = ${LAYOUT_REPORT_LABEL_CHARS};
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
  // Bounded label. el.textContent concatenates the ENTIRE subtree before the
  // slice throws it away, which is quadratic on deep markup and ran for up to
  // SCAN elements. This walks at most LABEL_NODES nodes and stops as soon as
  // LABEL_CHARS characters have been collected.
  const label = (el) => {
    let out = "";
    let budget = LABEL_NODES;
    const collect = (node) => {
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (budget <= 0 || out.length >= LABEL_CHARS) return;
        budget--;
        if (c.nodeType === 3) out += c.nodeValue || "";
        else if (c.nodeType === 1) collect(c);
      }
    };
    collect(el);
    return out.replace(/\\s+/g, " ").trim().slice(0, 60);
  };
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
  // @media rules are NOT only top-level. In any modern (or Tailwind) build they
  // sit inside @layer / @supports / another @media, and an @import pulls a whole
  // sheet in behind one more hop. A one-level-deep loop therefore reports "0
  // matching @media queries" on sites that are entirely responsive. Recurse into
  // grouping rules, bounded by RULE_CAP total rules and RULE_DEPTH nesting.
  const matching = [];
  let unreadableSheets = 0;
  let ruleBudget = RULE_CAP;
  const noteCondition = (rule) => {
    const cond = rule && rule.media && rule.media.mediaText ? rule.media.mediaText : null;
    if (!cond || matching.indexOf(cond) !== -1) return;
    try { if (matchMedia(cond).matches) matching.push(cond); } catch (e) { /* invalid condition */ }
  };
  const walkRules = (rules, depth) => {
    if (!rules || depth > RULE_DEPTH) return;
    for (const rule of Array.prototype.slice.call(rules)) {
      if (ruleBudget <= 0) return;
      ruleBudget--;
      if (!rule) continue;
      noteCondition(rule);
      // Grouping rules (@media / @supports / @layer block / @container) expose
      // their children as cssRules; @import exposes an imported sheet, whose
      // rules are cross-origin-guarded exactly like a top-level one.
      let child = null;
      try { child = rule.cssRules || (rule.styleSheet ? rule.styleSheet.cssRules : null); }
      catch (e) { unreadableSheets++; continue; }
      if (child) walkRules(child, depth + 1);
    }
  };
  for (const sheet of Array.prototype.slice.call(document.styleSheets)) {
    let rules = null;
    try { rules = sheet.cssRules; } catch (e) { unreadableSheets++; continue; }
    walkRules(rules, 0);
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
    cssRulesTruncated: ruleBudget <= 0,
    backgrounds: { html: htmlBg, body: bodyBg, canvas: canvas },
    listCap: CAP,
    elementsScanned: nodes.length,
    scanTruncated: nodes.length >= SCAN,
  };
})()`;
