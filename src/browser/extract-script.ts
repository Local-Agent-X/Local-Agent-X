/**
 * The in-page extraction script (extract.ts's engine), as a STRING so it can be
 * injected verbatim into a page context — Playwright's page.evaluate on the CDP
 * path, the isolated-world bridge exec on the in-app path. It closes over no
 * Node globals.
 *
 * Three properties this script owns, each of them load-bearing for whether the
 * agent can drive a form at all:
 *
 *  - DURABLE IDENTITY (computeIds): the unique id / test hook / HTML name /
 *    placeholder an element publishes. The accessible NAME is a label, not a
 *    key; these are what the resolution chains match EXACTLY (stable-ids.ts).
 *  - PER-DOCUMENT resolution (docOf): labels, id-uniqueness and the XPath walk
 *    resolve against the element's OWN document, so a same-origin iframe's
 *    fields are described from inside the frame rather than looked up in the
 *    top document where they do not exist.
 *  - ADDRESSABILITY: the signature keeps a ref durable across re-renders, and
 *    when two elements collide on one, the collision is broken by their stable
 *    keys instead of by dropping an element from the snapshot.
 *
 * Split from extract.ts for the 400-LOC gate.
 */
import { TEST_ID_ATTRS, STABLE_ID_MAX_LEN } from "./stable-ids.js";

