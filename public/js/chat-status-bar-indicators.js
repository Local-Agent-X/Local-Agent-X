// ── Chat: Status Bar indicators (context bar + training/clone probes) ──
//
// Sibling to chat-status-bar.js, carrying the read-only/indicator side of the
// bottom bar: the context-usage progress bar above the composer, the persistent
// training-status pill, and the voice-clone tier/clone probe that feeds the
// voice picker. Split out of chat-status-bar.js as part of the 400-LOC god-file
// split. Classic browser script — these symbols stay top-level globals shared
// with chat-status-bar.js.
//
// External deps (runtime callbacks, all original-file-or-shared globals; this
// file is safe to load BEFORE chat-status-bar.js because every reference below
// lives inside a function body, never at load time):
//   - apiFetch                            (shared.js)
//   - updateStatusBar                     (chat-status-bar.js — runtime callback)
//   - openTrainVoiceModal                 (chat-voice-modals.js — pill onclick)

// ── Context usage indicator ──
//
// Two places read the latest status:
//   - this file's `updateContextBar` (the progress bar above the composer)
//   - `updateStatusBar` in chat-status-bar.js (the ✏️ token chip in the bottom bar)
//
// They MUST read the same source of truth. Until this fix they didn't:
// updateContextBar mutated a module-local `lastContextStatus`, while the
// status-bar chip read `window.lastContextStatus` (initialized null in
// chat-uploads.js and never written). Result: the bar was driven only by
// transient updates and the chip was always blank/zero. Mirror to window
// so both paths see fresh data.
function updateContextBar(event) {
  if (event) window.lastContextStatus = event;
  const data = window.lastContextStatus;

  let bar = document.getElementById('context-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'context-bar';
    bar.style.cssText = 'display:none;max-width:800px;margin:0 auto 8px;width:100%;padding:0 14px';
    const inputArea = document.getElementById('input-area');
    if (inputArea) inputArea.insertBefore(bar, inputArea.firstChild);
  }

  // No data yet → hide the bar instead of showing a fake "0K / 128K" reading
  // that users (correctly) interpret as "context is empty." A blank bar is
  // honest about "no measurement yet"; a zeroed bar lies.
  if (!data) {
    bar.style.display = 'none';
    return;
  }

  bar.style.display = 'block';

  // Color based on level
  let color = 'var(--accent)';      // green
  if (data.percentage >= 95) color = 'var(--danger)';
  else if (data.percentage >= 85) color = 'var(--warn)';
  else if (data.percentage >= 70) color = '#88aaff';

  const compactedNote = data.compacted ? ' <span style="color:var(--accent)">(compacted)</span>' : '';
  const tokensK = (data.usedTokens / 1000).toFixed(0);
  const maxK = (data.maxTokens / 1000).toFixed(0);

  bar.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;font-family:var(--mono);font-size:.68rem">
      <div style="flex:1;height:4px;background:var(--border);border-radius:2px;overflow:hidden">
        <div style="height:100%;width:${Math.min(data.percentage, 100)}%;background:${color};border-radius:2px;transition:width .3s"></div>
      </div>
      <span style="color:${color};white-space:nowrap">${data.percentage}% context${compactedNote}</span>
      <span style="color:var(--muted);white-space:nowrap">${tokensK}K / ${maxK}K</span>
    </div>
  `;
}

let _lastTrainingRunCount = 0;
async function pollTrainingStatus() {
  let runs = [];
  try {
    const r = await apiFetch('/api/voices/sovits/training/list');
    if (r.ok) {
      const d = await r.json();
      runs = (d.runs || []).filter(x => x.stage !== 'register');
    }
  } catch { return; }
  // Always refresh the clone list — cheap call (one /tier probe + at most
  // two list calls), and it covers cases the running→idle transition
  // misses (orchestrator died before registering, user added a clone via
  // the manage modal, manual API registration, etc.).
  refreshClonedVoices().then(() => updateStatusBar?.());
  _lastTrainingRunCount = runs.length;

  let pill = document.getElementById('training-pill');
  if (runs.length === 0) {
    if (pill) pill.remove();
    return;
  }
  if (!pill) {
    pill = document.createElement('div');
    pill.id = 'training-pill';
    pill.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:80;padding:6px 14px;border:1px solid #4a9eff;background:rgba(8,18,38,.9);color:#9fdcff;border-radius:18px;font-size:.78rem;font-family:var(--mono,monospace);cursor:pointer;backdrop-filter:blur(6px);box-shadow:0 2px 12px rgba(74,158,255,.3)';
    pill.title = 'Click to open training panel';
    pill.addEventListener('click', () => { if (typeof openTrainVoiceModal === 'function') openTrainVoiceModal(); });
    document.body.appendChild(pill);
  }
  const stageLabels = {
    download: 'downloading', slice: 'slicing', asr: 'transcribing',
    ref: 'picking ref', format: 'extracting features',
    train_sovits: 'training SoVITS', train_gpt: 'training GPT',
  };
  const r0 = runs[0];
  const stage = stageLabels[r0.stage] || r0.stage;
  const more = runs.length > 1 ? ` +${runs.length - 1} more` : '';
  pill.textContent = `🎤 Training ${r0.name} · ${stage}${more}`;
}

async function refreshClonedVoices() {
  try {
    const tierRes = await apiFetch('/api/voices/tier');
    const tier = await tierRes.json();
    window._studioTierReady = !!(tier.chatterbox && tier.chatterbox.ready);
    window._sovitsTierReady = !!(tier.sovits && tier.sovits.ready);
    // SoVITS clones (trained or zero-shot) — best quality when fine-tuned
    if (window._sovitsTierReady) {
      const r = await apiFetch('/api/voices/sovits');
      if (r.ok) {
        const data = await r.json();
        window._sovitsVoices = Array.isArray(data?.clones) ? data.clones : [];
      }
    } else {
      window._sovitsVoices = [];
    }
    // Chatterbox clones (single-stage zero-shot TTS, fallback / parallel)
    if (window._studioTierReady) {
      const r = await apiFetch('/api/voices/chatterbox');
      if (r.ok) {
        const data = await r.json();
        window._chatterboxVoices = Array.isArray(data?.clones) ? data.clones : [];
      }
    } else {
      window._chatterboxVoices = [];
    }
    if (typeof updateStatusBar === 'function') updateStatusBar();
  } catch (e) {
    console.warn('[voice] tier/clones probe failed:', e.message);
  }
}
