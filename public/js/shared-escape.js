function uid() { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7); }

function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s || '');
  return d.innerHTML.replace(/'/g, '&#39;').replace(/"/g, '&quot;');
}

// URL sanitizer — strips javascript: URIs, data: URIs, and event handler injections
function sanitizeUrl(url) {
  // Decode HTML entities that esc() produced, validate, re-encode
  const decoded = url.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
  // Only allow http/https
  if (!/^https?:\/\//i.test(decoded)) return '#';
  // Block dangerous protocols even if they appear after whitespace/encoding tricks
  if (/^\s*javascript\s*:/i.test(decoded) || /^\s*vbscript\s*:/i.test(decoded) || /^\s*data\s*:/i.test(decoded)) return '#';
  // Re-encode for safe attribute insertion
  return decoded.replace(/"/g, '%22').replace(/'/g, '%27').replace(/</g, '%3C').replace(/>/g, '%3E');
}

// Final output sanitizer — allowlist DOM sanitizer for all rendered markdown.
// Parses the HTML into an inert <template> fragment (scripts don't run, img/src
// don't fetch during parse), then walks the tree keeping only known-safe tags,
// attributes, URL schemes, and style values; everything else is dropped or
// unwrapped. This replaces the old string-replacement regex pass, which a
// regex sanitizer can't make XSS-grade: it misses parser mutation (e.g.
// <svg><script>), attribute/entity obfuscation, and nesting tricks that only
// surface once the browser actually parses the markup. Walking the real DOM
// closes those vectors. on* handler attributes are always stripped (lightbox
// clicks are wired via document-level delegation, not inline onclick).
function sanitizeHtml(html) {
  const ALLOWED_TAGS = new Set([
    'p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'h2', 'h3', 'h4', 'h5',
    'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'blockquote', 'hr', 'div', 'span', 'a', 'img', 'button'
  ]);
  const DROP_WITH_SUBTREE = new Set([
    'script', 'style', 'iframe', 'object', 'embed', 'form', 'link', 'meta',
    'base', 'svg', 'math', 'noscript', 'template', 'frame', 'frameset',
    'applet', 'audio', 'video', 'source', 'track'
  ]);
  const GLOBAL_ATTRS = new Set(['class', 'style']);
  const TAG_ATTRS = {
    a: ['href', 'target', 'rel'],
    img: ['src', 'alt'],
    button: ['type', 'aria-label']
  };

  function isSafeUrl(value) {
    const decoded = String(value)
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
      .trim();
    const schemeMatch = decoded.match(/^([a-z][a-z0-9+.-]*):/i);
    if (schemeMatch) {
      const scheme = schemeMatch[1].toLowerCase();
      if (scheme === 'http' || scheme === 'https') return true;
      if (/^data:image\//i.test(decoded)) return true;
      return false;
    }
    // No scheme: relative paths, query/fragment, bare '#' — md() builds these safely.
    return true;
  }

  function clean(node) {
    const children = Array.prototype.slice.call(node.childNodes);
    for (let i = 0; i < children.length; i++) {
      const el = children[i];
      if (el.nodeType !== 1) continue;
      processElement(el);
    }
  }

  // Per-element dispatch: DROP_WITH_SUBTREE → remove; not-ALLOWED → unwrap;
  // else → cleanElement. Unwrapped children route back through here (not
  // cleanElement) so dangerous/unknown moved nodes get the full treatment.
  function processElement(el) {
    const tag = el.tagName.toLowerCase();

    if (DROP_WITH_SUBTREE.has(tag)) {
      el.remove();
      return;
    }

    if (!ALLOWED_TAGS.has(tag)) {
      // Unwrap: splice the element's children in its place, then dispatch them.
      const moved = Array.prototype.slice.call(el.childNodes);
      const parent = el.parentNode;
      for (let j = 0; j < moved.length; j++) parent.insertBefore(moved[j], el);
      el.remove();
      for (let j = 0; j < moved.length; j++) {
        if (moved[j].nodeType === 1) processElement(moved[j]);
      }
      return;
    }

    cleanElement(el);
  }

  function cleanElement(el) {
    const tag = el.tagName.toLowerCase();
    const names = Array.prototype.slice.call(el.attributes).map(a => a.name);
    for (let k = 0; k < names.length; k++) {
      const name = names[k];
      const lower = name.toLowerCase();
      const allowed = !lower.startsWith('on') &&
        (GLOBAL_ATTRS.has(lower) || (TAG_ATTRS[tag] && TAG_ATTRS[tag].indexOf(lower) !== -1));
      if (!allowed) { el.removeAttribute(name); continue; }
      if (lower === 'href' || lower === 'src') {
        if (!isSafeUrl(el.getAttribute(name))) el.setAttribute(name, '#');
      } else if (lower === 'style') {
        if (/url\s*\(|expression|javascript:|@import|<\//i.test(el.getAttribute(name) || '')) {
          el.removeAttribute(name);
        }
      }
    }
    clean(el);
  }

  const tpl = document.createElement('template');
  tpl.innerHTML = String(html || '');
  clean(tpl.content);
  return tpl.innerHTML;
}
