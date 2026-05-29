// ── Settings: Provider + Model Selection + API Keys + Ollama ──
//
// Per-provider API key field rendering, model dropdown vs free-input
// switching, local Ollama discovery, Ollama Cloud status/connect, and
// the saveSettings/loadSettings flow that ties them all to the server.
// loadToolsList is here because the tools page is rendered next to the
// provider config in the Settings UI.

function loadToolsList() {
  const tools = [
    { name: 'read', status: 'allowed' }, { name: 'write', status: 'allowed' }, { name: 'edit', status: 'allowed' },
    { name: 'bash', status: 'rate-limited' },
    { name: 'web_fetch', status: 'rate-limited' }, { name: 'web_search', status: 'allowed' },
    { name: 'http_request', status: 'rate-limited' }, { name: 'browser', status: 'rate-limited' },
    { name: 'generate_image', status: 'rate-limited' }, { name: 'generate_video', status: 'rate-limited' },
    { name: 'memory_search', status: 'allowed' }, { name: 'memory_save', status: 'allowed' },
    { name: 'memory_get', status: 'allowed' }, { name: 'memory_recall', status: 'allowed' },
    { name: 'memory_reflect', status: 'allowed' }, { name: 'memory_update_profile', status: 'allowed' },
    { name: 'memory_stats', status: 'allowed' }, { name: 'request_secret', status: 'allowed' },
    { name: 'request_secrets', status: 'allowed' },
    { name: 'mission_list', status: 'allowed' }, { name: 'mission_get', status: 'allowed' },
    { name: 'mission_save_preference', status: 'allowed' }, { name: 'mission_format_caption', status: 'allowed' },
    { name: 'cron_list', status: 'allowed' }, { name: 'cron_create', status: 'allowed' },
    { name: 'cron_delete', status: 'allowed' }, { name: 'cron_toggle', status: 'allowed' },
  ];
  const el = document.getElementById('tools-list'); if (!el) return;
  el.innerHTML = tools.map(t => {
    const color = t.status === 'allowed' ? 'var(--accent)' : t.status === 'rate-limited' ? 'var(--warn)' : 'var(--info)';
    return `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)"><span style="color:var(--text)">${t.name}</span><span style="color:${color}">${t.status}</span></div>`;
  }).join('');
}

// ── API Key management per provider ──

const PROVIDER_KEY_CONFIG = {
  xai: { label: 'xAI API Key', placeholder: 'xai-...', hint: 'Get your key at console.x.ai', secretName: 'XAI_API_KEY' },
  gemini: { label: 'Google API Key', placeholder: 'AIza...', hint: 'Get your key at ai.google.dev', secretName: 'GEMINI_API_KEY' },
  cerebras: { label: 'Cerebras API Key', placeholder: 'csk-...', hint: 'Get your key at cloud.cerebras.ai — free tier includes 1M tokens/day', secretName: 'CEREBRAS_API_KEY' },
  openai: { label: 'OpenAI API Key', placeholder: 'sk-...', hint: 'Get your key at platform.openai.com/api-keys', secretName: 'OPENAI_API_KEY' },
  custom: { label: 'API Key', placeholder: 'Enter API key...', hint: 'Key for your custom OpenAI-compatible provider', secretName: 'CUSTOM_API_KEY' },
  'ollama-cloud': { label: 'Ollama Cloud API Key', placeholder: 'ollama-...', hint: 'Get your key at ollama.com — Turbo grants access to large hosted models', secretName: 'OLLAMA_CLOUD_API_KEY' },
};

function updateApiKeyField(provider) {
  const field = document.getElementById('api-key-field');
  const label = document.getElementById('api-key-label');
  const input = document.getElementById('cfg-api-key');
  const hint = document.getElementById('api-key-hint');
  const status = document.getElementById('api-key-status');
  if (!field) return;

  const config = PROVIDER_KEY_CONFIG[provider];
  if (!config) {
    field.style.display = 'none';
    return;
  }

  field.style.display = '';
  if (label) label.textContent = config.label;
  if (input) input.placeholder = config.placeholder;
  if (hint) hint.textContent = config.hint;
  if (status) status.innerHTML = '';

  // Check if key exists in secrets store
  if (input) {
    input.value = '';
    input.dataset.provider = provider;
    apiJson('/api/secrets').then(secrets => {
      const exists = Array.isArray(secrets) && secrets.some(s => s.name === config.secretName);
      if (exists) {
        input.placeholder = '••••••••  (saved — enter new value to replace)';
        if (status) { status.className = 'status-badge ok'; status.innerHTML = '<span class="status-dot"></span> Key saved securely'; }
      }
    }).catch(() => {});
  }
}

function toggleApiKeyVisibility() {
  const input = document.getElementById('cfg-api-key');
  const btn = document.getElementById('btn-toggle-key');
  if (!input) return;
  if (input.type === 'password') { input.type = 'text'; if (btn) btn.textContent = 'Hide'; }
  else { input.type = 'password'; if (btn) btn.textContent = 'Show'; }
}

// ── Provider change → toggle model input vs dropdown ──

