// ── Settings: Embedding provider ──
//
// Picks the embedding provider (Ollama / OpenAI / etc.) for semantic search,
// and surfaces whether semantic memory is actually WORKING — plus a one-click
// repair when it isn't.
//
// The install can now finish with optional components degraded (an Ollama that
// wouldn't install no longer aborts it — see scripts/install-common.mjs), so
// "installed" and "working" genuinely diverge. Without this the shortfall was
// invisible: it lived in installer scrollback the user had already closed and
// in server logs they'll never read, while memory silently ran keyword-only.

// Status is scoped to THIS settings surface on purpose. A global setup
// checklist was deliberately deleted (see public/js/notifications.js) because
// pre-checked stale state misled users about what was actually connected —
// don't rebuild it. Server is authoritative; there's no localStorage cache.
async function renderSetupStatus() {
  const host = document.getElementById('cfg-emb-status');
  if (!host) return;
  let data;
  try {
    data = await apiJson('/api/setup/status');
  } catch {
    // Unreachable status endpoint is NOT evidence of a problem. Render nothing
    // rather than a scary banner driven by a transient fetch failure.
    host.innerHTML = '';
    return;
  }
  if (!data || data.ok !== true) { host.innerHTML = ''; return; }

  if (data.ready) {
    host.innerHTML = _embPill('Semantic memory connected', 'ok');
    return;
  }
  host.innerHTML = (data.components || []).map(function(c) {
    var btn = c.action === 'reinit-embeddings'
      ? '<button class="action-btn primary" id="cfg-emb-repair" onclick="onRepairEmbeddings(this)" style="font-size:.7rem;padding:4px 10px">Reconnect</button>'
      : '';
    return '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:8px 0;border-top:1px solid var(--border)">'
      + '<div style="font-size:.78rem">' + _embPill(esc(c.label) + ' unavailable', 'warn')
      + '<div style="color:var(--muted);font-size:.7rem;margin-top:3px">' + esc(c.impact) + ' ' + esc(c.reason) + '</div></div>'
      + '<div style="display:flex;align-items:center;gap:8px;flex-shrink:0">' + btn + '</div></div>';
  }).join('');
}
window.renderSetupStatus = renderSetupStatus;

function _embPill(text, kind) {
  var colors = { ok: 'var(--accent)', warn: '#dba917', muted: 'var(--muted)' };
  var c = colors[kind] || colors.muted;
  return '<span style="display:inline-flex;align-items:center;gap:5px;font-size:.72rem">'
    + '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:' + c + '"></span>'
    + esc(text) + '</span>';
}

// Repair = re-run the embedding provider init. The server already pulls the
// model itself when Ollama is reachable, so this covers the common case (user
// installed Ollama after the app) without the app shipping its own installer.
// Ollama genuinely absent stays a manual step — we surface `manual` for that
// rather than pretending to fix it.
async function onRepairEmbeddings(btn) {
  if (!btn) return;
  var original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Reconnecting…';
  try {
    // Can take ~a minute when it triggers the model pull on a fresh Ollama.
    var r = await apiJson('/api/memory/reinit', { method: 'POST' });
    if (r && r.ok && !r.degraded) {
      await renderSetupStatus(); // re-render from the server's verdict, not ours
      return;
    }
    // Reinit ran but the provider is still degraded — say so honestly and give
    // the manual path instead of leaving a button that looks like it worked.
    btn.textContent = original;
    btn.disabled = false;
    var host = document.getElementById('cfg-emb-status');
    if (host) {
      var note = document.createElement('div');
      note.style.cssText = 'color:var(--muted);font-size:.7rem;margin-top:6px';
      note.textContent = 'Still not connected. Install Ollama from https://ollama.com/download, then try again.';
      host.appendChild(note);
    }
  } catch (e) {
    btn.textContent = original;
    btn.disabled = false;
    var h = document.getElementById('cfg-emb-status');
    if (h) {
      var err = document.createElement('div');
      err.style.cssText = 'color:var(--muted);font-size:.7rem;margin-top:6px';
      err.textContent = 'Reconnect failed: ' + (e && e.message ? e.message : 'unknown error');
      h.appendChild(err);
    }
  }
}
window.onRepairEmbeddings = onRepairEmbeddings;

async function onEmbProviderChange(provider) {
  const hint = document.getElementById('cfg-emb-hint');
  const modelInput = document.getElementById('cfg-emb-model');
  const modelSelect = document.getElementById('cfg-emb-model-select');

  const hints = {
    ollama: 'Select an Ollama model. Run "ollama pull nomic-embed-text" to add embedding models.',
    openai: 'Recommended: text-embedding-3-small ($0.02/M tokens). Needs OPENAI_API_KEY in secrets.',
    gemini: 'Recommended: text-embedding-004. Needs GEMINI_API_KEY in secrets.',
    local: 'Built-in TF-IDF embeddings. No external server needed but lower quality.',
    none: 'Keyword search only. No semantic matching.',
  };
  if (hint) hint.textContent = hints[provider] || '';

  if (provider === 'ollama' && modelSelect) {
    // Show dropdown, hide text input, load Ollama models
    modelSelect.style.display = '';
    if (modelInput) modelInput.style.display = 'none';
    modelSelect.innerHTML = '<option value="">Loading...</option>';
    try {
      // ?include=embeddings — the default endpoint filters embedding-only
      // models out (they can't serve chat). This dropdown specifically
      // wants embedding models, so opt in.
      const data = await apiJson('/api/models/local?include=embeddings');
      const models = (data.models || []).map(function(m) { return m.name; });
      if (models.length === 0) {
        modelSelect.innerHTML = '<option value="">No models found — run ollama pull nomic-embed-text</option>';
        return;
      }
      // Embedding-friendly models get sorted to top
      var embModels = ['nomic-embed-text', 'mxbai-embed-large', 'all-minilm', 'snowflake-arctic-embed', 'bge-large', 'bge-base'];
      var sorted = models.slice().sort(function(a, b) {
        var aEmb = embModels.some(function(e) { return a.includes(e); }) ? 0 : 1;
        var bEmb = embModels.some(function(e) { return b.includes(e); }) ? 0 : 1;
        return aEmb - bEmb || a.localeCompare(b);
      });
      modelSelect.innerHTML = sorted.map(function(m) {
        var isEmb = embModels.some(function(e) { return m.includes(e); });
        var label = isEmb ? m + ' (embedding)' : m;
        return '<option value="' + esc(m) + '">' + esc(label) + '</option>';
      }).join('');
      // Try to select saved or default
      var saved = modelInput ? modelInput.value : '';
      if (saved && sorted.includes(saved)) modelSelect.value = saved;
      else if (sorted.find(function(m) { return m.includes('nomic-embed'); })) modelSelect.value = sorted.find(function(m) { return m.includes('nomic-embed'); });
      // Sync hidden input
      if (modelInput) modelInput.value = modelSelect.value;
      modelSelect.onchange = function() { if (modelInput) modelInput.value = modelSelect.value; };
    } catch {
      modelSelect.innerHTML = '<option value="">Ollama not running</option>';
    }
  } else if (modelSelect) {
    // Non-Ollama: show text input, hide dropdown
    modelSelect.style.display = 'none';
    if (modelInput) modelInput.style.display = '';
    var defaults = { openai: 'text-embedding-3-small', gemini: 'text-embedding-004', local: '', none: '' };
    if (modelInput) modelInput.value = defaults[provider] || '';
  }
}
window.onEmbProviderChange = onEmbProviderChange;

