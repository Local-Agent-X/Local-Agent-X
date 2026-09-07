/**
 * The layout diagnostic script — one read-only page probe that returns RAW DATA about the current page as a
 * compact JSON string: document overflow, elements whose rect extends past the viewport, currently matching
 * @media conditions, html/body/canvas background colours, fixed/sticky geometry, and per-count flags. It states
 * no verdict and its consumer adds none (see the revert 55cea840 for why). Where a flag is set, the count it
 * covers is a floor. The page owns each global the script reads (navigator.userAgent, innerWidth,
 * getComputedStyle, clientWidth, ...) AND each builtin it runs on, so the script is written around per-field
 * rules and stated limits rather than per-field trust.
 *
 * OUTPUT — one JSON document. When it fits LAYOUT_REPORT_MAX_CHARS it is returned whole; when list rows had to
 * be dropped to fit, `listsTrimmedForSize` is set and the `*Listed` counts say how many remain; when the
 * scalars by themselves do not fit, a small {reportTooLarge, bytesBeforeFallback, url, knownGaps} document is
 * returned; when the probe throws, {reportFailed, error, knownGaps}. Serialization runs on the builtins
 * captured by the script's first statement (the `B` bag) and reaches for no JSON.stringify at runtime. LIMIT: a
 * page that replaced a builtin BEFORE that first statement can still drive output the evaluate layer truncates
 * at MAX_TEXT_LENGTH (8,000, launcher.ts), in which case the model sees `[Truncated at 8000 chars]` in place of
 * JSON. Tests: "300 hostile pages through the real evaluateScript at the shipped budget", "a page that replaces
 * JSON.stringify and Array.prototype.map before the script's first statement still yields a parseable report
 * under the budget".
 *
 * WRAPPER — the untrusted-content wrapper (sanitize.ts wrapExternalContent) may substitute `[REDACTED_SECRET]`
 * for a registered secret value inside a string value (step 0, redactKnownSecrets). Past that substitution its
 * tag-stripping, marker-neutralizing and homoglyph normalization find nothing to edit, because inside string
 * values `<`, `>`, `[` and each code point from U+007F up are serialized as \uXXXX. Tests: "a page carrying the
 * wrapper's trigger strings in ids, classes, labels and media text round-trips byte-for-byte through the
 * handler", "for every UTF-16 code unit, the script's one-char literal is a fixed point of the wrapper's edit
 * steps", "the script's serializer agrees with JSON.stringify + LAYOUT_REPORT_JSON_ESCAPE over the whole UTF-16
 * range", "a page echoing a registered secret: the wrapped bytes differ from the raw bytes by [REDACTED_SECRET]
 * substitutions and nothing else". Per-field rules, each naming the test that pins it, live on the constants
 * below and in the header of layout-report-css.ts.
 */
import { LAYOUT_REPORT_CSS_WALK } from "./layout-report-css.js";

/** Max elements listed per section, and max nodes walked. */
export const LAYOUT_REPORT_LIST_CAP = 20, LAYOUT_REPORT_SCAN_CAP = 4000;
/** Max CSS rules visited across the walked sheets while recursing into grouping rules (@layer / @supports /
 *  nested @media), and how deep that recursion may go. */
export const LAYOUT_REPORT_RULE_CAP = 20000, LAYOUT_REPORT_RULE_DEPTH = 12;
/** Per-element label budget: nodes visited and characters collected BEFORE the cut to LAYOUT_REPORT_LABEL_CHARS.
 *  Bounds the work, not just the result. The `out.length >= LABEL_COLLECT` check runs BEFORE the append, so the
 *  last text node lands whole: the collected buffer is bounded by LABEL_COLLECT plus one text node, and is then
 *  cut to LAYOUT_REPORT_LABEL_CHARS. Test: "a row's label is the element's text cut to the label cap". */
