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

// Final output sanitizer — strips any event handlers that might have snuck through
function sanitizeHtml(html) {
  return html.replace(/\bon\w+\s*=/gi, 'data-blocked=')
             .replace(/javascript\s*:/gi, 'blocked:')
             .replace(/vbscript\s*:/gi, 'blocked:')
             .replace(/data\s*:\s*text\/html/gi, 'blocked:')
             .replace(/href\s*=\s*["']?\s*data:/gi, 'href="blocked:')
             .replace(/href\s*=\s*["']?\s*javascript:/gi, 'href="blocked:')
             .replace(/formaction\s*=/gi, 'data-blocked=');
}

// Markdown renderer
function md(s) {
  if (!s) return '';

  // Placeholders for protected content
  const placeholders = [];
  function ph(html) { const i = placeholders.length; placeholders.push(html); return '\x00PH' + i + '\x00'; }

  let h = s;

  // 1. Extract code blocks first (protect from further processing)
  h = h.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const id = 'cb-' + Math.random().toString(36).slice(2, 8);
    return ph(`<div class="code-block-wrapper"><div class="code-block-header"><span class="code-lang">${lang || 'code'}</span><button class="code-copy-btn" onclick="copyCodeBlock('${id}')" aria-label="Copy code">Copy</button></div><pre class="code-block" id="${id}"><code>${esc(code)}</code></pre></div>`);
  });

  // 2. Extract inline images and links before escaping
  h = h.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
    const safeSrc = /^(https?:\/\/|data:image\/)/.test(src) ? src : '#';
    return ph(`<img src="${safeSrc}" alt="${esc(alt)}" class="inline-chat-img" onclick="openLightbox(this.src)" />`);
  });
  h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
    const safeUrl = sanitizeUrl(url);
    return ph(`<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="md-link">${esc(text)}</a>`);
  });

  // 3. Escape HTML
  h = esc(h);

  // 4. Inline formatting
  h = h.replace(/`([^`]+)`/g, (_, c) => ph(`<code class="inline-code">${c}</code>`));
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/\*(.+?)\*/g, '<em>$1</em>');
  h = h.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // 5. Horizontal rules
  h = h.replace(/^(-{3,}|\*{3,}|_{3,})$/gm, '<hr style="border:none;border-top:1px solid var(--border);margin:12px 0">');

  // 6. Headers
  h = h.replace(/^#### (.+)$/gm, '<h5 class="md-h" style="font-size:.82rem">$1</h5>');
  h = h.replace(/^### (.+)$/gm, '<h4 class="md-h">$1</h4>');
  h = h.replace(/^## (.+)$/gm, '<h3 class="md-h">$1</h3>');
  h = h.replace(/^# (.+)$/gm, '<h2 class="md-h">$1</h2>');

  // 7. Blockquotes
  h = h.replace(/^&gt; (.+)$/gm, '<blockquote style="border-left:3px solid var(--accent-dim);padding-left:12px;margin:8px 0;color:var(--muted)">$1</blockquote>');

  // 8. Tables
  h = h.replace(/^(\|.+\|)\n(\|[-| :]+\|)\n((?:\|.+\|\n?)+)/gm, (_, header, sep, body) => {
    const heads = header.split('|').filter(c => c.trim()).map(c => `<th style="padding:6px 10px;border-bottom:2px solid var(--border);text-align:left;font-size:.78rem">${c.trim()}</th>`).join('');
    const rows = body.trim().split('\n').map(row => {
      const cells = row.split('|').filter(c => c.trim()).map(c => `<td style="padding:5px 10px;border-bottom:1px solid var(--border);font-size:.78rem">${c.trim()}</td>`).join('');
      return `<tr>${cells}</tr>`;
    }).join('');
    return ph(`<table style="border-collapse:collapse;margin:8px 0;width:100%;font-family:var(--mono)"><thead><tr>${heads}</tr></thead><tbody>${rows}</tbody></table>`);
  });

  // 9. Lists — process line by line for proper grouping
  const lines = h.split('\n');
  const result = [];
  let inUl = false, inOl = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ulMatch = line.match(/^(\s*)[-*] (.+)$/);
    const olMatch = line.match(/^(\s*)\d+\. (.+)$/);

    // Detect "1. **Bold header**" pattern — render as section header, not list item
    if (olMatch && olMatch[2].match(/^<strong>.+<\/strong>$/) && olMatch[1] === '') {
      if (inUl) { result.push('</ul>'); inUl = false; }
      if (inOl) { result.push('</ol>'); inOl = false; }
      result.push(`<h4 class="md-h" style="font-size:.88rem;margin-top:14px">${olMatch[2]}</h4>`);
    } else if (ulMatch) {
      if (!inUl) { if (inOl) { result.push('</ol>'); inOl = false; } result.push('<ul style="margin:4px 0;padding-left:20px">'); inUl = true; }
      result.push(`<li>${ulMatch[2]}</li>`);
    } else if (olMatch) {
      if (!inOl) { if (inUl) { result.push('</ul>'); inUl = false; } result.push('<ol style="margin:4px 0;padding-left:20px">'); inOl = true; }
      result.push(`<li>${olMatch[2]}</li>`);
    } else {
      if (inUl) { result.push('</ul>'); inUl = false; }
      if (inOl) { result.push('</ol>'); inOl = false; }
      result.push(line);
    }
  }
  if (inUl) result.push('</ul>');
  if (inOl) result.push('</ol>');
  h = result.join('\n');

  // 10. Auto-link bare URLs
  h = h.replace(/(https?:\/\/[^\s<"']+\.(?:png|jpg|jpeg|gif|webp|svg))(\s|$)/gi, (_, url, after) => {
    return ph(`<img src="${sanitizeUrl(url)}" alt="image" class="inline-chat-img" onclick="openLightbox(this.src)" />`) + after;
  });
  h = h.replace(/(https?:\/\/[^\s<"'\x00]+)/g, (match) => {
    return ph(`<a href="${sanitizeUrl(match)}" target="_blank" rel="noopener noreferrer" class="md-link">${match}</a>`);
  });

  // 11. Paragraphs — double newlines become paragraph breaks, single become <br>
  h = h.replace(/\n{2,}/g, '</p><p>');
  h = h.replace(/\n/g, '<br>');
  h = '<p>' + h + '</p>';
  // Clean up empty paragraphs and paragraphs wrapping block elements
  h = h.replace(/<p><\/p>/g, '');
  h = h.replace(/<p>(<(?:h[2-5]|ul|ol|table|div|blockquote|hr|pre))/g, '$1');
  h = h.replace(/(<\/(?:h[2-5]|ul|ol|table|div|blockquote|hr|pre)>)<\/p>/g, '$1');

  // 12. Restore placeholders
  for (let i = 0; i < placeholders.length; i++) {
    h = h.replace('\x00PH' + i + '\x00', placeholders[i]);
  }

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
