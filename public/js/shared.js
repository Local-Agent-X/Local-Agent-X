// ── Shared utilities for all panels ──

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

// ── Theme toggle (dark/light/system) ──
const THEME_CYCLE = ['dark', 'light', 'system'];
const THEME_ICONS = { dark: '\u2600', light: '\uD83C\uDF19', system: '\uD83D\uDCBB' };
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
}

// Apply saved theme on load
(function() {
  const saved = localStorage.getItem('sax_theme') || 'dark';
  applyTheme(saved);
  // Listen for OS theme changes when in system mode
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (localStorage.getItem('sax_theme') === 'system') applyTheme('system');
  });
  document.addEventListener('DOMContentLoaded', () => applyTheme(saved));
})();

function uid() { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7); }

function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s || '');
  return d.innerHTML;
}

// URL sanitizer — strips javascript: URIs, data: URIs, and event handler injections
function sanitizeUrl(url) {
  // Decode HTML entities that esc() produced, validate, re-encode
  const decoded = url.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
  // Only allow http/https
  if (!/^https?:\/\//i.test(decoded)) return '#';
  // Re-encode for safe attribute insertion
  return decoded.replace(/"/g, '%22').replace(/'/g, '%27').replace(/</g, '%3C').replace(/>/g, '%3E');
}

// Final output sanitizer — strips any event handlers that might have snuck through
function sanitizeHtml(html) {
  // Remove on* event handlers from any tags
  return html.replace(/\bon\w+\s*=\s*["'][^"']*["']/gi, '')
             .replace(/\bon\w+\s*=\s*[^\s>]*/gi, '')
             // Remove javascript: in any href/src
             .replace(/javascript\s*:/gi, 'blocked:')
             // Remove data: URIs in href/src (except images in img tags)
             .replace(/href\s*=\s*["']data:/gi, 'href="blocked:');
}

// Markdown renderer
function md(s) {
  if (!s) return '';
  let h = esc(s);
  // Code blocks with copy button (feature 91)
  h = h.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const id = 'cb-' + Math.random().toString(36).slice(2, 8);
    return `<div class="code-block-wrapper"><div class="code-block-header"><span class="code-lang">${lang || 'code'}</span><button class="code-copy-btn" onclick="copyCodeBlock('${id}')" aria-label="Copy code">Copy</button></div><pre class="code-block" id="${id}"><code>${code}</code></pre></div>`;
  });
  h = h.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/\*(.+?)\*/g, '<em>$1</em>');
  h = h.replace(/^- (.+)$/gm, '<li style="margin-left:16px;list-style:disc">$1</li>');
  h = h.replace(/^\d+\. (.+)$/gm, '<li style="margin-left:16px;list-style:decimal">$1</li>');
  h = h.replace(/^### (.+)$/gm, '<h4 class="md-h">$1</h4>');
  h = h.replace(/^## (.+)$/gm, '<h3 class="md-h">$1</h3>');
  h = h.replace(/^# (.+)$/gm, '<h2 class="md-h">$1</h2>');
  // Inline image rendering (feature 92) — render image URLs and base64 inline
  const imgPlaceholders = [];
  h = h.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
    const idx = imgPlaceholders.length;
    const safeSrc = /^(https?:\/\/|data:image\/)/.test(src) ? src : '#';
    imgPlaceholders.push(`<img src="${safeSrc}" alt="${esc(alt)}" class="inline-chat-img" onclick="openLightbox(this.src)" />`);
    return '%%IMG' + idx + '%%';
  });
  const urlPlaceholders = [];
  h = h.replace(/(https?:\/\/[^\s<"']+\.(?:png|jpg|jpeg|gif|webp|svg))(\s|$|<br>)/gi, (match, url, after) => {
    const idx = imgPlaceholders.length;
    const safeUrl = sanitizeUrl(url);
    imgPlaceholders.push(`<img src="${safeUrl}" alt="image" class="inline-chat-img" onclick="openLightbox(this.src)" />`);
    return '%%IMG' + idx + '%%' + after;
  });
  h = h.replace(/(https?:\/\/[^\s<"']+)/g, (match) => {
    const idx = urlPlaceholders.length;
    const safeUrl = sanitizeUrl(match);
    urlPlaceholders.push(`<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="md-link">${match}</a>`);
    return '%%URL' + idx + '%%';
  });
  // Base64 image data inline (feature 92)
  h = h.replace(/(data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+)/g, (match) => {
    const idx = imgPlaceholders.length;
    imgPlaceholders.push(`<img src="${match}" alt="image" class="inline-chat-img" onclick="openLightbox(this.src)" />`);
    return '%%IMG' + idx + '%%';
  });
  h = h.replace(/\n/g, '<br>');
  for (let i = 0; i < urlPlaceholders.length; i++) {
    h = h.replace('%%URL' + i + '%%', urlPlaceholders[i]);
  }
  for (let i = 0; i < imgPlaceholders.length; i++) {
    h = h.replace('%%IMG' + i + '%%', imgPlaceholders[i]);
  }
  // Final sweep: strip any event handlers or script injections
  return sanitizeHtml(h);
}

// Copy code block to clipboard (feature 91)
function copyCodeBlock(id) {
  const block = document.getElementById(id);
  if (!block) return;
  const text = block.textContent;
  navigator.clipboard.writeText(text).then(() => {
    const btn = block.closest('.code-block-wrapper')?.querySelector('.code-copy-btn');
    if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy'; }, 2000); }
  });
}

// Auth check (updates sidebar footer)
async function checkAuth() {
  try {
    const r = await fetch(`${API}/api/auth/status`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    const d = await r.json();
    const dot = document.getElementById('auth-dot');
    const label = document.getElementById('auth-label');
    if (dot) dot.className = d.authenticated ? 'ok' : '';
    if (label) label.textContent = d.authenticated
      ? (d.method === 'oauth' ? 'OAuth connected' : 'API key active')
      : 'not connected';
  } catch {
    const label = document.getElementById('auth-label');
    if (label) label.textContent = 'offline';
  }
}

// Fetch helper with auth
async function apiFetch(path, opts = {}) {
  return fetch(`${API}${path}`, {
    ...opts,
    headers: { ...opts.headers, Authorization: `Bearer ${AUTH_TOKEN}` },
  });
}

async function apiJson(path, opts = {}) {
  const r = await apiFetch(path, opts);
  return r.json();
}

async function apiPost(path, body) {
  return apiJson(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
