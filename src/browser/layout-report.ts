/**
 * The layout diagnostic script — one read-only page probe that returns RAW
 * DATA about the current page as a compact JSON string: document overflow,
 * elements whose rect extends past the viewport, currently matching @media
 * conditions, html/body/canvas background colours, fixed/sticky geometry,
 * and per-count completeness flags. It states no verdict and its consumer
 * adds none (see the revert 55cea840 for why). Where a flag is set, the
 * count it covers is a floor.
 *
 * The page owns each global the script reads (navigator.userAgent,
 * innerWidth, getComputedStyle, clientWidth, ...), so the script is written
 * around two invariants rather than per-field trust:
 *
 * INVARIANT 1 — the return value is valid JSON of at most
 * LAYOUT_REPORT_MAX_CHARS chars, for any page. Page strings go through one
 * `str` helper that cuts by SERIALIZED length; numbers go through `num`,
 * which reports a non-finite value as null plus its name in
 * nonNumericFields; the lists are trimmed by row; and if the document is
 * still over the cap after that, the fallback document
 * {reportTooLarge, bytesBeforeFallback, url, knownGaps} is returned instead.
 * A page global that THROWS yields {reportFailed, error, knownGaps}.
 * Proof: test/browser-layout-report-adversarial.test.ts ("invariant 1" — a
 * seeded fuzz through the real evaluateScript, plus the reduced-cap batch
 * that reaches the fallback and the throwing-global test).
 *
 * INVARIANT 2 — the untrusted-content wrapper (sanitize.ts
 * wrapExternalContent) cannot change the parsed document: inside string
 * values, `<`, `>`, `[` and every code point from U+007F up are serialized
 * as \uXXXX, so nothing the wrapper strips or normalizes occurs in the
 * bytes. Proof: the "invariant 2" block of the same file (a page whose
 * labels carry the wrapper's own trigger strings round-trips through the
 * handler and the wrapper to a deep-equal document; the escape class is
 * checked against the sanitizer's regexes code point by code point).
 *
 * Per-field rules, each named by the test that proves it, live on the
 * constants below and in the header of layout-report-css.ts.
 */
import { LAYOUT_REPORT_CSS_WALK } from "./layout-report-css.js";

/** Max elements listed per section, and max nodes walked. */
export const LAYOUT_REPORT_LIST_CAP = 20;
export const LAYOUT_REPORT_SCAN_CAP = 4000;
/** Max CSS rules visited across the walked sheets while recursing into grouping rules
 *  (@layer / @supports / nested @media), and how deep that recursion may go. */
export const LAYOUT_REPORT_RULE_CAP = 20000;
export const LAYOUT_REPORT_RULE_DEPTH = 12;
/** Per-element label budget: nodes visited and characters collected BEFORE the
 *  cut to LAYOUT_REPORT_LABEL_CHARS. Bounds the work, not just the result. */
export const LAYOUT_REPORT_LABEL_NODES = 40;
export const LAYOUT_REPORT_LABEL_COLLECT = 200;
/** Size budget for the compact JSON the script returns. page-ops.evaluateScript
 *  hard-truncates evaluate output at MAX_TEXT_LENGTH (8,000, launcher.ts) and a
 *  truncated document is not JSON. Test: "compact JSON, flags before lists,
 *  under the evaluate cap at 200 rows through the real evaluateScript". */
export const LAYOUT_REPORT_MAX_CHARS = 7_800;
/** Caps on page-supplied strings, in SERIALIZED chars (the length of the
 *  string's JSON literal, quotes and escapes included — a backslash costs 2,
 *  a control char or a non-ASCII char 6). Tests: "url ... at exactly the cap
 *  and one over", "userAgent ... at exactly the cap and one over", "a selector
 *  built from a huge id is cut ... and marked", "a media condition longer than
 *  LAYOUT_REPORT_MEDIA_CHARS is evaluated whole and listed cut", "a row's
 *  label is the element's text cut to the label cap". */
export const LAYOUT_REPORT_URL_MAX = 2_048;
export const LAYOUT_REPORT_USER_AGENT_MAX = 512;
export const LAYOUT_REPORT_SELECTOR_CHARS = 120;
export const LAYOUT_REPORT_MEDIA_CHARS = 200;
export const LAYOUT_REPORT_LABEL_CHARS = 62;
/** Computed keywords and colours (position, zIndex, backgroundColor) — page
 *  strings too, since the page can replace getComputedStyle. */
