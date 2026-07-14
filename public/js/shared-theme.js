// ── Theme toggle (dark/light/system) ──
const THEME_CYCLE = ['dark', 'light', 'system'];
const THEME_ICONS = { dark: '☀', light: '🌙', system: '💻' };
const THEME_LABELS = { dark: 'Dark', light: 'Light', system: 'System' };

// Accent palettes — the "Theme" axis, independent of the light/dark Mode axis.
// Each name maps to an `html[data-palette="…"]` block in app.css that overrides
// the accent tokens (with a light-mode variant for contrast).
const PALETTES = ['aurora', 'forge', 'phosphor', 'nebula', 'cobalt', 'bloom', 'graphite'];
function applyPalette(name) {
  if (!PALETTES.includes(name)) name = 'phosphor';
  document.documentElement.setAttribute('data-palette', name);
  // Palettes redefine --surface (not just accents), so the native overlay
  // must re-sample here — applyTheme() alone only covers mode changes.
  syncNativeChromeColor();
  syncNativeTitlebarOverlay();
}

function getEffectiveTheme(pref) {
  if (pref === 'system') return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  return pref;
}

// Tell the mobile browser what colour to paint its own chrome — the phone's
// native status/nav bar and Android address bar read <meta name="theme-color">.
// Without it, light mode leaves the native bar a default bright white with no
// contrast (icons/text invisible). We track the app's real --bg per theme so
// the OS renders the bar to match and picks legible icon contrast for it.
function syncNativeChromeColor() {
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    document.head.appendChild(meta);
  }
  // Read the computed --bg so this always matches the active CSS theme rather
  // than a hardcoded value that could drift from app.css.
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  if (bg) meta.setAttribute('content', bg);
}

function applyTheme(pref) {
  const effective = getEffectiveTheme(pref);
  document.documentElement.setAttribute('data-theme', effective);
  syncNativeChromeColor();
  syncNativeTitlebarOverlay();
  const btn = document.getElementById('theme-toggle');
  if (btn) { btn.textContent = THEME_ICONS[pref]; btn.title = 'Theme: ' + THEME_LABELS[pref]; }
}

// Windows Electron only: repaint the native min/max/X titleBarOverlay to the
// SAME color as the in-window top bar so the top-right corner never shows a
// mismatched block. The top bar (#desktop-titlebar / sidebar) is painted from
// --surface, so we sample the computed --surface here and hand the overlay a
// concrete hex + a contrasting symbol color. Reporting the real computed value
// (instead of the desktop wrapper's separately-stored theme) makes the corner
// match by construction even when the two theme sources have drifted. No-op in
// a plain browser and on macOS — window.desktop is undefined / the handler
// early-returns.
function syncNativeTitlebarOverlay() {
  try {
    if (!(window.desktop && window.desktop.reportChromeTint)) return;
    if (!document.body) return; // pre-DOM call; applyTheme re-runs on DOMContentLoaded
    const surface = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim();
    if (!surface) return;
    // Resolve --surface (may be #hex or rgb()) to r,g,b via a probe element so
    // luminance + hex are computed from what actually paints.
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:' + surface;
    document.body.appendChild(probe);
    const rgb = getComputedStyle(probe).color;
    probe.remove();
    const m = rgb.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    if (!m) return;
    const r = +m[1], g = +m[2], b = +m[3];
    const toHex = (v) => ('0' + v.toString(16)).slice(-2);
    const hex = '#' + toHex(r) + toHex(g) + toHex(b);
    const isDark = (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
    const symbolColor = isDark ? '#e0e0e8' : '#1a1a2e';
    window.desktop.reportChromeTint(hex, symbolColor);
  } catch {}
}

// Persist a partial settings patch to the server so choices survive a refresh
// (the async /api/settings fetch on next load would otherwise overwrite
// localStorage with the stale server default). No-op-safe in a plain browser.
function persistSetting(patch) {
  const tok = (new URLSearchParams(location.search).get('token') || localStorage.getItem('lax_token') || '');
  fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
    body: JSON.stringify(patch),
  }).catch(() => {});
}

// Set a specific Mode (brightness) preference. The sidebar toggle cycles these;
// the Appearance tab sets them directly.
function setThemePref(pref) {
  if (!THEME_CYCLE.includes(pref)) return;
  localStorage.setItem('lax_theme', pref);
  applyTheme(pref);
  // Mirror to the Electron shell so the window's native paint follows the theme
  // (otherwise the strip behind the traffic lights stays dark in light mode).
  try { window.desktop?.setSetting?.('theme', pref); } catch {}
  persistSetting({ theme: pref });
  if (typeof refreshAppearanceUI === 'function') refreshAppearanceUI();
}

// Set the accent Palette (the "Theme" axis). Applies in both light and dark.
function setPalette(name) {
  if (!PALETTES.includes(name)) return;
  localStorage.setItem('lax_palette', name);
  applyPalette(name);
  persistSetting({ palette: name });
  if (typeof refreshAppearanceUI === 'function') refreshAppearanceUI();
}

function toggleTheme() {
  const saved = localStorage.getItem('lax_theme') || 'dark';
  const idx = THEME_CYCLE.indexOf(saved);
  setThemePref(THEME_CYCLE[(idx + 1) % THEME_CYCLE.length]);
}

// Apply saved theme on load — check server-side setting first, then localStorage
(function() {
  // Try server-side theme setting
  fetch('/api/settings', { headers: { Authorization: 'Bearer ' + (new URLSearchParams(location.search).get('token') || localStorage.getItem('lax_token') || '') } })
    .then(r => r.ok ? r.json() : null)
    .then(settings => {
      if (settings && settings.theme) {
        localStorage.setItem('lax_theme', settings.theme);
        applyTheme(settings.theme);
      }
      if (settings && settings.palette) {
        localStorage.setItem('lax_palette', settings.palette);
        applyPalette(settings.palette);
      }
      if (typeof refreshAppearanceUI === 'function') refreshAppearanceUI();
    }).catch(() => {});
  // Apply local defaults immediately (server override arrives async)
  applyTheme(localStorage.getItem('lax_theme') || 'dark');
  applyPalette(localStorage.getItem('lax_palette') || 'phosphor');
  // Listen for OS theme changes when in system mode
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (localStorage.getItem('lax_theme') === 'system') applyTheme('system');
  });
  // Re-read localStorage on DOMContentLoaded so a server-side theme fetched async still wins
  document.addEventListener('DOMContentLoaded', () => applyTheme(localStorage.getItem('lax_theme') || 'dark'));
  // Sync the renderer's effective theme to the Electron wrapper on every
  // page load. The wrapper's stored theme drives nativeTheme.themeSource +
  // the native titleBarOverlay color at first frame on next launch. Without
  // this, a user who toggled theme via a path other than toggleTheme()
  // (e.g. early browser-only render, settings imported from another
  // machine, defaults) ends up with renderer=dark, wrapper=system, and the
  // OS chrome paints light because the wrapper still defers to OS. Idempotent.
  try { window.desktop?.setSetting?.('theme', localStorage.getItem('lax_theme') || 'dark'); } catch {}
})();

// Settings change listener is in chat.js onmessage handler (more reliable — survives WS reconnects)
