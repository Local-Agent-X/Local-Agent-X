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