export const LAYOUT_REPORT_VALUE_CHARS = 80;
/** The url in the reportTooLarge fallback document. */
export const LAYOUT_REPORT_FALLBACK_URL_CHARS = 256;
/** Escaped as \uXXXX inside serialized string values (Invariant 2): the
 *  angle brackets and the `[` of the wrapper's own markers, and everything
 *  from U+007F up (its control, invisible and homoglyph classes are all
 *  there). JSON.stringify already escapes U+0000–U+001F. */
export const LAYOUT_REPORT_JSON_ESCAPE = /[<>\[\u007f-\uffff]/g;

/** Stated on the report unconditionally. These are limits of the probe, not
 *  findings about the page, and none of them has a runtime detector. */
export const LAYOUT_REPORT_KNOWN_GAPS: readonly string[] = Object.freeze([
  "@container queries are not detected: there is no matchMedia equivalent, so matchingMediaQueries covers @media only. A page whose responsiveness is container-query driven can show zero matching queries here.",
  "Closed shadow roots are not detectable, so nothing inside one is counted, measured or walked, and openShadowRoots does not include them.",
  "Elements inside open shadow roots and inside iframe documents are not measured: they are counted (openShadowRoots / iframes) but do not appear in overflowingElements or fixedAndStickyElements.",
  "Stylesheets inside iframe documents are not walked; only the document's own sheets, its adoptedStyleSheets and the sheets of the open shadow roots that were visited are.",
]);

/** The script, with the size budget as a parameter so a test can lower it
 *  far enough to reach the fallback document (at the shipped budget the
 *  capped scalars sum to less than it). */
export function buildLayoutReportScript(maxChars = LAYOUT_REPORT_MAX_CHARS): string {
  return `(() => {
  const CAP = ${LAYOUT_REPORT_LIST_CAP};
  const SCAN = ${LAYOUT_REPORT_SCAN_CAP};
  const LABEL_NODES = ${LAYOUT_REPORT_LABEL_NODES};
  const LABEL_COLLECT = ${LAYOUT_REPORT_LABEL_COLLECT};
  const MAX_CHARS = ${maxChars};
  const URL_MAX = ${LAYOUT_REPORT_URL_MAX};
  const UA_MAX = ${LAYOUT_REPORT_USER_AGENT_MAX};
  const SELECTOR_CHARS = ${LAYOUT_REPORT_SELECTOR_CHARS};
  const LABEL_CHARS = ${LAYOUT_REPORT_LABEL_CHARS};
  const VALUE_CHARS = ${LAYOUT_REPORT_VALUE_CHARS};
  const FALLBACK_URL_CHARS = ${LAYOUT_REPORT_FALLBACK_URL_CHARS};
  const KNOWN_GAPS = ${JSON.stringify(LAYOUT_REPORT_KNOWN_GAPS)};
  const ESCAPE_RE = /${LAYOUT_REPORT_JSON_ESCAPE.source}/g;
  const hex4 = (ch) => "\\\\u" + ("000" + ch.charCodeAt(0).toString(16)).slice(-4);
  // A JSON string literal with the Invariant 2 class escaped.
  const jsonStr = (s) => JSON.stringify(s).replace(ESCAPE_RE, hex4);
  // The whole document, serialized in one place: keys and string values via
  // jsonStr; numbers, booleans and null via JSON.stringify (NaN/Infinity and
  // undefined serialize as null).
  const toJson = (v) => {
    if (typeof v === "string") return jsonStr(v);
    if (Array.isArray(v)) return "[" + v.map(toJson).join(",") + "]";
    if (v && typeof v === "object") return "{" + Object.keys(v).map((k) => jsonStr(k) + ":" + toJson(v[k])).join(",") + "}";
    const j = JSON.stringify(v);
    return j === undefined ? "null" : j;
  };
  // Every page string enters the document through here: cut so that its
  // serialized literal is at most cap chars (binary search on the cut point).
  const str = (v, cap) => {
    let s = "";
    try { s = String(v); } catch (e) { s = ""; }
    if (jsonStr(s).length <= cap) return { value: s, truncated: false };
    let lo = 0;
    let hi = Math.min(s.length, cap);
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (jsonStr(s.slice(0, mid)).length <= cap) lo = mid; else hi = mid - 1;
    }
    return { value: s.slice(0, lo), truncated: true };
  };
  const val = (v) => str(v, VALUE_CHARS).value;
  // Every page number enters through here: a non-finite value (a string the
  // page put on innerWidth, NaN, a missing property) is null and named.
  const nonNumericFields = [];
  const num = (v, name) => {
    let n = NaN;
    try { n = Number(v); } catch (e) { n = NaN; }
    if (Number.isFinite(n)) return n;
    nonNumericFields.push(name);
    return null;
  };
  const failed = (e) => {
    let message = "";
    try { message = String(e && e.message ? e.message : e); } catch (x) { message = ""; }
    return toJson({ reportFailed: true, error: str(message, FALLBACK_URL_CHARS).value, knownGaps: KNOWN_GAPS });
  };
  try {
  const de = document.documentElement;
  const body = document.body;
  const vw = Number(de.clientWidth);
  const round = (n) => Math.round(n * 100) / 100;
  // tag#id, else tag + up to 2 classes + :nth-of-type among same-tag
  // siblings; cut to SELECTOR_CHARS because an id or class is page text.
  const describe = (el) => {
    const tag = String(el.tagName).toLowerCase();
    if (el.id) return str(tag + "#" + el.id, SELECTOR_CHARS);
    let out = tag;
    const raw = typeof el.className === "string" ? el.className : "";
    const cls = raw.trim().split(/\\s+/).filter(Boolean).slice(0, 2);
    if (cls.length) out += "." + cls.join(".");
    const parent = el.parentElement;
    if (parent) {
      const sibs = Array.prototype.filter.call(parent.children, (c) => c.tagName === el.tagName);
      if (sibs.length > 1) out += ":nth-of-type(" + (sibs.indexOf(el) + 1) + ")";
    }
    return str(out, SELECTOR_CHARS);
  };
  // Bounded label: at most LABEL_NODES nodes visited, LABEL_COLLECT chars
  // collected, then cut to LABEL_CHARS. The early return inside collect()
  // shortens the display label of one element and touches no count or flag.
  const label = (el) => {
    let out = "";
    let budget = LABEL_NODES;
    const collect = (node) => {
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (budget <= 0 || out.length >= LABEL_COLLECT) return;
        budget--;
        if (c.nodeType === 3) out += c.nodeValue || "";
        else if (c.nodeType === 1) collect(c);
      }
    };
    collect(el);
    return str(out.replace(/\\s+/g, " ").trim(), LABEL_CHARS).value;
  };
  const rectOf = (r) => ({ x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height), right: round(r.right), bottom: round(r.bottom) });
  const row = (el, cs, r) => {
    const sel = describe(el);
    const out = { selector: sel.value };
    if (sel.truncated) out.selectorTruncated = true;
    out.text = label(el);
    out.position = val(cs.position);
    out.rect = rectOf(r);
    out.backgroundColor = val(cs.backgroundColor);
    out.zIndex = val(cs.zIndex);
    return out;
  };
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
        const o = row(el, cs, r);
        o.overflowRightPx = overRight;
        o.overflowLeftPx = overLeft;
        overflowing.push(o);
      }
    } else {
      zeroSizeSkipped++;
    }
    if (cs.position === "fixed" || cs.position === "sticky") stuck.push(row(el, cs, r));
  }
  overflowing.sort((a, b) => (b.overflowRightPx + b.overflowLeftPx) - (a.overflowRightPx + a.overflowLeftPx));
  stuck.sort((a, b) => a.rect.y - b.rect.y);
  const css = (${LAYOUT_REPORT_CSS_WALK})(shadowRootsSeen, ${LAYOUT_REPORT_RULE_CAP}, ${LAYOUT_REPORT_RULE_DEPTH}, ${LAYOUT_REPORT_MEDIA_CHARS}, str);
  // ONE reason field per count, naming each reason it is incomplete. Two
  // booleans a reader has to remember to OR together is how a cap once went
  // unreported: the reader forgot to include it.
  const cssNotes = [];
  if (css.unreadableSheets > 0) cssNotes.push(css.unreadableSheets + " stylesheet(s) could not be read (cross-origin CSS, e.g. served from a CDN, or a sheet whose rules were unavailable)");
  if (css.unreadableRules > 0) cssNotes.push(css.unreadableRules + " rule(s) could not be read or had unreadable children");
  if (css.unloadedImports > 0) cssNotes.push(css.unloadedImports + " @import rule(s) had no loaded stylesheet (blocked, still loading, or failed), so their rules were not walked");
  if (css.unevaluableConditions > 0) cssNotes.push(css.unevaluableConditions + " media condition(s) could not be evaluated by matchMedia");
  if (css.ruleCapTruncations > 0) cssNotes.push("the CSS rule walk hit its cap of ${LAYOUT_REPORT_RULE_CAP} rules, so rules after that point were skipped");
  if (css.depthTruncations > 0) cssNotes.push("the CSS rule walk hit its nesting-depth cap of ${LAYOUT_REPORT_RULE_DEPTH} at " + css.depthTruncations + " point(s) (deeply nested @layer/@supports/@media, native CSS nesting, or a long @import chain), so the rules below those points were skipped");
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
  const htmlBg = val(getComputedStyle(de).backgroundColor);
  const bodyBg = body ? val(getComputedStyle(body).backgroundColor) : null;
  const clear = (c) => !c || c === "transparent" || c.replace(/ /g, "") === "rgba(0,0,0,0)";
  const canvas = !clear(htmlBg) ? htmlBg : (!clear(bodyBg) ? bodyBg : "rgb(255, 255, 255) (browser default: neither html nor body paints one)");
  const href = str(location.href, URL_MAX);
  const ua = str(navigator.userAgent, UA_MAX);
  // Key order: scalars, totals and flags first, knownGaps next, the lists
  // LAST. The size trim below pops list rows until the document fits.
  const report = {
    url: href.value,
    urlTruncated: href.truncated,
    viewport: {
      clientWidth: num(de.clientWidth, "viewport.clientWidth"), clientHeight: num(de.clientHeight, "viewport.clientHeight"),
      innerWidth: num(innerWidth, "viewport.innerWidth"), innerHeight: num(innerHeight, "viewport.innerHeight"),
      devicePixelRatio: num(devicePixelRatio, "viewport.devicePixelRatio"),
      userAgent: ua.value,
      userAgentTruncated: ua.truncated,
      maxTouchPoints: num(navigator.maxTouchPoints, "viewport.maxTouchPoints"),
    },
    documentScroll: {
      scrollWidth: num(de.scrollWidth, "documentScroll.scrollWidth"), clientWidth: num(de.clientWidth, "documentScroll.clientWidth"),
      horizontalOverflowPx: num(de.scrollWidth - de.clientWidth, "documentScroll.horizontalOverflowPx"),
      scrollHeight: num(de.scrollHeight, "documentScroll.scrollHeight"), clientHeight: num(de.clientHeight, "documentScroll.clientHeight"),
    },
    nonNumericFields: nonNumericFields,
    backgrounds: { html: htmlBg, body: bodyBg, canvas: canvas },
    listCap: CAP,
    listsTrimmedForSize: false,
    overflowingElementsTotal: overflowing.length,
    overflowingElementsListed: Math.min(overflowing.length, CAP),
    fixedAndStickyTotal: stuck.length,
    fixedAndStickyListed: Math.min(stuck.length, CAP),
    matchingMediaQueriesTotal: css.matching.length,
    matchingMediaQueriesListed: Math.min(css.matching.length, CAP),
    unreadableStyleSheets: css.unreadableSheets,
    unreadableRules: css.unreadableRules,
    unloadedImports: css.unloadedImports,
    unevaluableMediaConditions: css.unevaluableConditions,
    cssRulesTruncated: css.ruleCapTruncations > 0,
    cssDepthTruncated: css.depthTruncations > 0,
    styleSheetsWalked: css.sheetsWalked,
    disabledSheetsSkipped: css.disabledSheets,
    sheetsSkippedByMedia: css.sheetsSkippedByMedia,
    adoptedStyleSheets: css.adoptedSheets,
    shadowRootStyleSheets: css.shadowSheets,
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
    matchingMediaQueries: css.listed.slice(0, CAP),
  };
  // COUNTED: rows dropped here show as listsTrimmedForSize plus the *Listed
  // counts falling below min(total, listCap). The totals are untouched. Each
  // pass pops the tail of whichever list is currently LONGEST; on a tie the
  // earlier entry here goes first (test: "the trim tie-break is media, then
  // fixed, then overflowing").
  const tiePriority = ["matchingMediaQueries", "fixedAndStickyElements", "overflowingElements"];
  const listedKey = { overflowingElements: "overflowingElementsListed", fixedAndStickyElements: "fixedAndStickyListed", matchingMediaQueries: "matchingMediaQueriesListed" };
  let json = toJson(report);
  while (json.length > MAX_CHARS) {
    let key = null;
    for (const k of tiePriority) {
      if (report[k].length > 0 && (key === null || report[k].length > report[key].length)) key = k;
    }
    if (key === null) break;
    report[key].pop();
    report[listedKey[key]] = report[key].length;
    report.listsTrimmedForSize = true;
    json = toJson(report);
  }
  // Invariant 1's last guard: with the lists empty and the document still
  // over the cap, return the fallback document instead.
  if (json.length > MAX_CHARS) {
    json = toJson({ reportTooLarge: true, bytesBeforeFallback: json.length, url: str(href.value, FALLBACK_URL_CHARS).value, knownGaps: KNOWN_GAPS });
  }
  return json;
  } catch (e) { return failed(e); }
})()`;
}

export const LAYOUT_REPORT_SCRIPT = buildLayoutReportScript();
