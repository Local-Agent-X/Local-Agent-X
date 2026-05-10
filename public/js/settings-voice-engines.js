// ── Settings: Voice Engines (sidecar setup / install / start / stop) ──
//
// Per-tier voice engine cards (Kokoro Lite / Chatterbox Studio / Realtime),
// install (download model weights), start/stop the local sidecar process.
// Status fetched from /api/voices/tier.

// ── Voice Engines (setup, install, start/stop) ──

async function refreshVoiceSetup() {
  const statusEl = document.getElementById('voice-setup-status');
  const tiersEl = document.getElementById('voice-setup-tiers');
  if (!tiersEl) return;
  if (statusEl) statusEl.textContent = 'Probing tiers…';
  try {
    const d = await apiJson('/api/voices/setup/status');
    if (statusEl) statusEl.textContent = `Platform: ${d.platform}. Each tier installs to its own venv (~/.lax/) and runs on its own port.`;
    tiersEl.innerHTML = (d.tiers || []).map(renderVoiceTierCard).join('');
  } catch (e) {
    if (statusEl) { statusEl.style.color = 'var(--err,#c33)'; statusEl.textContent = 'Failed to load voice setup: ' + (e.message || e); }
  }
}

function renderVoiceTierCard(t) {
  const dot = (color) => `<span class="status-dot" style="background:${color};display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px"></span>`;
  const isNative = t.kind === 'native';
  let badge;
  if (isNative) {
    if (t.healthy) badge = `<span style="color:var(--accent)">${dot('var(--accent)')}Ready</span>`;
    else if (t.installed) badge = `<span style="color:#dba917">${dot('#dba917')}Model not yet downloaded</span>`;
    else badge = `<span style="color:var(--err,#c33)">${dot('var(--err,#c33)')}Dependencies missing</span>`;
  } else if (t.healthy) badge = `<span style="color:var(--accent)">${dot('var(--accent)')}Running &amp; healthy${t.pid ? ` (pid ${t.pid})` : ''}</span>`;
  else if (t.running) badge = `<span style="color:#dba917">${dot('#dba917')}Running, not ready yet</span>`;
  else if (t.installed) badge = `<span style="color:var(--muted)">${dot('var(--muted)')}Installed, not running</span>`;
  else badge = `<span style="color:var(--err,#c33)">${dot('var(--err,#c33)')}Not installed</span>`;

  const buttons = [];
  if (!isNative) {
    if (!t.installed && t.hasInstaller) buttons.push(`<button class="action-btn primary" onclick="installVoiceTier('${t.id}', this)">Install (${esc(t.diskFootprint || 'sized')})</button>`);
    if (!t.installed && !t.hasInstaller) buttons.push(`<button class="action-btn" disabled title="No one-click installer for this tier">Install via training pipeline</button>`);
    if (t.installed && !t.healthy) buttons.push(`<button class="action-btn primary" onclick="startVoiceTier('${t.id}', this)">Start sidecar</button>`);
    if (t.running || t.healthy) buttons.push(`<button class="action-btn danger" onclick="stopVoiceTier('${t.id}', this)">Stop</button>`);
  }

  let nativeNote = '';
  if (isNative) {
    if (!t.installed) {
      nativeNote = `<div style="font-size:.7rem;color:var(--muted);margin-top:6px">Run <code>npm install kokoro-js onnxruntime-node</code> in the repo root, then reload.</div>`;
    } else if (!t.healthy) {
      nativeNote = `<div style="font-size:.7rem;color:var(--muted);margin-top:6px">Will download on first use, ~80 MB. Set <code>LAX_VOICE_GPU=0 LAX_VOICE_TIER=4</code> and start a voice session.</div>`;
    } else {
      const hp = t.healthPayload || {};
      nativeNote = `<div style="font-size:.7rem;color:var(--muted);margin-top:6px">Voice: <code>${esc(hp.defaultVoice || '')}</code> · Device: <code>${esc(hp.defaultDevice || '')}</code> · Model cached locally.</div>`;
    }
  }

  const portLabel = t.port ? `<span style="font-family:var(--mono);font-size:.7rem;color:var(--muted);font-weight:normal">:${t.port}</span>` : '';

  return `
    <div class="section-card" style="margin-bottom:10px;padding:10px 12px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <div>
          <div style="font-weight:600">${esc(t.label)} ${portLabel}</div>
          <div style="font-size:.72rem;color:var(--muted);margin-top:2px">${esc(t.description)}</div>
          ${nativeNote}
        </div>
        <div style="text-align:right;font-size:.72rem">${badge}</div>
      </div>
      <div id="voice-tier-output-${t.id}" style="display:none;margin-top:8px;font-family:var(--mono);font-size:.65rem;color:var(--muted);background:var(--bg);padding:6px 8px;border-radius:4px;max-height:140px;overflow:auto;white-space:pre-wrap"></div>
      ${buttons.length ? `<div class="btn-row" style="margin-top:8px">${buttons.join('')}</div>` : ''}
    </div>
  `;
}

async function installVoiceTier(id, btn) {
  const outEl = document.getElementById('voice-tier-output-' + id);
  if (btn) { btn.disabled = true; btn.textContent = 'Installing… (this may take 5–15 minutes)'; }
  if (outEl) { outEl.style.display = ''; outEl.textContent = 'Running installer…'; }
  try {
    const d = await apiPost('/api/voices/setup/install', { tier: id });
    if (outEl) outEl.textContent = (d.output || '').trim() || (d.ok ? 'Installed.' : 'Failed.');
    if (!d.ok) throw new Error('Installer exited with code ' + d.exitCode);
  } catch (e) {
    if (outEl) outEl.textContent = (outEl.textContent ? outEl.textContent + '\n' : '') + 'Error: ' + (e.message || e);
  } finally {
    refreshVoiceSetup();
  }
}

async function startVoiceTier(id, btn) {
  const outEl = document.getElementById('voice-tier-output-' + id);
  if (btn) { btn.disabled = true; btn.textContent = 'Starting…'; }
  if (outEl) { outEl.style.display = ''; outEl.textContent = 'Spawning sidecar, waiting for /healthz (up to 60s)…'; }
  try {
    const d = await apiPost('/api/voices/setup/start', { tier: id });
    if (outEl) outEl.textContent = d.already ? 'Already running.' : ('Started, pid ' + (d.pid || '?') + '. Health: ' + JSON.stringify(d.healthPayload || {}));
  } catch (e) {
    if (outEl) outEl.textContent = (outEl.textContent ? outEl.textContent + '\n' : '') + 'Error: ' + (e.message || e);
  } finally {
    refreshVoiceSetup();
  }
}

async function stopVoiceTier(id, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Stopping…'; }
  try { await apiPost('/api/voices/setup/stop', { tier: id }); } catch {}
  refreshVoiceSetup();
}

