// ── Settings: Local Ollama + Ollama Cloud ──
//
// Local model discovery (curl http://localhost:11434/api/tags), Ollama
// Cloud authentication + model fetch + status pill, plus the helper
// that auto-starts a stopped Ollama daemon. Lives separately from the
// generic provider/key UI because the surface here is Ollama-specific.

async function loadLocalModels() {
  const sel = document.getElementById('cfg-model-select');
  const statusEl = document.getElementById('ollama-status');
  if (!sel) return;
  sel.innerHTML = '<option value="">Loading...</option>';
  try {
    const data = await apiJson('/api/models/local');
    if (data.error) {
      sel.innerHTML = '<option value="">Ollama not reachable</option>';
      if (statusEl) statusEl.innerHTML = `<span class="status-badge err"><span class="status-dot"></span> Not running</span> <button class="btn" onclick="startOllama()" id="btn-start-ollama" style="padding:4px 12px;font-size:.72rem;color:var(--accent);margin-left:8px">Start Ollama</button>`;
      return;
    }
    const models = data.models || [];
    if (models.length === 0) {
      sel.innerHTML = '<option value="">No models found</option>';
      if (statusEl) statusEl.innerHTML = '<span class="status-badge warn"><span class="status-dot"></span> Running — no models</span> <span style="font-size:.7rem;color:var(--muted)">Run <code style="background:var(--bg2);padding:2px 6px;border-radius:4px">ollama pull llama3</code> to download a model</span>';
      return;
    }
    sel.innerHTML = models.map(m => {
      const sizeGB = m.size ? (m.size / 1024 / 1024 / 1024).toFixed(1) + ' GB' : '';
      return `<option value="${esc(m.name)}">${esc(m.name)}${sizeGB ? ' (' + sizeGB + ')' : ''}</option>`;
    }).join('');
    if (statusEl) statusEl.innerHTML = `<span class="status-badge ok"><span class="status-dot"></span> Running — ${models.length} model${models.length > 1 ? 's' : ''} available</span> <button class="btn" onclick="loadLocalModels()" style="padding:4px 10px;font-size:.7rem;margin-left:8px">Refresh</button>`;
    // Restore saved selection
    try {
      const s = JSON.parse(localStorage.getItem('sax_settings') || '{}');
      if (s.model) sel.value = s.model;
    } catch {}
  } catch {
    sel.innerHTML = '<option value="">Ollama not running</option>';
    if (statusEl) statusEl.innerHTML = `<span class="status-badge err"><span class="status-dot"></span> Not running</span> <button class="btn" onclick="startOllama()" id="btn-start-ollama" style="padding:4px 12px;font-size:.72rem;color:var(--accent);margin-left:8px">Start Ollama</button>`;
  }
}

async function loadOllamaCloudModels() {
  const sel = document.getElementById('cfg-model-select');
  if (!sel) return;
  sel.innerHTML = '<option value="">Loading...</option>';
  try {
    const data = await apiJson('/api/providers');
    const cloud = (data.providers || []).find(p => p.id === 'ollama-cloud');
    const models = (cloud && cloud.models) || [];
    if (models.length === 0) {
      sel.innerHTML = '<option value="">Not connected — paste your API key below</option>';
      return;
    }
    sel.innerHTML = models.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
    try {
      const s = JSON.parse(localStorage.getItem('sax_settings') || '{}');
      if (s.model && models.includes(s.model)) sel.value = s.model;
    } catch {}
  } catch {
    sel.innerHTML = '<option value="">Failed to load cloud models</option>';
  }
}

async function refreshOllamaCloudStatus() {
  const statusEl = document.getElementById('ollama-cloud-status');
  if (!statusEl) return;
  try {
    // Hit the test endpoint with the existing secret. Returns ok:false
    // when no key is configured — that surfaces as "Not connected"
    // without spamming a real auth attempt.
    const j = await apiPost('/api/ollama/test-cloud', {});
    if (j && j.ok) {
      statusEl.textContent = `Connected · ${j.modelCount} model${j.modelCount === 1 ? '' : 's'}`;
      statusEl.style.color = 'var(--accent)';
    } else {
      statusEl.textContent = 'Not connected';
      statusEl.style.color = 'var(--muted)';
    }
  } catch {
    statusEl.textContent = 'Not connected';
    statusEl.style.color = 'var(--muted)';
  }
}

async function connectOllamaCloud() {
  const keyInput = document.getElementById('ollama-cloud-key');
  const btn = document.getElementById('btn-ollama-cloud-connect');
  const statusEl = document.getElementById('ollama-cloud-status');
  if (!keyInput || !btn) return;
  const key = keyInput.value.trim();
  if (!key) { if (statusEl) { statusEl.textContent = 'Paste a key first'; statusEl.style.color = 'var(--err, #c66)'; } return; }
  btn.disabled = true;
  btn.textContent = 'Connecting...';
  try {
    await apiPost('/api/secrets', { name: 'OLLAMA_CLOUD_API_KEY', value: key });
    const j = await apiPost('/api/ollama/test-cloud', {});
    if (j && j.ok) {
      if (statusEl) { statusEl.textContent = `Connected · ${j.modelCount} model${j.modelCount === 1 ? '' : 's'}`; statusEl.style.color = 'var(--accent)'; }
      keyInput.value = '';
      // Refresh whichever model dropdown is currently visible. If the
      // user is on the new "Ollama Turbo (cloud)" entry, repopulate
      // its model list. Otherwise (they connected from inside the
      // Local provider's card), refresh local — though that's now a
      // legacy path since the card primarily lives under Turbo.
      const curProvider = document.getElementById('cfg-provider')?.value;
      if (curProvider === 'ollama-cloud') await loadOllamaCloudModels();
      else if (curProvider === 'local') await loadLocalModels();
    } else {
      const errMsg = (j && j.error) || 'unreachable';
      if (statusEl) { statusEl.textContent = `Failed: ${errMsg}`; statusEl.style.color = 'var(--err, #c66)'; }
    }
  } catch (e) {
    if (statusEl) { statusEl.textContent = `Error: ${e?.message || e}`; statusEl.style.color = 'var(--err, #c66)'; }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect';
  }
}

async function startOllama() {
  const btn = document.getElementById('btn-start-ollama');
  if (btn) { btn.textContent = 'Starting...'; btn.disabled = true; }
  try {
    await apiPost('/api/ollama/start', {});
    // Poll until Ollama is reachable
    let attempts = 0;
    const check = setInterval(async () => {
      attempts++;
      try {
        const data = await apiJson('/api/models/local');
        if (!data.error) {
          clearInterval(check);
          await loadLocalModels();
        }
      } catch {}
      if (attempts > 15) { // 15s timeout
        clearInterval(check);
        if (btn) { btn.textContent = 'Start Ollama'; btn.disabled = false; }
      }
    }, 1000);
  } catch {
    if (btn) { btn.textContent = 'Start Ollama'; btn.disabled = false; }
  }
}

