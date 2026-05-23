// ── Shared utilities for all panels ──
// This file is the bootstrap entry: it establishes AUTH_TOKEN and API
// in window scope so every shared-*.js sibling module can use them.
// Load order in app.html (and any other HTML loading shared.js): this file
// MUST come first; shared-theme, shared-desktop, shared-escape, shared-md,
// shared-dom, shared-api follow in that order.

// Auth token (localStorage persists across tabs/sessions, sessionStorage as backup)
let AUTH_TOKEN = localStorage.getItem('sax_token') || sessionStorage.getItem('sax_token') || '';
const urlToken = new URLSearchParams(location.search).get('token');
if (urlToken) {
  AUTH_TOKEN = urlToken;
  localStorage.setItem('sax_token', urlToken);
  sessionStorage.setItem('sax_token', urlToken);
  const cleanUrl = new URL(location.href);
  cleanUrl.searchParams.delete('token');
  history.replaceState(null, '', cleanUrl.pathname + cleanUrl.hash);
} else if (AUTH_TOKEN) {
  localStorage.setItem('sax_token', AUTH_TOKEN);
  sessionStorage.setItem('sax_token', AUTH_TOKEN);
}

const API = '';