export const EXTRACTOR_SCRIPT = `(function(args) {
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

  // An element inside a same-origin iframe belongs to the FRAME's document.
  // Resolving its label / id-uniqueness against the main \`document\` (as this
  // extractor used to) looks in the wrong tree entirely: iframe fields lost
  // their label-derived names and never qualified for an id-anchored XPath, so
  // they fell back to an 8-deep index path that rots on the first re-render.
  // That is half of why the Shopventory PO iframe was unaddressable.
  const docOf = (el) => el.ownerDocument || document;

  function computeName(el) {
    // Accessible name per WAI ARIA precedence.
    const doc = docOf(el);
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const ids = labelledBy.split(/\\s+/);
      const parts = ids.map(id => (doc.getElementById(id) || {}).textContent || '').filter(Boolean);
      if (parts.length) return parts.join(' ').trim();
    }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      if (el.id) {
        const label = doc.querySelector('label[for="' + CSS.escape(el.id) + '"]');
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

  // id -> occurrence count, per document. Built once per root instead of a
  // querySelectorAll per element, and it is what makes "is this id unique?"
  // answerable for iframe elements at all (the old check queried the MAIN
  // document, where a frame's id simply does not exist).
  const idCountsFor = (doc) => {
    const counts = new Map();
    for (const node of doc.querySelectorAll('[id]')) {
      const key = node.getAttribute('id');
      if (key) counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  };
  const isUniqueId = (el, root) => {
    const id = el.getAttribute && el.getAttribute('id');
    if (!id) return false;
    const counts = root && root.idCounts ? root.idCounts : idCountsFor(docOf(el));
    return counts.get(id) === 1;
  };

  const XPATH_ID = /^[A-Za-z_][\\w-]*$/;
  const XPATH_DEPTH_CAP = 12;

  /**
   * An XPath that RESOLVES BACK to this element.
   *
   * The previous walk stopped at <body> and then prefixed "/", producing
   * "/div[1]/input[1]" — an ABSOLUTE path whose first step looks for a <div>
   * child of the document node. In HTML the document's only element child is
   * <html>, so that path matched NOTHING, for every element without a unique
   * id. Verified in Chromium, 2026-07-25. The xpath strategy was therefore dead
   * on arrival in both chains, and since \`fill\` has no coords fallback, a form
   * field whose role+name match failed had nothing left at all.
   *
   * Three shapes now, strongest first:
   *   //*[@id="x"]              the element itself has a unique id
   *   //*[@id="x"]/div[2]/…     anchored at the nearest unique-id ANCESTOR —
   *                             short, and survives re-layout above the anchor
   *   /html[1]/body[1]/…        full path from the document root
   * A path truncated by the depth cap becomes "//" + the tail, which is
   * ambiguous (first match wins) but at least evaluable — the old form could
   * not match at all.
   */
  function computeXPath(el, root) {
    if (el.id && XPATH_ID.test(el.id) && isUniqueId(el, root)) {
      return '//*[@id="' + el.id + '"]';
    }
    const segments = [];
    let node = el;
    while (node && node.nodeType === 1) {
      const id = node.getAttribute && node.getAttribute('id');
      if (node !== el && id && XPATH_ID.test(id) && isUniqueId(node, root)) {
        return '//*[@id="' + id + '"]/' + segments.join('/');
      }
      let idx = 1;
      let sib = node.previousElementSibling;
      while (sib) {
        if (sib.tagName === node.tagName) idx++;
        sib = sib.previousElementSibling;
      }
      segments.unshift(node.tagName.toLowerCase() + '[' + idx + ']');
      if (segments.length > XPATH_DEPTH_CAP) return '//' + segments.join('/');
      node = node.parentElement;  // null at documentElement — the walk ends there
    }
    return '/' + segments.join('/');
  }

  // The element's DURABLE identity, as opposed to computeName's fuzzy label.
  // Mirrors stable-ids.ts (TEST_ID_ATTRS / STABLE_ID_MAX_LEN are injected from
  // it so the extractor and the selector builder cannot drift apart).
  const TEST_ID_ATTRS = ${JSON.stringify(TEST_ID_ATTRS)};
  const ID_MAX = ${STABLE_ID_MAX_LEN};
  const idValue = (el, attr) => {
    const raw = el.getAttribute && el.getAttribute(attr);
    if (typeof raw !== 'string') return '';
    const v = raw.trim();
    if (!v || v.length > ID_MAX) return '';
    for (let i = 0; i < v.length; i++) {
      const c = v.charCodeAt(i);
      if (c < 0x20 || c === 0x7f) return '';  // control char: page content, not identity
    }
    return v;
  };

  function computeIds(el, root) {
    const ids = {};
    // A duplicated id is not an identifier — it resolves to whichever copy
    // comes first — so only a UNIQUE one is recorded.
    if (isUniqueId(el, root)) {
      const id = idValue(el, 'id');
      if (id) ids.id = id;
    }
    for (const attr of TEST_ID_ATTRS) {
      const v = idValue(el, attr);
      if (v) { ids.testId = v; break; }
    }
    const nm = idValue(el, 'name');
    if (nm) ids.name = nm;
    const ph = idValue(el, 'placeholder');
    if (ph) ids.placeholder = ph;
    return (ids.id || ids.testId || ids.name || ids.placeholder) ? ids : undefined;
  }

  /**
   * The element's stable key, folded into its signature.
   *
   * INVARIANT: a signature is a function of the ELEMENT ALONE. It must never
   * depend on what else happens to be in the snapshot. A first cut applied this
   * suffix only to elements whose base signature COLLIDED with another in the
   * same scan — which meant an element's signature changed when an unrelated
   * sibling appeared or disappeared, so on a re-rendering SPA a ref rotated for
   * reasons that had nothing to do with its own element. That is ref churn: the
   * id the model is holding goes stale and the action has to be repeated.
   *
   * Applying it unconditionally is what makes the three ui-select focussers
   * (id=focusser-0/1/2, otherwise identical) distinct refs, permanently, rather
   * than three elements deduped down to one.
   *
   * Residual: an id that is REGENERATED per mount (React useId, ember123)
   * rotates the signature on remount. That is defensible — a remount is a new
   * element instance — and ObservationRegistry.recoverStaleRef still remaps the
   * model's held id by unique role+name.
   */
  const stableSuffix = (ids) => {
    const key = ids && (ids.id || ids.testId || ids.name || ids.placeholder);
    return key ? '|@' + key : '';
  };

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

  function computeState(el) {
    // Booleans only — NEVER the field value (that's the password-leak class).
    const s = {};
    if (el.disabled === true) s.disabled = true;
    const tag = el.tagName;
    const t = el.type;
    if (tag === 'INPUT' && (t === 'checkbox' || t === 'radio')) {
      s.checked = !!el.checked;
    } else {
      const ariaChecked = el.getAttribute('aria-checked');
      if (ariaChecked === 'true' || ariaChecked === 'false') s.checked = ariaChecked === 'true';
    }
    if ((tag === 'INPUT' || tag === 'TEXTAREA') && t !== 'checkbox' && t !== 'radio' && t !== 'password') {
      if (el.value && String(el.value).length > 0) s.filled = true;
    }
    return s.checked !== undefined || s.disabled || s.filled ? s : undefined;
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
    const roots = [{ doc: document, frameUrl: undefined, offsetX: 0, offsetY: 0, idCounts: idCountsFor(document) }];
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
          idCounts: idCountsFor(doc),
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

    const root = rootByEl.get(el);
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
    const offsetX = root ? root.offsetX : 0;
    const offsetY = root ? root.offsetY : 0;
    const absX = rect.x + offsetX;
    const absY = rect.y + offsetY;
    const absBottom = rect.bottom + offsetY;
    const absRight = rect.right + offsetX;

    const inViewport =
      absBottom > 0 && absRight > 0 &&
      absY < vpHeight && absX < vpWidth;

    const ids = computeIds(el, root);
    const entry = {
      role,
      name: name.replace(/\\s+/g, ' ').trim().slice(0, 120),
      tag: el.tagName,
      type: el.type || '',
      xpath: computeXPath(el, root),
      signature: computeSignature(el, role, name) + stableSuffix(ids),
      inViewport,
      rect: {
        x: Math.round(absX + rect.width / 2),
        y: Math.round(absY + rect.height / 2),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
    if (root && root.frameUrl !== undefined) entry.frameUrl = root.frameUrl;
    if (ids) entry.ids = ids;
    const state = computeState(el);
    if (state) entry.state = state;
    out.push(entry);
  }

  // Dedup by signature (keeps first occurrence — usually the topmost, most-visible).
  const bySig = new Map();
  for (const el of out) {
    if (!bySig.has(el.signature)) bySig.set(el.signature, el);
  }
  return [...bySig.values()];
})`;

