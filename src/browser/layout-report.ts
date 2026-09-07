/**
 * The layout diagnostic script — one read-only page probe that returns RAW
 * DATA about the current page as a compact JSON string: document overflow,
 * elements whose rect extends past the viewport, currently matching @media
 * conditions, html/body/canvas background colours, fixed/sticky geometry,
 * and per-count completeness flags.
 *
 * This module states no verdict and its consumer adds none (see the revert
 * 55cea840 for why). Where a flag is set, the count it covers is a floor.
 *
 * What the named tests prove (test/browser-layout-report-script.test.ts unless
 * noted; nothing beyond these is claimed here):
 *  - "finds the element that overflows the viewport and names it" — measuring;
 *    the rest of the "measures" and "selectors and rows" blocks — left-edge
 *    overflow, zero-size on either axis, backgrounds, innerWidth, fixed/sticky
 *    ordering by y, nth-of-type, class selectors, the row's position.
 *  - "compact JSON, flags before lists, under the evaluate cap at 200 rows
 *    through the real evaluateScript" — the output survives page-ops'
 *    8,000-char evaluate truncation with its flags intact (F1).
 *  - "a 20,000-char url, 200 overflowing, 30 fixed and quote-heavy labels
 *    still fit the budget with every flag present" — url and userAgent are
 *    bounded before sizing, so the trim has only list rows left to spend.
 *  - "trims the LONGEST list first, so the primary list is the last to empty"
 *    — the trim policy.
 *  - "*Listed is min(total, listCap) with no trim" — the listed counts.
 *  - "scan cap fires only when a node was skipped" — scanTruncated semantics.
 *  - the "silent skip" describe blocks — one test per counted early return /
 *    catch in the CSS walk and the element scan listed in those blocks,
 *    including a disabled sheet and a sheet-level media condition.
 *  - "leaves the observable state byte-identical and calls no intercepted
 *    API" plus the ESCAPES table — no mutation of the state that harness
 *    enumerates; the harness header lists what it does and does not cover.
 *  - layout-report.test.ts (handler): the constant clears scanEvaluateScript
 *    and the handler refuses if it ever stops clearing it.
 *
 * `knownGaps` is on the report unconditionally (test "lists @container and
 * closed shadow roots on a clean report").
 */

/** Max elements listed per section, and max nodes walked. */
export const LAYOUT_REPORT_LIST_CAP = 20;
export const LAYOUT_REPORT_SCAN_CAP = 4000;
/** Max CSS rules visited across the walked sheets while recursing into grouping rules
 *  (@layer / @supports / nested @media), and how deep that recursion may go. */
export const LAYOUT_REPORT_RULE_CAP = 20000;
export const LAYOUT_REPORT_RULE_DEPTH = 12;
/** Per-element label budget: nodes visited and characters collected BEFORE the
 *  60-char slice. Bounds the work, not just the result. */
export const LAYOUT_REPORT_LABEL_NODES = 40;
export const LAYOUT_REPORT_LABEL_CHARS = 200;
/** Size budget for the compact JSON the script returns. page-ops.evaluateScript
 *  hard-truncates evaluate output at MAX_TEXT_LENGTH (8,000, launcher.ts) and a
 *  truncated document is not JSON, so the script trims its LISTS from the tail
 *  — one row at a time from whichever list is currently longest (ties: media
 *  queries, then fixed/sticky, then overflowing) — until the whole document
 *  fits, and records that in `listsTrimmedForSize`. */
export const LAYOUT_REPORT_MAX_CHARS = 7_800;
/** Page-supplied strings are sliced BEFORE sizing, so the trim above only ever
 *  has list rows to spend: url and userAgent (flagged urlTruncated /
 *  userAgentTruncated), each selector (an id or class name is unbounded), each
 *  media condition text, and each label (60, above). The remaining strings are
 *  computed keywords/colours and the fixed-text notes. Test: "a 20,000-char
 *  url, 200 overflowing, 30 fixed and quote-heavy labels still fit the budget
 *  with every flag present". */
export const LAYOUT_REPORT_URL_MAX = 2_048;
export const LAYOUT_REPORT_USER_AGENT_MAX = 512;
export const LAYOUT_REPORT_SELECTOR_CHARS = 120;
export const LAYOUT_REPORT_MEDIA_CHARS = 200;

/** Stated on the report unconditionally. These are limits of the probe, not
 *  findings about the page, and none of them has a runtime detector. */
