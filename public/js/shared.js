// ── Shared utilities for all panels ──
// This file is the bootstrap entry: it establishes AUTH_TOKEN and API
// in window scope so every shared-*.js sibling module can use them.
// Load order in app.html (and any other HTML loading shared.js): this file
// MUST come first; shared-theme, shared-desktop, shared-escape, shared-md,
// shared-dom, shared-api follow in that order.

// Auth token (localStorage persists across tabs/sessions, sessionStorage as backup)
let AUTH_TOKEN = localStorage.getItem('lax_token') || sessionStorage.getItem('lax_token') || '';
const urlToken = new URLSearchParams(location.search).get('token');
// In Electron the renderer URL never goes to a browser history / address
// bar / clipboard — the only consequence of stripping the token via
// history.replaceState is that a webContents.reload() loses it and the
// session breaks (CmdOrCtrl+R from the app menu or location.reload() from
// the in-window titlebar). Keep the URL token intact in Electron so every
// reload re-tokenizes correctly. In a real browser, keep the strip — the
// token would otherwise live in tab history and screenshotted address bars.
const isElectron = /Electron/i.test(navigator.userAgent);
if (urlToken) {
  AUTH_TOKEN = urlToken;
  localStorage.setItem('lax_token', urlToken);
  sessionStorage.setItem('lax_token', urlToken);
  if (!isElectron) {
    const cleanUrl = new URL(location.href);
    cleanUrl.searchParams.delete('token');
    history.replaceState(null, '', cleanUrl.pathname + cleanUrl.hash);
  }
} else if (AUTH_TOKEN) {
  localStorage.setItem('lax_token', AUTH_TOKEN);
  sessionStorage.setItem('lax_token', AUTH_TOKEN);
}

const API = '';
