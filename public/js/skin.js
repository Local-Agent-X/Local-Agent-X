// ── The skin layer: the user's own look, painted onto the window ─────────
// A skin (src/skins/skin-store.ts; "theme" in Settings) is data in the user's
// own folder, never part of the app, so an update cannot undo it. This file
// turns the active one into what the window shows:
//   • colors    → the same CSS variables the built-in palettes set, written
//                 inline on <html> so they win over whichever palette is on;
//   • background → #skin-bg, a picture or a muted looping video behind the
//                 UI, blurred and dimmed as the skin says;
//   • panels    → --panel-solid, how solid the sidebars and the composer are
//                 over it (app.css; the same rule the moving layer uses);
//   • effect    → handed to skin-effects.js.
// --bg and --surface stay opaque hex: the desktop title bar and the phone's
// status bar are painted from them (shared-theme.js).
//
// Which skin is on is the `skin` setting. The last one painted is cached per
// browser so the window does not flash the built-in look on every load.
// Opening the app with ?skin=off turns the skin off, whatever it contains.
(function () {
  var CACHE_KEY = 'lax_skin_cache';
  var VARS = ['--bg', '--surface', '--surface-2', '--border', '--text', '--muted', '--hover', '--user-bg', '--agent-bg',
    '--input-bg', '--accent', '--accent-dim', '--skin-blur', '--skin-dim', '--panel-solid'];
  var skins = [], active = '', shown = null, bgEl = null, codeOf = {};

  function token() { return (typeof AUTH_TOKEN === 'string' && AUTH_TOKEN) || new URLSearchParams(location.search).get('token') || localStorage.getItem('lax_token') || ''; }
  function fileUrl(skin, file) {
    return '/skins/' + encodeURIComponent(skin.slug) + '/' + encodeURIComponent(file) + '?token=' + encodeURIComponent(token()) + '&t=' + encodeURIComponent(skin.updatedAt || '');
  }
  function rgb(hex) { return [0, 2, 4].map(function (i) { return parseInt(hex.slice(i, i + 2), 16); }); }
  /** `a` moved a fraction `t` of the way to `b`; both 6-digit hex without '#'. */
  function mix(a, b, t) {
    var x = rgb(a), y = rgb(b);
    return x.map(function (v, i) { return ('0' + Math.round(v + (y[i] - v) * t).toString(16)).slice(-2); }).join('');
  }
  function isDark(hex) { var c = rgb(hex); return (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255 < 0.5; }

  /** Every palette variable a skin's colors decide. A skin names up to four
   *  colors; the rest (borders, hover, bubbles) are mixed from them the way
   *  the built-in palettes relate theirs. */
  function colorVars(c) {
    var v = {};
    if (c.accent) { v['--accent'] = '#' + c.accent; v['--accent-dim'] = '#' + c.accent + '88'; }
    var panel = c.surface || c.bg;
    if (!panel) return v;
    var dark = isDark(panel);
    var surface = c.surface || mix(c.bg, 'FFFFFF', dark ? 0.04 : 0.5);
    var bg = c.bg || mix(c.surface, '000000', dark ? 0.18 : 0.05);
    var text = c.text || (dark ? 'D8DCE6' : '1A2230');
    v['--bg'] = '#' + bg; v['--surface'] = '#' + surface; v['--text'] = '#' + text;
    v['--surface-2'] = '#' + mix(surface, text, 0.07);
    v['--hover'] = '#' + mix(surface, text, 0.09);
    v['--border'] = '#' + mix(surface, text, 0.16);
    v['--input-bg'] = '#' + mix(surface, text, 0.04);
    v['--agent-bg'] = '#' + mix(surface, bg, 0.5);
    v['--user-bg'] = '#' + mix(surface, c.accent || text, 0.14);
    v['--muted'] = '#' + mix(text, surface, 0.45);
    return v;
  }

  function paintBackground(skin) {
    if (!bgEl) {
      bgEl = document.createElement('div');
      bgEl.id = 'skin-bg';
      bgEl.setAttribute('aria-hidden', 'true');
      document.body.insertBefore(bgEl, document.body.firstChild);
    }
    var file = skin && skin.background;
    var key = file ? fileUrl(skin, file) + '|' + skin.fit : '';
    if (bgEl.dataset.key === key) return;
    bgEl.dataset.key = key;
    bgEl.textContent = '';
    if (!file) return;
    var media;
    if (/\.(mp4|webm)$/i.test(file)) {
      media = document.createElement('video');
      media.muted = true; media.loop = true; media.playsInline = true;
      // A still frame for people who asked their system for less motion.
      media.autoplay = !matchMedia('(prefers-reduced-motion: reduce)').matches;
      media.src = fileUrl(skin, file);
      media.style.objectFit = skin.fit === 'contain' ? 'contain' : 'cover';
    } else {
      media = document.createElement('div');
      media.style.backgroundImage = 'url("' + fileUrl(skin, file) + '")';
      media.style.backgroundSize = skin.fit === 'tile' ? 'auto' : skin.fit;
      media.style.backgroundRepeat = skin.fit === 'tile' ? 'repeat' : 'no-repeat';
    }
    media.className = 'skin-media';
    var dim = document.createElement('div');
    dim.className = 'skin-dim';
    bgEl.appendChild(media);
    bgEl.appendChild(dim);
  }

  async function effectOf(skin) {
    var fx = skin && skin.effect;
    if (!fx) return null;
    if (fx.kind !== 'custom') return fx;
    var key = skin.slug + '@' + skin.updatedAt;
    if (!(key in codeOf)) {
      try {
        var r = await fetch('/skins/' + encodeURIComponent(skin.slug) + '/' + encodeURIComponent(skin.code), { headers: { Authorization: 'Bearer ' + token() } });
        codeOf[key] = r.ok ? await r.text() : '';
      } catch (e) { codeOf[key] = ''; }
    }
    return Object.assign({}, fx, { code: codeOf[key] });
  }

  /** Paint `skin`, or the built-in look for null. */
  function paint(skin) {
    shown = skin || null;
    var root = document.documentElement;
    VARS.forEach(function (name) { root.style.removeProperty(name); });
    if (skin) {
      var vars = colorVars(skin.colors || {});
      Object.keys(vars).forEach(function (name) { root.style.setProperty(name, vars[name]); });
      root.style.setProperty('--skin-blur', (skin.blur || 0) + 'px');
      root.style.setProperty('--skin-dim', String(skin.dim || 0));
      root.style.setProperty('--panel-solid', Math.round((skin.opacity == null ? 0.8 : skin.opacity) * 100) + '%');
    }
    paintBackground(skin);
    document.body.classList.toggle('skin-on', !!(skin && skin.background));
    // The mode follows the skin's panels (forcedMode), and the native chrome
    // is re-sampled from the colors now on <html>.
    if (typeof applyTheme === 'function') applyTheme(localStorage.getItem('lax_theme') || 'dark');
    effectOf(skin).then(function (fx) { if (shown === (skin || null) && window.laxEffects) window.laxEffects.setSkinEffect(fx); });
    try { if (skin) localStorage.setItem(CACHE_KEY, JSON.stringify(skin)); else localStorage.removeItem(CACHE_KEY); } catch (e) {}
  }

  function find(slug) { return skins.find(function (s) { return s.slug === slug; }) || null; }

  /** Read the library and the active skin from the server, and paint it. */
  async function load() {
    try {
      var r = await fetch('/api/skins', { headers: { Authorization: 'Bearer ' + token() } });
      if (!r.ok) return;
      var data = await r.json();
      skins = Array.isArray(data.skins) ? data.skins : [];
      active = data.active || '';
      paint(find(active));
      document.dispatchEvent(new CustomEvent('lax-skins-loaded'));
    } catch (e) { /* offline: the cached skin stays */ }
  }

  /** Turn a skin on by its slug ('' is the built-in look), for every tab. */
  function use(slug) {
    active = find(slug) ? slug : '';
    paint(find(active));
    if (typeof persistSetting === 'function') persistSetting({ skin: active });
  }

  window.laxSkin = {
    load: load,
    use: use,
    list: function () { return skins; },
    active: function () { return active; },
    /** Paint a skin as it is being edited, before its save lands. */
    draft: function (skin) { if (skin && skin.slug === active) paint(skin); },
    /** 'dark' | 'light' when the skin's panel color decides the mode, else null. */
    forcedMode: function () {
      var c = shown && shown.colors, panel = c && (c.surface || c.bg);
      return panel ? (isDark(panel) ? 'dark' : 'light') : null;
    },
    fileUrl: fileUrl
  };

  if (new URLSearchParams(location.search).get('skin') === 'off') {
    try { localStorage.removeItem(CACHE_KEY); } catch (e) {}
    if (typeof persistSetting === 'function') persistSetting({ skin: '' });
    return;
  }
  try { var cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); if (cached && cached.slug) paint(cached); } catch (e) {}
  load();
})();
