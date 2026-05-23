// ── Theme toggle (dark/light/system) ──
const THEME_CYCLE = ['dark', 'light', 'system'];
const THEME_ICONS = { dark: '☀', light: '🌙', system: '💻' };
const THEME_LABELS = { dark: 'Dark', light: 'Light', system: 'System' };

function getEffectiveTheme(pref) {
  if (pref === 'system') return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  return pref;
}

function applyTheme(pref) {
  const effective = getEffectiveTheme(pref);
  document.documentElement.setAttribute('data-theme', effective);
  const btn = document.getElementById('theme-toggle');
  if (btn) { btn.textContent = THEME_ICONS[pref]; btn.title = 'Theme: ' + THEME_LABELS[pref]; }
}

function toggleTheme() {
  const saved = localStorage.getItem('sax_theme') || 'dark';
  const idx = THEME_CYCLE.indexOf(saved);
  const next = THEME_CYCLE[(idx + 1) % THEME_CYCLE.length];
  localStorage.setItem('sax_theme', next);
  applyTheme(next);
  // When running in the Electron shell, mirror the choice to the desktop
  // so the BrowserWindow's underlying paint colour follows the theme
  // (otherwise the top strip behind the traffic lights stays dark in light
  // mode). Safe to call in browser — `window.desktop` is undefined there.
  try { window.desktop?.setSetting?.('theme', next); } catch {}
  // Push to server so the choice survives a refresh — without this, the
  // async /api/settings fetch on next load would overwrite localStorage
  // with the stale server-side default.
  const tok = (new URLSearchParams(location.search).get('token') || localStorage.getItem('sax_token') || '');
  fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
    body: JSON.stringify({ theme: next }),
  }).catch(() => {});
}

// Apply saved theme on load — check server-side setting first, then localStorage
(function() {
  // Try server-side theme setting
  fetch('/api/settings', { headers: { Authorization: 'Bearer ' + (new URLSearchParams(location.search).get('token') || localStorage.getItem('sax_token') || '') } })
    .then(r => r.ok ? r.json() : null)
    .then(settings => {
      if (settings && settings.theme) {
        localStorage.setItem('sax_theme', settings.theme);
        applyTheme(settings.theme);
      }
    }).catch(() => {});
  // Apply local default immediately (server override arrives async)
  applyTheme(localStorage.getItem('sax_theme') || 'dark');
  // Listen for OS theme changes when in system mode
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (localStorage.getItem('sax_theme') === 'system') applyTheme('system');
  });
  // Re-read localStorage on DOMContentLoaded so a server-side theme fetched async still wins
  document.addEventListener('DOMContentLoaded', () => applyTheme(localStorage.getItem('sax_theme') || 'dark'));
  // Sync the renderer's effective theme to the Electron wrapper on every
  // page load. The wrapper's stored theme drives nativeTheme.themeSource +
  // the native titleBarOverlay color at first frame on next launch. Without
  // this, a user who toggled theme via a path other than toggleTheme()
  // (e.g. early browser-only render, settings imported from another
  // machine, defaults) ends up with renderer=dark, wrapper=system, and the
  // OS chrome paints light because the wrapper still defers to OS. Idempotent.
  try { window.desktop?.setSetting?.('theme', localStorage.getItem('sax_theme') || 'dark'); } catch {}
})();

// Settings change listener is in chat.js onmessage handler (more reliable — survives WS reconnects)