export const LAYOUT_REPORT_KNOWN_GAPS: readonly string[] = Object.freeze([
  "@container queries are not detected: there is no matchMedia equivalent, so matchingMediaQueries covers @media only. A page whose responsiveness is container-query driven can show zero matching queries here.",
  "Closed shadow roots are not detectable, so nothing inside one is counted, measured or walked, and openShadowRoots does not include them.",
  "Elements inside open shadow roots and inside iframe documents are not measured: they are counted (openShadowRoots / iframes) but do not appear in overflowingElements or fixedAndStickyElements.",
  "Stylesheets inside iframe documents are not walked; only the document's own sheets, its adoptedStyleSheets and the sheets of the open shadow roots that were visited are.",
]);

export const LAYOUT_REPORT_SCRIPT = `(() => {
  const CAP = ${LAYOUT_REPORT_LIST_CAP};
  const SCAN = ${LAYOUT_REPORT_SCAN_CAP};
  const RULE_CAP = ${LAYOUT_REPORT_RULE_CAP};
  const RULE_DEPTH = ${LAYOUT_REPORT_RULE_DEPTH};
  const LABEL_NODES = ${LAYOUT_REPORT_LABEL_NODES};
  const LABEL_CHARS = ${LAYOUT_REPORT_LABEL_CHARS};
  const MAX_CHARS = ${LAYOUT_REPORT_MAX_CHARS};
  const URL_MAX = ${LAYOUT_REPORT_URL_MAX};
  const UA_MAX = ${LAYOUT_REPORT_USER_AGENT_MAX};
  const SELECTOR_CHARS = ${LAYOUT_REPORT_SELECTOR_CHARS};
  const MEDIA_CHARS = ${LAYOUT_REPORT_MEDIA_CHARS};
  const KNOWN_GAPS = ${JSON.stringify(LAYOUT_REPORT_KNOWN_GAPS)};
  const de = document.documentElement;
  const body = document.body;
  const vw = de.clientWidth;
  const vh = de.clientHeight;
  const round = (n) => Math.round(n * 100) / 100;
  // tag#id, else tag + up to 2 classes + :nth-of-type among same-tag
  // siblings; sliced to SELECTOR_CHARS because an id or class is page text.
  const describe = (el) => {
    const tag = el.tagName.toLowerCase();
    if (el.id) return (tag + "#" + el.id).slice(0, SELECTOR_CHARS);
    let out = tag;
    const raw = typeof el.className === "string" ? el.className : "";
    const cls = raw.trim().split(/\\s+/).filter(Boolean).slice(0, 2);
    if (cls.length) out += "." + cls.join(".");
    const parent = el.parentElement;
    if (parent) {
      const sibs = Array.prototype.filter.call(parent.children, (c) => c.tagName === el.tagName);
      if (sibs.length > 1) out += ":nth-of-type(" + (sibs.indexOf(el) + 1) + ")";
    }
    return out.slice(0, SELECTOR_CHARS);
  };
  // Bounded label: at most LABEL_NODES nodes visited, LABEL_CHARS collected,
  // then sliced to 60. The early return inside collect() shortens the display
  // label of one element and touches no count or flag.
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
  // COUNTED: scanTruncated is true only when at least one node past SCAN
  // existed and was skipped; it feeds BOTH reason fields (see below).
  const allNodes = document.querySelectorAll("*");
  const scanCapped = allNodes.length > SCAN;
  const nodes = Array.prototype.slice.call(allNodes, 0, SCAN);
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
  let zeroSizeSkipped = 0;
  for (const el of nodes) {
    const root = el.shadowRoot || null;
    if (root) {
      shadowRootCount++;
      if (shadowRootsSeen.length < CAP) shadowRootsSeen.push(root);
    }
    if (el.tagName === "IFRAME") {
      iframeCount++;
      // The iframe is already in iframeCount; this catch only means it is
      // cross-origin, i.e. not in the same-origin subset.
      try { if (el.contentDocument) sameOriginIframeCount++; } catch (e) { /* cross-origin */ }
    }
    const cs = getComputedStyle(el);
    // COUNTED: display:none / visibility:hidden elements are not measured.
    // A visibility:hidden box can still widen the document, so the number
    // skipped is reported rather than the skip being silent.
    if (cs.display === "none" || cs.visibility === "hidden") { hiddenSkipped++; continue; }
    const r = el.getBoundingClientRect();
    // COUNTED: a zero-size rect is not measured for overflow (reported as
    // zeroSizeElementsSkipped). Any positive rounded overflow is listed; there
    // is no sub-pixel tolerance beyond the 2-decimal rounding.
    if (r.width > 0 && r.height > 0) {
      const overRight = Math.max(0, round(r.right - vw));
      const overLeft = Math.max(0, round(-r.left));
      if (overRight > 0 || overLeft > 0) {
        overflowing.push({
          selector: describe(el), text: label(el), rect: rectOf(r),
          overflowRightPx: overRight, overflowLeftPx: overLeft,
          position: cs.position, zIndex: cs.zIndex, backgroundColor: cs.backgroundColor,
        });
      }
    } else {
      zeroSizeSkipped++;
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
    // No mediaText means this is not a conditional rule; a repeat condition
    // is already in the list. Evaluated in full, listed sliced to MEDIA_CHARS.
    const cond = rule && rule.media && rule.media.mediaText ? rule.media.mediaText : null;
    if (!cond) return;
    const listed = cond.slice(0, MEDIA_CHARS);
    if (matching.indexOf(listed) !== -1) return;
    // COUNTED: a condition matchMedia refuses to evaluate.
    try { if (matchMedia(cond).matches) matching.push(listed); } catch (e) { unevaluableConditions++; }
  };
  const walkRules = (rules, depth) => {
    // COUNTED: the caller only recurses into a NON-EMPTY child list, so a
    // trip here means rules below this point were skipped.
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
      // whose rules are cross-origin-guarded like a top-level one.
      let child = null;
      // COUNTED: a rule whose children threw on read (cross-origin @import).
      try { child = rule.cssRules || (rule.styleSheet ? rule.styleSheet.cssRules : null); }
      catch (e) { unreadableRules++; continue; }
      // An empty child list (a plain style rule; in Chromium those carry an
      // empty cssRules too) has nothing to walk and must not trip the depth cap.
      if (child && child.length > 0) walkRules(child, depth + 1);
    }
  };
  // document.styleSheets is NOT the whole set: constructed sheets adopted by
  // the document are not in it, and each shadow root carries its own lists.
  const sheets = [];
  const addSheets = (list) => {
    // An absent list means the host has no such collection (e.g. no
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
  let disabledSheets = 0;
  let sheetsSkippedByMedia = 0;
  let sheetsWalked = 0;
  for (const sheet of sheets) {
    // COUNTED: a disabled sheet applies nothing to the page, so its @media
    // conditions are not "currently matching" whatever matchMedia says.
    if (sheet.disabled === true) { disabledSheets++; continue; }
    // COUNTED: a sheet-level condition (<link media="print">, @import ... print)
    // that does not match gates every rule inside it; the rules' own
    // conditions are only evaluated when the sheet's one holds. A sheet
    // condition matchMedia refuses is counted with the rule-level ones and the
    // sheet is walked as if unconditional.
    const sheetMedia = sheet.media && sheet.media.mediaText ? sheet.media.mediaText : null;
    if (sheetMedia) {
      let sheetMatches = true;
      try { sheetMatches = matchMedia(sheetMedia).matches; } catch (e) { unevaluableConditions++; }
      if (!sheetMatches) { sheetsSkippedByMedia++; continue; }
    }
    let rules = null;
    // COUNTED: cssRules threw (cross-origin) or came back null/undefined.
    try { rules = sheet.cssRules; } catch (e) { unreadableSheets++; continue; }
    if (rules == null) { unreadableSheets++; continue; }
    sheetsWalked++;
    walkRules(rules, 0);
  }
  // ONE reason field per count, naming each reason it is incomplete. Two
  // booleans a reader has to remember to OR together is how a cap once went
  // unreported: the reader forgot to include it.
  const cssNotes = [];
  if (unreadableSheets > 0) cssNotes.push(unreadableSheets + " stylesheet(s) could not be read (cross-origin CSS, e.g. served from a CDN, or a sheet whose rules were unavailable)");
  if (unreadableRules > 0) cssNotes.push(unreadableRules + " rule(s) could not be read or had unreadable children");
  if (unloadedImports > 0) cssNotes.push(unloadedImports + " @import rule(s) had no loaded stylesheet (blocked, still loading, or failed), so their rules were not walked");
  if (unevaluableConditions > 0) cssNotes.push(unevaluableConditions + " media condition(s) could not be evaluated by matchMedia");
  if (ruleCapTruncations > 0) cssNotes.push("the CSS rule walk hit its cap of " + RULE_CAP + " rules, so rules after that point were skipped");
  if (depthTruncations > 0) cssNotes.push("the CSS rule walk hit its nesting-depth cap of " + RULE_DEPTH + " at " + depthTruncations + " point(s) (deeply nested @layer/@supports/@media, native CSS nesting, or a long @import chain), so the rules below those points were skipped");
  if (shadowRootCount > shadowRootsSeen.length) cssNotes.push("only " + shadowRootsSeen.length + " of " + shadowRootCount + " open shadow root(s) had their stylesheets walked");
  // Sheet discovery for shadow roots and iframes happens INSIDE the element
  // loop over nodes[0..SCAN), so a capped element scan is ALSO a capped CSS
  // walk: a shadow root past node SCAN was not visited and its sheets not read.
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
  // The two unbounded page scalars are sliced here, before sizing, so a long
  // url costs the budget at most URL_MAX chars (test: "a 20,000-char url ...
  // still fit the budget with every flag present").
  const href = String(location.href);
  const ua = String(navigator.userAgent);
  // Key order is load-bearing: scalars, totals and flags first, knownGaps
  // next, the lists LAST, so a truncated serialization loses list rows before
  // it loses a flag. The size trim below keeps the document under MAX_CHARS.
  const report = {
    url: href.slice(0, URL_MAX),
    urlTruncated: href.length > URL_MAX,
    viewport: {
      clientWidth: vw, clientHeight: vh,
      innerWidth: innerWidth, innerHeight: innerHeight,
      devicePixelRatio: devicePixelRatio,
      userAgent: ua.slice(0, UA_MAX),
      userAgentTruncated: ua.length > UA_MAX,
      maxTouchPoints: navigator.maxTouchPoints,
    },
    documentScroll: {
      scrollWidth: de.scrollWidth, clientWidth: de.clientWidth,
      horizontalOverflowPx: de.scrollWidth - de.clientWidth,
      scrollHeight: de.scrollHeight, clientHeight: de.clientHeight,
    },
    backgrounds: { html: htmlBg, body: bodyBg, canvas: canvas },
    listCap: CAP,
    listsTrimmedForSize: false,
    overflowingElementsTotal: overflowing.length,
    overflowingElementsListed: Math.min(overflowing.length, CAP),
    fixedAndStickyTotal: stuck.length,
    fixedAndStickyListed: Math.min(stuck.length, CAP),
    matchingMediaQueriesTotal: matching.length,
    matchingMediaQueriesListed: Math.min(matching.length, CAP),
    unreadableStyleSheets: unreadableSheets,
    unreadableRules: unreadableRules,
    unloadedImports: unloadedImports,
    unevaluableMediaConditions: unevaluableConditions,
    cssRulesTruncated: ruleCapTruncations > 0,
    cssDepthTruncated: depthTruncations > 0,
    styleSheetsWalked: sheetsWalked,
    disabledSheetsSkipped: disabledSheets,
    sheetsSkippedByMedia: sheetsSkippedByMedia,
    adoptedStyleSheets: adoptedSheets,
    shadowRootStyleSheets: shadowSheets,
    cssWalkIncomplete: cssNotes.length ? cssNotes.join("; ") : null,
    elementsScanned: nodes.length,
    scanTruncated: scanCapped,
    hiddenElementsSkipped: hiddenSkipped,
    zeroSizeElementsSkipped: zeroSizeSkipped,
    openShadowRoots: shadowRootCount,
    iframes: iframeCount,
    sameOriginIframes: sameOriginIframeCount,
    elementScanIncomplete: elementNotes.length ? elementNotes.join("; ") : null,
    knownGaps: KNOWN_GAPS,
    overflowingElements: overflowing.slice(0, CAP),
    fixedAndStickyElements: stuck.slice(0, CAP),
    matchingMediaQueries: matching.slice(0, CAP),
  };
  // COUNTED: rows dropped here show as listsTrimmedForSize plus the *Listed
  // counts falling below min(total, listCap). The totals are untouched. Each
  // pass pops the tail of whichever list is currently LONGEST; on a tie the
  // earlier entry here goes first, so the overflowing list — the primary one
  // — is the last to empty.
  const tiePriority = ["matchingMediaQueries", "fixedAndStickyElements", "overflowingElements"];
  const listedKey = { overflowingElements: "overflowingElementsListed", fixedAndStickyElements: "fixedAndStickyListed", matchingMediaQueries: "matchingMediaQueriesListed" };
  let json = JSON.stringify(report);
  while (json.length > MAX_CHARS) {
    let key = null;
    for (const k of tiePriority) {
      if (report[k].length > 0 && (key === null || report[k].length > report[key].length)) key = k;
    }
    if (key === null) break;
    report[key].pop();
    report[listedKey[key]] = report[key].length;
    report.listsTrimmedForSize = true;
    json = JSON.stringify(report);
  }
  return json;
})()`;
