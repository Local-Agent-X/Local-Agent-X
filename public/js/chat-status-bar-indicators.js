// ── Chat: Status Bar indicators (context bar + clone probes) ──
//
// Sibling to chat-status-bar.js, carrying the read-only/indicator side of the
// bottom bar: the context-usage progress bar above the composer and the
// voice-clone tier/clone probe that feeds the voice picker. Split out of
// chat-status-bar.js as part of the 400-LOC god-file split. Classic browser
// script — these symbols stay top-level globals shared with chat-status-bar.js.
//
// External deps (runtime callbacks, all original-file-or-shared globals; this
// file is safe to load BEFORE chat-status-bar.js because every reference below
// lives inside a function body, never at load time):
//   - apiFetch                            (shared.js)
//   - updateStatusBar                     (chat-status-bar.js — runtime callback)

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

async function refreshClonedVoices() {
  try {
    const tierRes = await apiFetch('/api/voices/tier');
    const tier = await tierRes.json();
    window._voxTierReady = !!(tier.voxcpm && tier.voxcpm.ready);
    window._studioTierReady = !!(tier.chatterbox && tier.chatterbox.ready) || window._voxTierReady;
    // VoxCPM clones (primary zero-shot engine)
    if (window._voxTierReady) {
      const r = await apiFetch('/api/voices/voxcpm');
      if (r.ok) {
        const data = await r.json();
        window._voxcpmVoices = Array.isArray(data?.clones) ? data.clones : [];
      }
    } else {
      window._voxcpmVoices = [];
    }
    // Chatterbox clones (backup zero-shot engine)
    if (tier.chatterbox && tier.chatterbox.ready) {
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
