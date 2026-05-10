// ── Settings: Onboarding Wizard ──
//
// First-run wizard: provider pick → connect (OAuth or API key) → voice
// preference → done. Server-side `onboarded` flag in settings.json + a
// localStorage `sax_onboarded` mirror so port changes don't re-trigger.
//
// Extracted from settings.js as part of the 400-LOC god-file split.
//
// External deps:
//   apiFetch, apiPost   (shared.js)
//   newChat             (app.js)

let _onboardStep = 0;
let _onboardProvider = '';
const ONBOARD_TOTAL = 5;

async function shouldShowOnboarding() {
  if (localStorage.getItem('sax_onboarded')) return false;
  try {
    const r = await apiFetch('/api/settings');
    const s = await r.json();
    if (s.onboarded) { localStorage.setItem('sax_onboarded', '1'); return false; }
    // If any provider is already configured, treat the user as onboarded.
    const p = await apiFetch('/api/providers');
    const d = await p.json();
    if (d.providers && d.providers.length > 0) {
      localStorage.setItem('sax_onboarded', '1');
      apiFetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ onboarded: true }) }).catch(() => {});
      return false;
    }
  } catch {}
  return true;
}

function showOnboarding() {
  const overlay = document.createElement('div');
  overlay.id = 'onboarding-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'Welcome wizard');
  overlay.innerHTML = `
    <div id="onboarding-modal">
      <div id="onboarding-steps">
        <div class="onboarding-step active" data-step="0">
          <h2 class="onboarding-title">Welcome to Local Agent X</h2>
          <p class="onboarding-desc">Your personal AI agent that runs locally. Let's get you set up in 3 quick steps.</p>
          <div class="onboarding-art">&#9889;</div>
        </div>
        <div class="onboarding-step" data-step="1">
          <h2 class="onboarding-title">Choose Your AI Provider</h2>
          <p class="onboarding-desc">Select which AI model to use. You can change this later in Settings.</p>
          <div class="onboarding-options">
            <button class="onboarding-option" onclick="selectOnboardProvider('xai')"><strong>xAI Grok</strong><br><span style="color:var(--muted);font-size:.72rem">API key required</span></button>
            <button class="onboarding-option" onclick="selectOnboardProvider('gemini')"><strong>Google Gemini</strong><br><span style="color:var(--muted);font-size:.72rem">API key from ai.google.dev</span></button>
            <button class="onboarding-option" onclick="selectOnboardProvider('codex')"><strong>OpenAI Codex</strong><br><span style="color:var(--muted);font-size:.72rem">Free with ChatGPT</span></button>
            <button class="onboarding-option" onclick="selectOnboardProvider('anthropic')"><strong>Anthropic Claude</strong><br><span style="color:var(--muted);font-size:.72rem">Subscription auth</span></button>
            <button class="onboarding-option" onclick="selectOnboardProvider('local')"><strong>Local (Ollama)</strong><br><span style="color:var(--muted);font-size:.72rem">Runs on your GPU</span></button>
            <button class="onboarding-option" onclick="selectOnboardProvider('custom')" style="opacity:.7"><strong>Custom Provider</strong><br><span style="color:var(--muted);font-size:.72rem">Any OpenAI-compatible API</span></button>
          </div>
        </div>
        <div class="onboarding-step" data-step="2">
          <h2 class="onboarding-title">Connect Your Account</h2>
          <p class="onboarding-desc" id="ob-connect-desc">Sign in or enter your API key to start chatting.</p>
          <div id="ob-connect-content" style="display:flex;flex-direction:column;align-items:center;gap:12px;margin-top:12px">
            <!-- Populated dynamically based on provider selection -->
          </div>
          <p id="ob-connect-status" style="color:var(--accent);font-size:.8rem;margin-top:8px;text-align:center"></p>
        </div>
        <div class="onboarding-step" data-step="3">
          <h2 class="onboarding-title">Voice Settings</h2>
          <p class="onboarding-desc">Agent X supports hands-free voice chat. Enable it now or later.</p>
          <div class="onboarding-options">
            <button class="onboarding-option" onclick="selectOnboardVoice(true)"><strong>Enable Voice</strong><br><span style="color:var(--muted);font-size:.72rem">Mic + TTS</span></button>
            <button class="onboarding-option" onclick="selectOnboardVoice(false)"><strong>Text Only</strong><br><span style="color:var(--muted);font-size:.72rem">Keyboard input</span></button>
          </div>
        </div>
        <div class="onboarding-step" data-step="4">
          <h2 class="onboarding-title">You're All Set!</h2>
          <p class="onboarding-desc">Start chatting with your agent. Use Ctrl+K anytime to open the command palette.</p>
          <div class="onboarding-art" style="font-size:2.5rem">&#128640;</div>
        </div>
      </div>
      <div class="onboarding-nav">
        <button class="action-btn secondary" id="ob-back" onclick="onboardStep(-1)" style="visibility:hidden">Back</button>
        <div class="onboarding-dots" id="ob-dots"></div>
        <button class="action-btn primary" id="ob-next" onclick="onboardStep(1)">Get Started</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  updateOnboardingUI();
}

function onboardStep(dir) {
  _onboardStep += dir;
  if (_onboardStep >= ONBOARD_TOTAL) { finishOnboarding(); return; }
  if (_onboardStep < 0) _onboardStep = 0;
  updateOnboardingUI();
}

function updateOnboardingUI() {
  document.querySelectorAll('.onboarding-step').forEach(el => {
    el.classList.toggle('active', parseInt(el.dataset.step) === _onboardStep);
  });
  const back = document.getElementById('ob-back');
  const next = document.getElementById('ob-next');
  const dots = document.getElementById('ob-dots');
  if (back) back.style.visibility = _onboardStep > 0 ? 'visible' : 'hidden';
  if (next) next.textContent = _onboardStep === ONBOARD_TOTAL - 1 ? 'Start Chatting' : (_onboardStep === 0 ? 'Get Started' : 'Next');
  if (dots) dots.innerHTML = Array.from({ length: ONBOARD_TOTAL }, (_, i) => `<span class="ob-dot${i === _onboardStep ? ' active' : ''}"></span>`).join('');

  if (_onboardStep === 2) populateConnectStep();
}

function populateConnectStep() {
  const container = document.getElementById('ob-connect-content');
  const desc = document.getElementById('ob-connect-desc');
  const status = document.getElementById('ob-connect-status');
  if (!container) return;

  if (_onboardProvider === 'codex') {
    desc.textContent = 'Sign in with your OpenAI account to use GPT models for free.';
    container.innerHTML = `
      <button class="action-btn primary" onclick="onboardOAuth('openai')" style="padding:10px 32px;font-size:1rem">Sign In with OpenAI</button>
      <span style="color:var(--muted);font-size:.75rem">Requires a ChatGPT account (free tier works)</span>
    `;
  } else if (_onboardProvider === 'anthropic') {
    desc.textContent = 'Sign in with your Anthropic account to use Claude models. Anthropic may require Extra Usage for external-tool traffic.';
    container.innerHTML = `
      <button class="action-btn primary" onclick="onboardOAuth('anthropic')" style="padding:10px 32px;font-size:1rem">Sign In with Claude</button>
      <span style="color:var(--muted);font-size:.75rem">Subscription auth; Anthropic may require Extra Usage</span>
    `;
  } else if (_onboardProvider === 'xai') {
    desc.textContent = 'Enter your xAI API key to use Grok models.';
    container.innerHTML = `
      <input type="password" id="ob-api-key" placeholder="xai-..." style="width:100%;max-width:360px;padding:10px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:.9rem">
      <button class="action-btn primary" onclick="onboardSaveKey('xai','XAI_API_KEY')" style="padding:8px 24px">Save Key</button>
      <span style="color:var(--muted);font-size:.75rem">Get your key at console.x.ai</span>
    `;
  } else if (_onboardProvider === 'openai') {
    desc.textContent = 'Enter your OpenAI API key.';
    container.innerHTML = `
      <input type="password" id="ob-api-key" placeholder="sk-..." style="width:100%;max-width:360px;padding:10px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:.9rem">
      <button class="action-btn primary" onclick="onboardSaveKey('openai','OPENAI_API_KEY')" style="padding:8px 24px">Save Key</button>
      <span style="color:var(--muted);font-size:.75rem">Get your key at platform.openai.com/api-keys</span>
    `;
  } else if (_onboardProvider === 'local') {
    desc.textContent = 'Make sure Ollama is running on your machine.';
    container.innerHTML = `
      <span style="color:var(--muted);font-size:.85rem">Ollama should be running at localhost:11434</span>
      <button class="action-btn secondary" onclick="onboardCheckOllama()" style="padding:8px 24px">Check Connection</button>
    `;
  } else {
    desc.textContent = 'Go back and select a provider first.';
    container.innerHTML = '';
  }
  if (status) status.textContent = '';
}

async function onboardOAuth(type) {
  const status = document.getElementById('ob-connect-status');
  try {
    const endpoint = type === 'anthropic' ? '/api/auth/anthropic/login' : '/api/auth/login';
    const res = await apiPost(endpoint, {});
    if (res.authUrl) {
      window.open(res.authUrl, '_blank', 'width=600,height=700');
      if (status) status.textContent = 'Sign-in window opened — complete login there, then click Next.';
    } else if (res.error) {
      if (status) status.textContent = 'Error: ' + res.error;
    }
  } catch (e) {
    if (status) status.textContent = 'Failed to start sign-in. Try again or set up in Settings later.';
  }
}

async function onboardSaveKey(provider, secretName) {
  const input = document.getElementById('ob-api-key');
  const status = document.getElementById('ob-connect-status');
  if (!input || !input.value.trim()) {
    if (status) status.textContent = 'Please enter your API key.';
    return;
  }
  try {
    await apiPost('/api/secrets', { name: secretName, value: input.value.trim() });
    if (status) { status.style.color = 'var(--accent)'; status.textContent = 'Key saved securely! Click Next to continue.'; }
    input.value = '';
    input.placeholder = '••••••••  (saved)';
  } catch (e) {
    if (status) status.textContent = 'Failed to save key. Try again.';
  }
}

async function onboardCheckOllama() {
  const status = document.getElementById('ob-connect-status');
  try {
    const res = await fetch('/api/models/local');
    const data = await res.json();
    if (data && data.length > 0) {
      if (status) { status.style.color = 'var(--accent)'; status.textContent = 'Ollama connected! Found ' + data.length + ' model(s).'; }
    } else {
      if (status) status.textContent = 'Ollama is running but no models found. Run: ollama pull llama3';
    }
  } catch (e) {
    if (status) status.textContent = 'Could not connect to Ollama. Make sure it is running.';
  }
}

function selectOnboardProvider(provider) {
  _onboardProvider = provider;
  document.querySelectorAll('.onboarding-option').forEach(b => b.classList.remove('selected'));
  event.currentTarget.classList.add('selected');
}

function selectOnboardVoice(enabled) {
  document.querySelectorAll('[data-step="3"] .onboarding-option').forEach(b => b.classList.remove('selected'));
  event.currentTarget.classList.add('selected');
}

function finishOnboarding() {
  localStorage.setItem('sax_onboarded', '1');
  // Also save server-side so it survives port changes.
  apiFetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ onboarded: true }) }).catch(() => {});
  if (_onboardProvider) {
    const defaults = { codex: 'gpt-5.3-codex', anthropic: 'claude-sonnet-4-6', xai: 'grok-3-mini', gemini: 'gemini-2.0-flash', local: '', custom: '' };
    const s = JSON.parse(localStorage.getItem('sax_settings') || '{}');
    s.provider = _onboardProvider;
    if (defaults[_onboardProvider]) s.model = defaults[_onboardProvider];
    localStorage.setItem('sax_settings', JSON.stringify(s));
    apiPost('/api/settings', { provider: s.provider, model: s.model }).catch(() => {});
  }
  const overlay = document.getElementById('onboarding-overlay');
  if (overlay) overlay.remove();
  newChat();
}