export const LAYOUT_REPORT_LABEL_NODES = 40, LAYOUT_REPORT_LABEL_COLLECT = 200;
/** Size budget for the compact JSON the script returns. page-ops.evaluateScript hard-truncates evaluate output
 *  at MAX_TEXT_LENGTH (8,000, launcher.ts) and a truncated document is not JSON. Test: "compact JSON, flags
 *  before lists, under the evaluate cap at 200 rows through the real evaluateScript". */
export const LAYOUT_REPORT_MAX_CHARS = 7_800;
/** Caps on page-supplied strings, in SERIALIZED chars (the length of the string's JSON literal, quotes and
 *  escapes included — a backslash costs 2, a control char or a non-ASCII char 6). Tests: "url ... at exactly the
 *  cap and one over", "userAgent ... at exactly the cap and one over", "a selector built from a huge id is cut
 *  ... and marked", "a media condition longer than LAYOUT_REPORT_MEDIA_CHARS is evaluated whole and listed cut",
 *  "a row's label is the element's text cut to the label cap". */
export const LAYOUT_REPORT_URL_MAX = 2_048;
export const LAYOUT_REPORT_USER_AGENT_MAX = 512;
export const LAYOUT_REPORT_SELECTOR_CHARS = 120;
export const LAYOUT_REPORT_MEDIA_CHARS = 200;
export const LAYOUT_REPORT_LABEL_CHARS = 62;
/** Computed keywords and colours (position, zIndex, backgroundColor) — page strings too, since the page can
 *  replace getComputedStyle. */
export const LAYOUT_REPORT_VALUE_CHARS = 80;
/** The url in the reportTooLarge fallback document. */
export const LAYOUT_REPORT_FALLBACK_URL_CHARS = 256;
/** How many names nonNumericFields carries before it stops growing and sets nonNumericFieldsTruncated. The
 *  scalar reads run BEFORE the element loop so the budget is spent on them first and per-row rect names take
 *  what is left. Sized off the TRIM FLOOR — the document with all three lists emptied, every page string at its
 *  cap, every cssWalkIncomplete/elementScanIncomplete note firing and this list full: 7,506 serialized chars at
 *  30 names (294 under LAYOUT_REPORT_MAX_CHARS), against 7,986 at 40, which would have made the fallback
 *  document the only reachable output for such a page. That floor is a hand measurement against this key set,
 *  not a test. Test: "a page whose getBoundingClientRect returns NaN names the rect fields per row and stops the
 *  list at its cap". */
export const LAYOUT_REPORT_NON_NUMERIC_CAP = 30;
/** Escaped as \uXXXX inside serialized string values: the angle brackets and the `[` of the wrapper's own
 *  markers, and everything from U+007F up (its control, invisible and homoglyph classes are all there). The
 *  script's own serializer does not read this regex — it escapes by code-unit range — and the two are pinned
 *  together by "the script's serializer agrees with JSON.stringify + LAYOUT_REPORT_JSON_ESCAPE over the whole
 *  UTF-16 range". */
