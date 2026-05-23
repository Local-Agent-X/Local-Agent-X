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
