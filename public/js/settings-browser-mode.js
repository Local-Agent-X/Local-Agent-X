// ── Settings: Browser Profile / Session Mode ──
//
// Chooses whether the agent drives its own dedicated Chrome profile
// (isolated, default) or the user's real Chrome profile with all their
// saved passwords + cookies (attach — power users only).
//
// `browserMode` is a PROTECTED runtime setting: the server only accepts a
// change carrying a real operator token (this authenticated UI does; the
// agent's loopback http_request does not). So the agent can ask to use the
// real browser but can never silently flip it on itself. Persisted through
// the generic /api/settings endpoint, which mirrors it into config.json +
// ctx.config so the next browser launch reads the live value.

const BROWSER_MODE_HINTS = {
  isolated: 'Agent runs in a dedicated Chrome profile (~/.lax/chrome-profile) with its own cookies and logins. Your real browser and saved passwords are never touched.',
  attach: '⚠️ Agent drives YOUR real Chrome profile — it inherits your saved passwords, cookies, and logged-in sessions, and can act as you on any site you’re signed into. You must QUIT Chrome completely first (⌘Q, or right-click the Dock icon → Quit) — just closing the window leaves a background process that locks the profile, and the agent will refuse to launch until it’s fully closed. Takes effect on the next browser action.'
};

async function loadBrowserMode() {
  try {
    const r = await apiFetch('/api/settings');
    if (!r.ok) return;
    const s = await r.json();
    const mode = s.browserMode === 'attach' ? 'attach' : 'isolated';
    const sel = document.getElementById('cfg-browser-mode');
    if (sel) sel.value = mode;
    const hint = document.getElementById('browser-mode-hint');
    if (hint) hint.textContent = BROWSER_MODE_HINTS[mode];
  } catch (e) { console.warn('[browser-mode] load failed', e); }
}

async function setBrowserModeUI(mode) {
  const hint = document.getElementById('browser-mode-hint');
  if (hint) hint.textContent = BROWSER_MODE_HINTS[mode] || '';
  try {
    const r = await apiFetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ browserMode: mode })
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      console.warn('[browser-mode] save failed', err);
      // Revert to isolated (the safe default) and surface the error.
      const sel = document.getElementById('cfg-browser-mode');
      if (sel) sel.value = 'isolated';
      if (hint) hint.textContent = err.error || 'Failed to change browser mode.';
    }
  } catch (e) { console.warn('[browser-mode] save failed', e); }
}

document.addEventListener('DOMContentLoaded', loadBrowserMode);