export const LAYOUT_REPORT_JSON_ESCAPE = /[<>\[\u007f-\uffff]/g;

/** Stated on the report unconditionally. These are limits of the probe, not findings about the page, and none
 *  of them has a runtime detector. */
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
  // FIRST STATEMENT: the builtins this script and the CSS walk run on, read before any page code the probe
  // triggers gets a turn. Prototype methods go through B.<name>.call(obj, ...), so an own-property the page put
  // on the object is out of the path; map/filter/join/indexOf are gone, replaced by index loops. LIMIT: a page
  // that replaced one of these BEFORE this line owns it here too (header).
  const B = {
    String: String, Number: Number, isFinite: Number.isFinite, round: Math.round, min: Math.min, max: Math.max,
    isArray: Array.isArray, keys: Object.keys, Map: Map, Set: Set,
    slice: Array.prototype.slice, push: Array.prototype.push, pop: Array.prototype.pop, sort: Array.prototype.sort,
    sslice: String.prototype.slice, strim: String.prototype.trim, ssplit: String.prototype.split,
    slower: String.prototype.toLowerCase, charCodeAt: String.prototype.charCodeAt, sreplace: String.prototype.replace,
    mapHas: Map.prototype.has, mapGet: Map.prototype.get, mapSet: Map.prototype.set, setHas: Set.prototype.has, setAdd: Set.prototype.add,
  };
  const CAP = ${LAYOUT_REPORT_LIST_CAP}, SCAN = ${LAYOUT_REPORT_SCAN_CAP}, MAX_CHARS = ${maxChars};
  const LABEL_NODES = ${LAYOUT_REPORT_LABEL_NODES}, LABEL_COLLECT = ${LAYOUT_REPORT_LABEL_COLLECT}, LABEL_CHARS = ${LAYOUT_REPORT_LABEL_CHARS};
  const URL_MAX = ${LAYOUT_REPORT_URL_MAX}, UA_MAX = ${LAYOUT_REPORT_USER_AGENT_MAX}, SELECTOR_CHARS = ${LAYOUT_REPORT_SELECTOR_CHARS};
  const VALUE_CHARS = ${LAYOUT_REPORT_VALUE_CHARS}, FALLBACK_URL_CHARS = ${LAYOUT_REPORT_FALLBACK_URL_CHARS}, NON_NUMERIC_CAP = ${LAYOUT_REPORT_NON_NUMERIC_CAP};
  const KNOWN_GAPS = ${JSON.stringify(LAYOUT_REPORT_KNOWN_GAPS)};
  const HEX = "0123456789abcdef";
  const hex4 = (c) => "\\\\u" + HEX[(c >> 12) & 15] + HEX[(c >> 8) & 15] + HEX[(c >> 4) & 15] + HEX[c & 15];
  // Serialized width of one code unit: 2 for the short escapes JSON.stringify
  // writes, 6 for a control char and for the LAYOUT_REPORT_JSON_ESCAPE class
  // (< > [ and U+007F and up), 1 otherwise. SHORT holds the width-2 forms.
  const SHORT = { 8: "\\\\b", 9: "\\\\t", 10: "\\\\n", 12: "\\\\f", 13: "\\\\r", 34: "\\\\\\"", 92: "\\\\\\\\" };
  const width = (c) => (c === 34 || c === 92 || c === 8 || c === 9 || c === 10 || c === 12 || c === 13) ? 2
    : (c < 32 || c === 60 || c === 62 || c === 91 || c >= 127) ? 6 : 1;
  // A JSON string literal, built code unit by code unit rather than by
  // JSON.stringify. Pinned byte-for-byte against JSON.stringify +
  // LAYOUT_REPORT_JSON_ESCAPE by "the script's serializer agrees with
  // JSON.stringify + LAYOUT_REPORT_JSON_ESCAPE over the whole UTF-16 range".
  const jsonStr = (s) => {
    let out = "\\"";
    for (let i = 0; i < s.length; i++) {
      const c = B.charCodeAt.call(s, i), w = width(c);
      out += w === 2 ? SHORT[c] : w === 6 ? hex4(c) : s[i];
    }
    return out + "\\"";
  };
  // The whole document, serialized in one place: keys and string values via
  // jsonStr; numbers by concatenation (a non-finite one as null, which is what
  // JSON.stringify would have written); booleans literally; anything else null.
  const toJson = (v) => {
    if (typeof v === "string") return jsonStr(v);
    if (typeof v === "number") return B.isFinite(v) ? "" + v : "null";
    if (v === true) return "true";
    if (v === false) return "false";
    let out = "";
    if (B.isArray(v)) {
      for (let i = 0; i < v.length; i++) out += (i ? "," : "") + toJson(v[i]);
      return "[" + out + "]";
    }
    if (v && typeof v === "object") {
      const ks = B.keys(v);
      for (let i = 0; i < ks.length; i++) out += (i ? "," : "") + jsonStr(ks[i]) + ":" + toJson(v[ks[i]]);
      return "{" + out + "}";
    }
    return "null";
  };
  // Every page string enters the document through here: cut so that its
  // serialized literal is at most cap chars, in one pass that stops at the
  // code unit which would push the literal past the cap.
  const str = (v, cap) => {
    let s = "";
    try { s = B.String(v); } catch (e) { s = ""; }
    let n = 2;
    for (let i = 0; i < s.length; i++) {
      const w = width(B.charCodeAt.call(s, i));
      if (n + w > cap) return { value: B.sslice.call(s, 0, i), truncated: true };
      n += w;
    }
    return { value: s, truncated: false };
  };
  const val = (v) => str(v, VALUE_CHARS).value;
  // Every page number enters through here: a non-finite value (a string the
  // page put on innerWidth, a NaN rect field, a missing property) is null and
  // named. The name list stops at NON_NUMERIC_CAP, which bounds what a page
  // with thousands of NaN rects spends of the size budget on names.
  const nonNumericFields = [];
  let nonNumericTruncated = false;
  const num = (v, name) => {
    let n = NaN;
    try { n = B.Number(v); } catch (e) { n = NaN; }
    if (B.isFinite(n)) return n;
    if (nonNumericFields.length < NON_NUMERIC_CAP) B.push.call(nonNumericFields, name); else nonNumericTruncated = true;
    return null;
  };
  const failed = (e) => {
    let message = "";
    try { message = B.String(e && e.message ? e.message : e); } catch (x) { message = ""; }
    return toJson({ reportFailed: true, error: str(message, FALLBACK_URL_CHARS).value, knownGaps: KNOWN_GAPS });
  };
  try {
  const de = document.documentElement, body = document.body, vw = B.Number(de.clientWidth);
  const round = (n) => B.round(n * 100) / 100;
  // A rect field: through num (so a page-owned getBoundingClientRect that
  // returns NaN is null and named), then rounded.
  const rnum = (v, name) => { const n = num(v, name); return n === null ? null : round(n); };
  // tag#id, else tag + up to 2 classes + :nth-of-type among same-tag
  // siblings; cut to SELECTOR_CHARS because an id or class is page text.
  const describe = (el) => {
    const tag = B.slower.call(B.String(el.tagName));
    if (el.id) return str(tag + "#" + el.id, SELECTOR_CHARS);
    let out = tag;
    const raw = typeof el.className === "string" ? el.className : "";
    const parts = B.ssplit.call(B.strim.call(raw), /\\s+/);
    let taken = 0;
    for (let i = 0; i < parts.length && taken < 2; i++) if (parts[i]) { out += "." + parts[i]; taken++; }
    const kids = el.parentElement ? el.parentElement.children : null;
    let sameTag = 0, ordinal = 0;
    for (let i = 0; kids && i < kids.length; i++) {
      if (kids[i].tagName !== el.tagName) continue;
      sameTag++;
      if (kids[i] === el) ordinal = sameTag;
    }
    if (sameTag > 1) out += ":nth-of-type(" + ordinal + ")";
    return str(out, SELECTOR_CHARS);
  };
  // Bounded label: at most LABEL_NODES nodes visited and LABEL_COLLECT chars
  // collected before the last text node is appended whole, then cut to
  // LABEL_CHARS. The early return inside collect() shortens the display label
  // of one element and touches no count or flag.
  const label = (el) => {
    let out = "", budget = LABEL_NODES;
    const collect = (node) => {
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (budget <= 0 || out.length >= LABEL_COLLECT) return;
        budget--;
        if (c.nodeType === 3) out += c.nodeValue || "";
        else if (c.nodeType === 1) collect(c);
      }
    };
    collect(el);
    return str(B.strim.call(B.sreplace.call(out, /\\s+/g, " ")), LABEL_CHARS).value;
  };
  const rectOf = (r, name) => ({
    x: rnum(r.x, name + ".rect.x"), y: rnum(r.y, name + ".rect.y"),
    width: rnum(r.width, name + ".rect.width"), height: rnum(r.height, name + ".rect.height"),
    right: rnum(r.right, name + ".rect.right"), bottom: rnum(r.bottom, name + ".rect.bottom"),
  });
  const row = (el, cs, r, name) => {
    const sel = describe(el);
    const out = { selector: sel.value };
    if (sel.truncated) out.selectorTruncated = true;
    out.text = label(el);
    out.position = val(cs.position);
    out.rect = rectOf(r, name);
    out.backgroundColor = val(cs.backgroundColor);
    out.zIndex = val(cs.zIndex);
    return out;
  };
  // The scalar reads run BEFORE the element loop so the NON_NUMERIC_CAP budget
  // is spent naming them first; per-row rect names take what is left.
  const viewportNums = {
    clientWidth: num(de.clientWidth, "viewport.clientWidth"), clientHeight: num(de.clientHeight, "viewport.clientHeight"),
    innerWidth: num(innerWidth, "viewport.innerWidth"), innerHeight: num(innerHeight, "viewport.innerHeight"),
    devicePixelRatio: num(devicePixelRatio, "viewport.devicePixelRatio"), maxTouchPoints: num(navigator.maxTouchPoints, "viewport.maxTouchPoints"),
  };
  const scrollNums = {
    scrollWidth: num(de.scrollWidth, "documentScroll.scrollWidth"), clientWidth: num(de.clientWidth, "documentScroll.clientWidth"),
    horizontalOverflowPx: num(de.scrollWidth - de.clientWidth, "documentScroll.horizontalOverflowPx"),
    scrollHeight: num(de.scrollHeight, "documentScroll.scrollHeight"), clientHeight: num(de.clientHeight, "documentScroll.clientHeight"),
  };
  // COUNTED: scanTruncated is true only when at least one node past SCAN
  // existed and was skipped; it feeds BOTH reason fields (see below).
  const allNodes = document.querySelectorAll("*");
  const scanCapped = allNodes.length > SCAN;
  const nodes = B.slice.call(allNodes, 0, SCAN);
  const overflowing = [];
  const stuck = [];
  // querySelectorAll("*") pierces neither shadow roots nor iframe documents.
  // Open shadow roots are collected so their sheets can be walked below -
  // COUNTED: the CAP on that list shows as shadowRootCount > shadowRootsSeen.
  // iframes are counted so the reader knows they exist.
  const shadowRootsSeen = [];
  let shadowRootCount = 0, iframeCount = 0, sameOriginIframeCount = 0, hiddenSkipped = 0, zeroSizeSkipped = 0;
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    const root = el.shadowRoot || null;
    if (root) { shadowRootCount++; if (shadowRootsSeen.length < CAP) B.push.call(shadowRootsSeen, root); }
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
      const overRight = B.max(0, round(r.right - vw));
      const overLeft = B.max(0, round(-r.left));
      if (overRight > 0 || overLeft > 0) {
        const name = "overflowingElements[" + overflowing.length + "]";
        const o = row(el, cs, r, name);
        o.overflowRightPx = num(overRight, name + ".overflowRightPx");
        o.overflowLeftPx = num(overLeft, name + ".overflowLeftPx");
        B.push.call(overflowing, o);
      }
    } else { zeroSizeSkipped++; }
    if (cs.position === "fixed" || cs.position === "sticky") B.push.call(stuck, row(el, cs, r, "fixedAndStickyElements[" + stuck.length + "]"));
  }
  B.sort.call(overflowing, (a, b) => (b.overflowRightPx + b.overflowLeftPx) - (a.overflowRightPx + a.overflowLeftPx));
  B.sort.call(stuck, (a, b) => a.rect.y - b.rect.y);
  const css = (${LAYOUT_REPORT_CSS_WALK})(shadowRootsSeen, ${LAYOUT_REPORT_RULE_CAP}, ${LAYOUT_REPORT_RULE_DEPTH}, ${LAYOUT_REPORT_MEDIA_CHARS}, str, B);
  // ONE reason field per count, naming each reason it is incomplete. Two
  // booleans a reader has to remember to OR together is how a cap once went
  // unreported: the reader forgot to include it.
  const cssNotes = [], elementNotes = [];
  const note = (list, text) => B.push.call(list, text);
  if (css.unreadableSheets > 0) note(cssNotes, css.unreadableSheets + " stylesheet(s) could not be read (cross-origin CSS, e.g. served from a CDN, or a sheet whose rules were unavailable)");
  if (css.unreadableRules > 0) note(cssNotes, css.unreadableRules + " rule(s) could not be read or had unreadable children");
  if (css.unloadedImports > 0) note(cssNotes, css.unloadedImports + " @import rule(s) had no loaded stylesheet (blocked, still loading, or failed), so their rules were not walked");
  if (css.unevaluableConditions > 0) note(cssNotes, css.unevaluableConditions + " media condition(s) could not be evaluated by matchMedia");
  if (css.ruleCapTruncations > 0) note(cssNotes, "the CSS rule walk hit its cap of ${LAYOUT_REPORT_RULE_CAP} rules, so rules after that point were skipped");
  if (css.depthTruncations > 0) note(cssNotes, "the CSS rule walk hit its nesting-depth cap of ${LAYOUT_REPORT_RULE_DEPTH} at " + css.depthTruncations + " point(s) (deeply nested @layer/@supports/@media, native CSS nesting, or a long @import chain), so the rules below those points were skipped");
  if (shadowRootCount > shadowRootsSeen.length) note(cssNotes, "only " + shadowRootsSeen.length + " of " + shadowRootCount + " open shadow root(s) had their stylesheets walked");
  // Sheet discovery for shadow roots and iframes happens INSIDE the element
  // loop over nodes[0..SCAN), so a capped element scan is ALSO a capped CSS
  // walk: a shadow root past node SCAN was not visited and its sheets not read.
  if (scanCapped) note(cssNotes, "element scan capped before all shadow roots/iframes could be visited: any open shadow root or iframe after node " + SCAN + " was never seen and its stylesheets were not walked");
  if (iframeCount > 0) note(cssNotes, iframeCount + " iframe(s) are on the page and their stylesheets were NOT walked");
  if (scanCapped) note(elementNotes, "the element scan stopped after " + nodes.length + " nodes (its cap), so nothing later in the document was measured");
  if (shadowRootCount > 0) note(elementNotes, shadowRootCount + " open shadow root(s) were found and the elements inside them were NOT measured (the walk does not pierce shadow DOM)");
  if (iframeCount > 0) note(elementNotes, iframeCount + " iframe(s) (" + sameOriginIframeCount + " same-origin) were found and their documents were NOT measured");
  const joinNotes = (list) => {
    let out = "";
    for (let i = 0; i < list.length; i++) out += (i ? "; " : "") + list[i];
    return list.length ? out : null;
  };
  const htmlBg = val(getComputedStyle(de).backgroundColor);
  const bodyBg = body ? val(getComputedStyle(body).backgroundColor) : null;
  const clear = (c) => !c || c === "transparent" || B.sreplace.call(c, / /g, "") === "rgba(0,0,0,0)";
  const canvas = !clear(htmlBg) ? htmlBg : (!clear(bodyBg) ? bodyBg : "rgb(255, 255, 255) (browser default: neither html nor body paints one)");
  const href = str(location.href, URL_MAX);
  const ua = str(navigator.userAgent, UA_MAX);
  // Key order: scalars, totals and flags first, knownGaps next, the lists
  // LAST. The size trim below pops list rows until the document fits.
  const report = {
    url: href.value, urlTruncated: href.truncated,
    viewport: {
      clientWidth: viewportNums.clientWidth, clientHeight: viewportNums.clientHeight,
      innerWidth: viewportNums.innerWidth, innerHeight: viewportNums.innerHeight,
      devicePixelRatio: viewportNums.devicePixelRatio,
      userAgent: ua.value, userAgentTruncated: ua.truncated, maxTouchPoints: viewportNums.maxTouchPoints,
    },
    documentScroll: {
      scrollWidth: scrollNums.scrollWidth, clientWidth: scrollNums.clientWidth,
      horizontalOverflowPx: scrollNums.horizontalOverflowPx,
      scrollHeight: scrollNums.scrollHeight, clientHeight: scrollNums.clientHeight,
    },
    nonNumericFields: nonNumericFields, nonNumericFieldsTruncated: false,
    backgrounds: { html: htmlBg, body: bodyBg, canvas: canvas },
    listCap: CAP, listsTrimmedForSize: false,
    overflowingElementsTotal: overflowing.length, overflowingElementsListed: B.min(overflowing.length, CAP),
    fixedAndStickyTotal: stuck.length, fixedAndStickyListed: B.min(stuck.length, CAP),
    matchingMediaQueriesTotal: css.matching.length, matchingMediaQueriesListed: B.min(css.matching.length, CAP),
    unreadableStyleSheets: css.unreadableSheets, unreadableRules: css.unreadableRules, unloadedImports: css.unloadedImports,
    unevaluableMediaConditions: css.unevaluableConditions,
    cssRulesTruncated: css.ruleCapTruncations > 0, cssDepthTruncated: css.depthTruncations > 0,
    styleSheetsWalked: css.sheetsWalked, disabledSheetsSkipped: css.disabledSheets, sheetsSkippedByMedia: css.sheetsSkippedByMedia,
    adoptedStyleSheets: css.adoptedSheets, shadowRootStyleSheets: css.shadowSheets,
    cssWalkIncomplete: joinNotes(cssNotes),
    elementsScanned: nodes.length, scanTruncated: scanCapped,
    hiddenElementsSkipped: hiddenSkipped, zeroSizeElementsSkipped: zeroSizeSkipped,
    openShadowRoots: shadowRootCount, iframes: iframeCount, sameOriginIframes: sameOriginIframeCount,
    elementScanIncomplete: joinNotes(elementNotes),
    knownGaps: KNOWN_GAPS,
    overflowingElements: B.slice.call(overflowing, 0, CAP),
    fixedAndStickyElements: B.slice.call(stuck, 0, CAP),
    matchingMediaQueries: B.slice.call(css.listed, 0, CAP),
  };
  // Re-assigning a key the literal already carries keeps its position in the
  // key order, so the flag stays with the list it describes.
  report.nonNumericFieldsTruncated = nonNumericTruncated;
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
    for (let i = 0; i < tiePriority.length; i++) {
      const k = tiePriority[i];
      if (report[k].length > 0 && (key === null || report[k].length > report[key].length)) key = k;
    }
    if (key === null) break;
    B.pop.call(report[key]);
    report[listedKey[key]] = report[key].length;
    report.listsTrimmedForSize = true;
    json = toJson(report);
  }
  // Last guard: with the lists empty and the document still over the cap,
  // return the fallback document in its place.
  if (json.length > MAX_CHARS) json = toJson({ reportTooLarge: true, bytesBeforeFallback: json.length, url: str(href.value, FALLBACK_URL_CHARS).value, knownGaps: KNOWN_GAPS });
  return json;
  } catch (e) { return failed(e); }
})()`;
}

export const LAYOUT_REPORT_SCRIPT = buildLayoutReportScript();
