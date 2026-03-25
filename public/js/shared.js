// ── Shared utilities for all panels ──

// Auth token (sessionStorage preferred, localStorage fallback)
let AUTH_TOKEN = sessionStorage.getItem('sax_token') || localStorage.getItem('sax_token') || '';
const urlToken = new URLSearchParams(location.search).get('token');
if (urlToken) {
  AUTH_TOKEN = urlToken;
  sessionStorage.setItem('sax_token', urlToken);
  const cleanUrl = new URL(location.href);
  cleanUrl.searchParams.delete('token');
  history.replaceState(null, '', cleanUrl.pathname + cleanUrl.hash);
} else if (AUTH_TOKEN) {
  sessionStorage.setItem('sax_token', AUTH_TOKEN);
}

const API = '';

// ── Theme toggle (dark/light) ──
function toggleTheme() {
  const html = document.documentElement;
  const current = html.getAttribute('data-theme');
  const next = current === 'light' ? 'dark' : 'light';
  html.setAttribute('data-theme', next);
  localStorage.setItem('sax_theme', next);
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = next === 'light' ? '🌙' : '☀';
}
// Apply saved theme on load
(function() {
  const saved = localStorage.getItem('sax_theme') || 'dark';
  if (saved === 'light') document.documentElement.setAttribute('data-theme', 'light');
  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('theme-toggle');
    if (btn) btn.textContent = saved === 'light' ? '🌙' : '☀';
  });
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
  h = h.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="code-block"><code>$2</code></pre>');
  h = h.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/\*(.+?)\*/g, '<em>$1</em>');
  h = h.replace(/^- (.+)$/gm, '<li style="margin-left:16px;list-style:disc">$1</li>');
  h = h.replace(/^\d+\. (.+)$/gm, '<li style="margin-left:16px;list-style:decimal">$1</li>');
  h = h.replace(/^### (.+)$/gm, '<h4 class="md-h">$1</h4>');
  h = h.replace(/^## (.+)$/gm, '<h3 class="md-h">$1</h3>');
  h = h.replace(/^# (.+)$/gm, '<h2 class="md-h">$1</h2>');
  const urlPlaceholders = [];
  h = h.replace(/(https?:\/\/[^\s<"']+)/g, (match) => {
    const idx = urlPlaceholders.length;
    const safeUrl = sanitizeUrl(match);
    urlPlaceholders.push(`<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="md-link">${match}</a>`);
    return '%%URL' + idx + '%%';
  });
  h = h.replace(/\n/g, '<br>');
  for (let i = 0; i < urlPlaceholders.length; i++) {
    h = h.replace('%%URL' + i + '%%', urlPlaceholders[i]);
  }
  // Final sweep: strip any event handlers or script injections
  return sanitizeHtml(h);
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