const PROVIDER_MODELS = {
  codex: [
    { value: 'gpt-5.5', label: 'GPT-5.5 (1M ctx, $5/$30)' },
    { value: 'gpt-5.4', label: 'GPT-5.4' },
    { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini (default, faster)' },
    { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  ],
  anthropic: [
    { value: 'claude-opus-4-8', label: 'Claude Opus 4.8 (frontier, 1M context)' },
    { value: 'claude-opus-4-7', label: 'Claude Opus 4.7 (1M context)' },
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (faster)' },
    { value: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
    { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (fastest)' },
    { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
    { value: 'claude-opus-4-5', label: 'Claude Opus 4.5' },
  ],
  xai: [
    { value: 'grok-4', label: 'Grok 4 (frontier)' },
    { value: 'grok-4-fast', label: 'Grok 4 Fast (cheap, 2M context)' },
    { value: 'grok-4-heavy', label: 'Grok 4 Heavy (multi-agent, top tier)' },
    { value: 'grok-code-fast-1', label: 'Grok Code Fast 1 (coding)' },
    { value: 'grok-3-mini', label: 'Grok 3 Mini' },
    { value: 'grok-3', label: 'Grok 3' },
  ],
  openai: [
    { value: 'gpt-4o', label: 'GPT-4o (default)' },
    { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
    { value: 'gpt-4.1', label: 'GPT-4.1' },
    { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
    { value: 'o3', label: 'o3' },
    { value: 'o4-mini', label: 'o4-mini' },
  ],
  gemini: [
    { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash (default)' },
    { value: 'gemini-2.5-pro-preview-05-06', label: 'Gemini 2.5 Pro' },
    { value: 'gemini-2.5-flash-preview-05-20', label: 'Gemini 2.5 Flash' },
    { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
  ],
  cerebras: [
    { value: 'gpt-oss-120b', label: 'OpenAI GPT-OSS 120B (default, production)' },
    { value: 'zai-glm-4.7', label: 'Z.ai GLM 4.7 355B (preview)' },
  ],
};

async function onProviderChange(provider, keepModel) {
  const modelInput = document.getElementById('cfg-model');
  const modelSelect = document.getElementById('cfg-model-select');
  const hint = document.getElementById('cfg-model-hint');
  const ollamaStatus = document.getElementById('ollama-status');
  if (!modelInput || !modelSelect) return;

  if (provider === 'local') {
    modelInput.style.display = 'none';
    modelSelect.style.display = '';
    if (ollamaStatus) ollamaStatus.style.display = '';
    if (hint) hint.textContent = 'Showing models downloaded via Ollama. Run "ollama pull <model>" to add more.';
    const cloudCard = document.getElementById('ollama-cloud-card');
    if (cloudCard) cloudCard.style.display = 'none';
    await loadLocalModels();
  } else if (provider === 'ollama-cloud') {
    modelInput.style.display = 'none';
    modelSelect.style.display = '';
    if (ollamaStatus) ollamaStatus.style.display = 'none';
    if (hint) hint.textContent = 'Hosted models served by Ollama Turbo. Connect your account below to populate the list.';
    const cloudCard = document.getElementById('ollama-cloud-card');
    if (cloudCard) cloudCard.style.display = '';
    await loadOllamaCloudModels();
    refreshOllamaCloudStatus();
  } else {
    const cloudCard = document.getElementById('ollama-cloud-card');
    if (cloudCard) cloudCard.style.display = 'none';
    const models = PROVIDER_MODELS[provider] || [];
    if (models.length) {
      modelSelect.style.display = '';
      modelInput.style.display = 'none';
      modelSelect.innerHTML = models.map(m => `<option value="${esc(m.value)}">${esc(m.label)}</option>`).join('') +
        '<option value="__custom__">Custom model...</option>';
      // Restore saved model if it matches, otherwise use default
      if (keepModel) {
        const saved = modelInput.value || modelInput.dataset.saved;
        const match = models.find(m => m.value === saved);
        if (match) modelSelect.value = saved;
        else if (saved && saved !== '__custom__') {
          // Custom model was saved — show it
          modelSelect.value = '__custom__';
          modelInput.style.display = '';
          modelInput.value = saved;
        }
      }
      modelSelect.onchange = () => {
        if (modelSelect.value === '__custom__') {
          modelInput.style.display = '';
          modelInput.value = '';
          modelInput.focus();
        } else {
          modelInput.style.display = 'none';
          modelInput.value = modelSelect.value;
        }
      };
      // Sync hidden input with dropdown
      if (modelSelect.value !== '__custom__') modelInput.value = modelSelect.value;
    } else {
      modelSelect.style.display = 'none';
      modelInput.style.display = '';
    }
    if (ollamaStatus) ollamaStatus.style.display = 'none';
    if (hint) {
      if (provider === 'custom') hint.innerHTML = 'Enter the model name from your provider. <br><label class="field-label" style="margin-top:8px">Base URL</label><input class="field-input" id="cfg-custom-url" placeholder="https://api.example.com/v1" value="" style="margin-top:4px" /><div style="font-size:.6rem;color:var(--muted);margin-top:4px">Any OpenAI-compatible API endpoint (e.g. https://api.deepseek.com/v1)</div>';
      else hint.textContent = '';
    }
  }
  updateApiKeyField(provider);
  // Load custom base URL if saved
  if (provider === 'custom') {
    try { const r = await apiFetch('/api/settings'); const s = await r.json(); const el = document.getElementById('cfg-custom-url'); if (el && s.customBaseUrl) el.value = s.customBaseUrl; } catch {}
  }
}


// Ollama discovery + cloud moved to /js/settings-ollama.js
// Save/load roundtrip moved to /js/settings-save-load.js
