/**
 * The layout diagnostic script — ONE read-only page probe that returns RAW
 * DATA about the current page: document overflow, which elements stick out
 * past the viewport, which @media queries currently match, what colour is
 * painted behind the page, where the fixed/sticky furniture sits — plus, for
 * every count, the flags that say whether the walk producing it finished.
 *
 * This module states no verdict and its consumer must not either. A previous
 * version of this tool put a natural-language summary over the JSON, and that
 * summary was wrong three times in three reviews while the JSON held up each
 * time (see the revert 55cea840). The flags below are the contract: wherever
 * one is set, the corresponding count is a lower bound, not a total.
 *
 * INVARIANTS (the action's safety case rests on them):
 *  - READ-ONLY. It calls getBoundingClientRect / getComputedStyle / matchMedia
 *    and reads styleSheets / adoptedStyleSheets / shadowRoot. It assigns
 *    nothing, adds/removes no node, fires no event, and navigates nowhere.
 *    test/browser-layout-report-script.test.ts diffs a snapshot of observable
 *    state before and after a run; that file enumerates what the snapshot
 *    covers and what it cannot.
 *  - A FIXED CONSTANT, never agent-supplied text. The handler runs the
 *    evaluate blocklist over it itself (only the in-app backend scans
 *    internally) and refuses on a trip rather than relaxing the blocklist.
 *  - BOUNDED in WORK, not merely in output: element scan, rule walk, nesting
 *    depth, list lengths and the per-element label read are all capped.
 *
 * EVERY early return / catch in the script is accounted for. Each one either
 * increments a counter that feeds `cssWalkIncomplete` / `elementScanIncomplete`,
 * or provably loses no count (marked LOSSLESS in the script comments).
 *
 * KNOWN GAPS that no flag can detect are listed in `knownGaps` on EVERY
 * report, clean ones included: @container queries (no matchMedia equivalent),
 * closed shadow roots (undetectable), the elements inside open shadow roots
 * and iframes (counted, never measured), and the sheets inside iframes
 * (never walked).
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

/** Stated on every report. These are limits of the probe, not findings about
 *  the page, and none of them has a runtime detector. */
export const LAYOUT_REPORT_KNOWN_GAPS: readonly string[] = Object.freeze([
  "@container queries are never detected: there is no matchMedia equivalent, so matchingMediaQueries covers @media only. A page whose responsiveness is container-query driven can show zero matching queries here.",
  "Closed shadow roots cannot be detected at all, so nothing inside one is counted, measured or walked, and openShadowRoots does not include them.",
  "Elements inside open shadow roots and inside iframe documents are never measured: they are counted (openShadowRoots / iframes) but cannot appear in overflowingElements or fixedAndStickyElements.",
  "Stylesheets inside iframe documents are never walked; only the document's own sheets, its adoptedStyleSheets and the sheets of the open shadow roots that were visited are.",
]);

