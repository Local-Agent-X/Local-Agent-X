/**
 * The CSS half of the layout diagnostic script: the stylesheet discovery and
 * the @media walk. A JS function-expression STRING that layout-report.ts
 * applies inside its own script (it is not TypeScript that runs here), so
 * the rules for that file hold for this one: it runs in the page, it reads
 * the page's own globals (matchMedia, document.styleSheets), and page
 * strings pass through the caller's `str` helper before they are listed.
 *
 * Arguments: the open shadow roots the element scan collected, the rule and
 * depth caps, the media-text cap (serialized chars), and `str`.
 *
 * What the named tests prove (test/browser-layout-report-script.test.ts):
 *  - the "counted silent skips in the CSS walk" block — one test per counted
 *    early return / catch below, including the disabled sheet, the
 *    sheet-level condition, and the @import gate ("an @import whose own media
 *    condition does not match is not descended into and is counted").
 *  - "counts a repeated matching condition once" and "two matching conditions
 *    that share a 200-char prefix are two distinct conditions" — the
 *    de-duplication key is the FULL condition text, evaluated once; the
 *    listed text is cut to the media cap.
 */
export const LAYOUT_REPORT_CSS_WALK = `(shadowRootsSeen, RULE_CAP, RULE_DEPTH, MEDIA_CHARS, str) => {
  const matching = [];
  const listed = [];
  // Full condition text -> matchMedia result (true/false) or null when
  // matchMedia refused it. One evaluation per distinct full text.
  const evaluated = new Map();
  const noted = new Set();
  let unreadableSheets = 0;
  let unreadableRules = 0;
  let unloadedImports = 0;
  let unevaluableConditions = 0;
  let ruleBudget = RULE_CAP;
  let ruleCapTruncations = 0;
  let depthTruncations = 0;
  let sheetsSkippedByMedia = 0;
  const condOf = (o) => (o && o.media && typeof o.media.mediaText === "string" && o.media.mediaText) ? o.media.mediaText : null;
  const evaluate = (cond) => {
    if (!evaluated.has(cond)) {
      // COUNTED: a condition matchMedia refuses to evaluate.
      let result = null;
      try { result = matchMedia(cond).matches === true; } catch (e) { unevaluableConditions++; }
      evaluated.set(cond, result);
    }
    return evaluated.get(cond);
  };
  // A rule's condition: listed on its first sighting when it matches. Returns
  // the evaluation (null: no condition, or matchMedia refused it).
  const noteCondition = (rule) => {
    const cond = condOf(rule);
    if (cond === null) return null;
    if (noted.has(cond)) return evaluate(cond);
    noted.add(cond);
    const matches = evaluate(cond);
    if (matches === true) { matching.push(cond); listed.push(str(cond, MEDIA_CHARS).value); }
    return matches;
  };
  // A sheet-level condition (<link media>, an @import's target sheet) that
  // evaluates false gates every rule inside; one matchMedia refuses is
  // walked as unconditional (counted above).
  const sheetApplies = (sheet) => { const cond = condOf(sheet); return cond === null || evaluate(cond) !== false; };
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
      const matches = noteCondition(rule);
      if (typeof rule.href === "string") {
        // COUNTED: an @import whose sheet has not loaded (blocked, pending or
        // failed) contributes no rules and would otherwise vanish silently.
        if (rule.styleSheet == null) { unloadedImports++; continue; }
        // COUNTED: an @import's own condition, or the imported sheet's, that
        // does not match gates every rule inside it.
        if (matches === false || !sheetApplies(rule.styleSheet)) { sheetsSkippedByMedia++; continue; }
      }
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
  let sheetsWalked = 0;
  for (const sheet of sheets) {
    // COUNTED: a disabled sheet applies nothing to the page, so its @media
    // conditions are not "currently matching" whatever matchMedia says.
    if (sheet.disabled === true) { disabledSheets++; continue; }
    // COUNTED: a sheet-level condition (<link media="print">) that does not
    // match gates every rule inside it.
    if (!sheetApplies(sheet)) { sheetsSkippedByMedia++; continue; }
    let rules = null;
    // COUNTED: cssRules threw (cross-origin) or came back null/undefined.
    try { rules = sheet.cssRules; } catch (e) { unreadableSheets++; continue; }
    if (rules == null) { unreadableSheets++; continue; }
    sheetsWalked++;
    walkRules(rules, 0);
  }
  return {
    matching, listed, unreadableSheets, unreadableRules, unloadedImports, unevaluableConditions,
    ruleCapTruncations, depthTruncations, sheetsSkippedByMedia, disabledSheets, sheetsWalked, adoptedSheets, shadowSheets,
  };
}`;
