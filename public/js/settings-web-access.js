// ── Settings: Web access (the egress mode and the allowed-sites list) ──
//
// The one policy every outbound path applies: web_fetch, http_request, the
// browser tool, and the caged shell's egress proxy all read the same mode and
// list. Permissive (the default) lets the agent reach any public site; strict,
// the user's opt-in, asks before each site not on the list. Loopback and
// private addresses have their own rules either way. Persists through
// /api/security/egress; a change is broadcast so every open tab redraws.
//
// External deps (runtime globals): apiFetch (shared-api.js), esc (shared.js).

const EGRESS_HINTS = {
  strict: 'The agent asks before it reaches a site that is not listed below: the call stops with an "Allow & retry" notice in the chat, so the list grows as you approve sites. Turned on with no list yet, the list starts with the search providers, so web search keeps working.',
  permissive: 'The agent may reach any public site. Private addresses, cloud metadata and loopback stay guarded, what leaves is still checked for secrets and for private content headed somewhere you did not choose, and the allowed-sites list only marks sites that may receive secret-bearing requests. Choose "Ask before each new site" to approve every site yourself.'
};

function renderWebAccess(s) {
  if (!s) return;
  const sel = document.getElementById('cfg-egress-mode');
  if (sel) sel.value = s.mode === 'strict' ? 'strict' : 'permissive';
  const hint = document.getElementById('egress-mode-hint');
  if (hint) hint.textContent = EGRESS_HINTS[s.mode] || EGRESS_HINTS.permissive;
  const list = document.getElementById('egress-allowlist');
  if (!list) return;
  list.textContent = '';
  const hosts = Array.isArray(s.allowlist) ? s.allowlist : [];
  if (hosts.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'field-hint';
    empty.textContent = s.mode === 'strict'
      ? 'No sites allowed yet. The agent will ask, one site at a time, as it needs them.'
      : 'No sites listed.';
    list.appendChild(empty);
    return;
  }
  for (const host of hosts) {
    const chip = document.createElement('span');
    chip.className = 'tool-chip egress-host';
    chip.style.cssText = 'display:inline-flex;align-items:center;gap:.4rem;margin:0 .4rem .4rem 0;padding:.2rem .5rem;border:1px solid var(--border);border-radius:.4rem;font-size:.8rem';
    const label = document.createElement('span');
    label.textContent = host;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'chip-action';
    remove.title = 'Remove ' + host;
    remove.setAttribute('aria-label', 'Remove ' + host);
    remove.textContent = '×';
    remove.style.cssText = 'border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;padding:0 .1rem';
    remove.addEventListener('click', () => removeEgressHostUI(host));
    chip.appendChild(label);
    chip.appendChild(remove);
    list.appendChild(chip);
  }
}

function showWebAccessError(text) {
  const el = document.getElementById('egress-allow-error');
  if (el) el.textContent = text || '';
}

async function postWebAccess(body) {
  showWebAccessError('');
  try {
    const r = await apiFetch('/api/security/egress', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { showWebAccessError(d.error || 'The change was not saved.'); return null; }
    renderWebAccess(d);
    return d;
  } catch (e) {
    console.warn('[web-access] update failed', e);
    showWebAccessError('The change was not saved.');
    return null;
  }
}

function setEgressModeUI(mode) { return postWebAccess({ mode }); }

async function allowEgressHostUI() {
  const input = document.getElementById('egress-allow-input');
  const host = input ? input.value.trim() : '';
  if (!host) return;
  const d = await postWebAccess({ allow: host });
  if (d && input) input.value = '';
}

function removeEgressHostUI(host) { return postWebAccess({ remove: host }); }

async function loadWebAccess() {
  try {
    const r = await apiFetch('/api/security/egress');
    if (!r.ok) return;
    renderWebAccess(await r.json());
  } catch (e) { console.warn('[web-access] load failed', e); }
}

document.addEventListener('DOMContentLoaded', loadWebAccess);