export const LAYOUT_REPORT_SCRIPT = `(() => {
  const CAP = ${LAYOUT_REPORT_LIST_CAP};
  const SCAN = ${LAYOUT_REPORT_SCAN_CAP};
  const RULE_CAP = ${LAYOUT_REPORT_RULE_CAP};
  const RULE_DEPTH = ${LAYOUT_REPORT_RULE_DEPTH};
  const LABEL_NODES = ${LAYOUT_REPORT_LABEL_NODES};
  const LABEL_CHARS = ${LAYOUT_REPORT_LABEL_CHARS};
  const KNOWN_GAPS = ${JSON.stringify(LAYOUT_REPORT_KNOWN_GAPS)};
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
  // Bounded label: at most LABEL_NODES nodes visited, LABEL_CHARS collected,
  // then sliced to 60. The early return inside collect() is LOSSLESS for every
  // count and flag: it shortens the display label of one element and nothing
  // else - no element is skipped because its label was cut.
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
  // COUNTED: the SCAN cap is reported as scanTruncated and feeds BOTH reason
  // fields (see scanCapped below).
  const nodes = Array.prototype.slice.call(document.querySelectorAll("*"), 0, SCAN);
  const overflowing = [];
  const stuck = [];
  // querySelectorAll("*") pierces neither shadow roots nor iframe documents.
  // Open shadow roots are collected so their sheets can be walked below -
  // COUNTED: the CAP on that list shows as shadowRootCount > shadowRootsSeen.
  // iframes are counted so the reader knows they exist.
  const shadowRootsSeen = [];
  let shadowRootCount = 0;
  let iframeCount = 0;
  let sameOriginIframeCount = 0;
  let hiddenSkipped = 0;
  for (const el of nodes) {
    const root = el.shadowRoot || null;
    if (root) {
      shadowRootCount++;
      if (shadowRootsSeen.length < CAP) shadowRootsSeen.push(root);
    }
    if (el.tagName === "IFRAME") {
      iframeCount++;
      // LOSSLESS: the iframe is already in iframeCount; this catch only means
      // it is cross-origin, i.e. not in the same-origin subset.
      try { if (el.contentDocument) sameOriginIframeCount++; } catch (e) { /* cross-origin */ }
    }
    const cs = getComputedStyle(el);
    // COUNTED: display:none / visibility:hidden elements are not measured.
    // A visibility:hidden box can still widen the document, so the number
    // skipped is reported rather than the skip being silent.
    if (cs.display === "none" || cs.visibility === "hidden") { hiddenSkipped++; continue; }
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
  // @media rules sit inside @layer / @supports / another @media in any modern
  // build, and an @import pulls a whole sheet in behind one more hop. Recurse
  // into grouping rules, bounded by RULE_CAP total rules and RULE_DEPTH nesting.
  const matching = [];
  let unreadableSheets = 0;
  let unreadableRules = 0;
  let unloadedImports = 0;
  let unevaluableConditions = 0;
  let ruleBudget = RULE_CAP;
  let ruleCapTruncations = 0;
  let depthTruncations = 0;
  const noteCondition = (rule) => {
    // LOSSLESS: no mediaText means this is not a conditional rule; a repeat
    // condition is already in the list.
    const cond = rule && rule.media && rule.media.mediaText ? rule.media.mediaText : null;
    if (!cond || matching.indexOf(cond) !== -1) return;
    // COUNTED: a condition matchMedia refuses to evaluate.
    try { if (matchMedia(cond).matches) matching.push(cond); } catch (e) { unevaluableConditions++; }
  };
  const walkRules = (rules, depth) => {
    // COUNTED: every rule below a depth-capped point is skipped.
    if (depth > RULE_DEPTH) { depthTruncations++; return; }
    for (const rule of Array.prototype.slice.call(rules)) {
      // COUNTED: rules remaining after the budget ran out are skipped.
      if (ruleBudget <= 0) { ruleCapTruncations++; return; }
      ruleBudget--;
      // COUNTED: a null entry in a rule list is a rule that was not read.
      if (!rule) { unreadableRules++; continue; }
      noteCondition(rule);
      // COUNTED: an @import whose sheet has not loaded (blocked, pending or
      // failed) contributes no rules and would otherwise vanish silently.
      if (typeof rule.href === "string" && rule.styleSheet == null) { unloadedImports++; continue; }
      // Grouping rules expose children as cssRules; @import exposes a sheet
      // whose rules are cross-origin-guarded exactly like a top-level one.
      let child = null;
      // COUNTED: a rule whose children cannot be read (cross-origin @import).
      try { child = rule.cssRules || (rule.styleSheet ? rule.styleSheet.cssRules : null); }
      catch (e) { unreadableRules++; continue; }
      // LOSSLESS: a rule with no children (a plain style rule) has nothing to walk.
      if (child) walkRules(child, depth + 1);
    }
  };
  // document.styleSheets is NOT every sheet: constructed sheets adopted by the
  // document are not in it, and each shadow root carries its own lists.
  const sheets = [];
  const addSheets = (list) => {
    // LOSSLESS: an absent list means the host has no such collection (e.g. no
    // adoptedStyleSheets support), so there are no sheets in it to walk.
    if (!list) return 0;
    let added = 0;
    for (const s of Array.prototype.slice.call(list)) {
      // COUNTED: a null entry is a sheet that was not read.
      if (s) { sheets.push(s); added++; } else { unreadableSheets++; }
    }
    return added;
  };
  addSheets(document.styleSheets);
  const adoptedSheets = addSheets(document.adoptedStyleSheets);
  let shadowSheets = 0;
  for (const root of shadowRootsSeen) {
    shadowSheets += addSheets(root.styleSheets);
    shadowSheets += addSheets(root.adoptedStyleSheets);
  }
  for (const sheet of sheets) {
    let rules = null;
    // COUNTED: cssRules threw (cross-origin) or came back null/undefined.
    try { rules = sheet.cssRules; } catch (e) { unreadableSheets++; continue; }
    if (rules == null) { unreadableSheets++; continue; }
    walkRules(rules, 0);
  }
  // ONE reason field per count, naming every reason it is incomplete. Two
  // booleans a reader has to remember to OR together is how a cap once went
  // unreported: the reader forgot to include it.
  const scanCapped = nodes.length >= SCAN;
  const cssNotes = [];
  if (unreadableSheets > 0) cssNotes.push(unreadableSheets + " stylesheet(s) could not be read (cross-origin CSS, e.g. served from a CDN, or a sheet whose rules were unavailable)");
  if (unreadableRules > 0) cssNotes.push(unreadableRules + " rule(s) could not be read or had unreadable children");
  if (unloadedImports > 0) cssNotes.push(unloadedImports + " @import rule(s) had no loaded stylesheet (blocked, still loading, or failed), so their rules were not walked");
  if (unevaluableConditions > 0) cssNotes.push(unevaluableConditions + " media condition(s) could not be evaluated by matchMedia");
  if (ruleCapTruncations > 0) cssNotes.push("the CSS rule walk hit its cap of " + RULE_CAP + " rules, so rules after that point were skipped");
  if (depthTruncations > 0) cssNotes.push("the CSS rule walk hit its nesting-depth cap of " + RULE_DEPTH + " at " + depthTruncations + " point(s) (deeply nested @layer/@supports/@media, native CSS nesting, or a long @import chain), so every rule below those points was skipped");
  if (shadowRootCount > shadowRootsSeen.length) cssNotes.push("only " + shadowRootsSeen.length + " of " + shadowRootCount + " open shadow root(s) had their stylesheets walked");
  // Sheet discovery for shadow roots and iframes happens INSIDE the element
  // loop, so a capped element scan is ALSO a capped CSS walk: a shadow root
  // past node SCAN was never seen and its sheets were never read.
  if (scanCapped) cssNotes.push("element scan capped before all shadow roots/iframes could be visited: any open shadow root or iframe after node " + SCAN + " was never seen and its stylesheets were not walked");
  if (iframeCount > 0) cssNotes.push(iframeCount + " iframe(s) are on the page and their stylesheets were NOT walked");
  const elementNotes = [];
  if (scanCapped) elementNotes.push("the element scan stopped after " + nodes.length + " nodes (its cap), so nothing later in the document was measured");
  if (shadowRootCount > 0) elementNotes.push(shadowRootCount + " open shadow root(s) were found and the elements inside them were NOT measured (the walk does not pierce shadow DOM)");
  if (iframeCount > 0) elementNotes.push(iframeCount + " iframe(s) (" + sameOriginIframeCount + " same-origin) were found and their documents were NOT measured");
  const htmlBg = getComputedStyle(de).backgroundColor;
  const bodyBg = body ? getComputedStyle(body).backgroundColor : null;
  const clear = (c) => !c || c === "transparent" || c.replace(/ /g, "") === "rgba(0,0,0,0)";
  const canvas = !clear(htmlBg) ? htmlBg : (!clear(bodyBg) ? bodyBg : "rgb(255, 255, 255) (browser default: neither html nor body paints one)");
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
    unreadableRules: unreadableRules,
    unloadedImports: unloadedImports,
    unevaluableMediaConditions: unevaluableConditions,
    cssRulesTruncated: ruleCapTruncations > 0,
    cssDepthTruncated: depthTruncations > 0,
    styleSheetsWalked: sheets.length,
    adoptedStyleSheets: adoptedSheets,
    shadowRootStyleSheets: shadowSheets,
    cssWalkIncomplete: cssNotes.length ? cssNotes.join("; ") : null,
    backgrounds: { html: htmlBg, body: bodyBg, canvas: canvas },
    listCap: CAP,
    elementsScanned: nodes.length,
    scanTruncated: scanCapped,
    hiddenElementsSkipped: hiddenSkipped,
    openShadowRoots: shadowRootCount,
    iframes: iframeCount,
    sameOriginIframes: sameOriginIframeCount,
    elementScanIncomplete: elementNotes.length ? elementNotes.join("; ") : null,
    knownGaps: KNOWN_GAPS,
  };
})()`;
