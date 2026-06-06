// ── Media tab voice picker — tier-status + prereq install/start ──
// _checkPrereq decides one of: install-sidecar, start-sidecar, set-secret,
// or none for each prerequisite in the catalog. The tier card renders one
// row per prereq with a pill (ok / warn / muted) and a button bound to
// onTierPrereqAction. STT provider picker is rendered here too because the
// chosen provider injects an extra secret prereq into the same list.
//
// Reads state from voice-picker.js (_setupStatus, _secretNames). The
// rendered HTML's button onclick handlers reference window-globals from
// voice-picker.js (onSttProviderChange) and this file (onTierPrereqAction).

function _checkPrereq(p) {
  // Returns { ok, hint, action }. action is one of: install-sidecar, start-sidecar, install-npm, set-secret, none.
  if (p.kind === 'browser-tts') {
    const ok = typeof window !== 'undefined' && 'speechSynthesis' in window;
    return { ok, hint: ok ? 'Available' : 'Browser does not expose SpeechSynthesis', action: 'none' };
  }
  if (p.kind.startsWith('sidecar:')) {
    const id = p.kind.slice('sidecar:'.length);
    const t = (_setupStatus?.tiers || []).find(x => x.id === id);
    if (!t) return { ok: false, hint: 'Probing…', action: 'none', tierId: id };
    if (t.healthy) return { ok: true, hint: 'Running', action: 'none', tierId: id };
    if (t.installed) return { ok: false, hint: 'Installed, not running', action: 'start-sidecar', tierId: id };
    // Studio-trained partial-state nuance: if the GPT-SoVITS repo + trained
    // weights are on disk but the venv is missing, surface that explicitly
    // so users with a wiped venv know their voices (Optimus etc.) survived
    // and they just need to click Install to rebuild the venv.
    if (id === 'studio-trained' && t.weightsPresent) {
      return { ok: false, hint: 'Weights found — click Install to rebuild venv', action: 'install-sidecar', tierId: id };
    }
    if (id === 'studio-trained' && t.repoPresent) {
      return { ok: false, hint: 'Repo present, no trained voices yet', action: 'install-sidecar', tierId: id };
    }
    return { ok: false, hint: 'Not installed', action: 'install-sidecar', tierId: id };
  }
  if (p.kind.startsWith('secret:')) {
    const name = p.kind.slice('secret:'.length).toUpperCase();
    if (!_secretNames) return { ok: false, hint: 'Probing…', action: 'none', secretName: name };
    const ok = _secretNames.has(name);
    return { ok, hint: ok ? 'Set' : 'Missing', action: ok ? 'none' : 'set-secret', secretName: name };
  }
  if (p.kind.startsWith('npm:')) {
    const pkg = p.kind.slice('npm:'.length);
    const tier4Native = (_setupStatus?.tiers || []).find(x => x.id === 'native');
    if (pkg === 'kokoro-js' || pkg === 'kokoro-js + onnxruntime-node') {
      const ok = !!(tier4Native && tier4Native.installed);
      const cached = !!(tier4Native?.healthPayload?.modelCached);
      return { ok: ok && cached, hint: !ok ? 'Run npm install' : (cached ? 'Ready' : 'Will download on first use'), action: 'none' };
    }
    // Real probe via /api/voices/setup/status `npm` block. Server checks
    // node_modules/<pkg>/package.json existence + parses version. The label
    // for this prereq is usually "msedge-tts npm package" — match by the
    // first whitespace-delimited token so future deps pick up automatically.
    const probed = _setupStatus?.npm || {};
    const pkgKey = pkg.split(/\s+/)[0];
    const info = probed[pkgKey];
    if (info === undefined) {
      // Probe hasn't returned yet, or this package isn't tracked server-side.
      return { ok: false, hint: 'Probing…', action: 'none' };
    }
    if (info.installed) {
      return { ok: true, hint: info.version ? `Installed v${info.version}` : 'Installed', action: 'none' };
    }
    return { ok: false, hint: 'Missing — run npm install', action: 'none' };
  }
  if (p.kind.startsWith('model:')) {
    const tier4Native = (_setupStatus?.tiers || []).find(x => x.id === 'native');
    const cached = !!(tier4Native?.healthPayload?.modelCached);
    return { ok: cached, hint: cached ? 'Cached' : 'Will download on first use', action: 'none' };
  }
  return { ok: true, hint: '', action: 'none' };
}

function _statusPill(text, kind) {
  const colors = { ok: 'var(--accent)', warn: '#dba917', err: 'var(--err,#c33)', muted: 'var(--muted)' };
  const c = colors[kind] || colors.muted;
  return `<span style="display:inline-flex;align-items:center;gap:4px;font-size:.7rem"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${c}"></span>${_esc(text)}</span>`;
}

function _renderPrereqRow(p, idx, tierId) {
  const r = _checkPrereq(p);
  let pill, action = '';
  if (r.ok) pill = _statusPill(r.hint, 'ok');
  else if (r.hint === 'Probing…') pill = _statusPill('Probing…', 'muted');
  else pill = _statusPill(r.hint, p.optional ? 'muted' : 'warn');

  const btnId = `prereq-btn-${tierId}-${idx}`;
  if (r.action === 'install-sidecar') {
    action = `<button class="action-btn primary" id="${btnId}" onclick="onTierPrereqAction('${tierId}','install-sidecar','${_esc(r.tierId)}',this)" style="font-size:.7rem;padding:4px 10px">Install</button>`;
  } else if (r.action === 'start-sidecar') {
    action = `<button class="action-btn primary" id="${btnId}" onclick="onTierPrereqAction('${tierId}','start-sidecar','${_esc(r.tierId)}',this)" style="font-size:.7rem;padding:4px 10px">Start</button>`;
  } else if (r.action === 'set-secret') {
    action = `<button class="action-btn" id="${btnId}" onclick="onTierPrereqAction('${tierId}','set-secret','${_esc(r.secretName)}',this)" style="font-size:.7rem;padding:4px 10px">Add ${_esc(r.secretName)}</button>`;
  }

  return `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 0;border-top:1px solid var(--border)"><div style="font-size:.78rem">${_esc(p.label)}${p.optional ? ' <span style="color:var(--muted);font-size:.7rem">(optional)</span>' : ''}</div><div style="display:flex;align-items:center;gap:8px">${pill}${action}</div></div>`;
}

function _resolveSttProvider(tier) {
  if (!tier?.sttProviders?.length) return null;
  let picked = '';
  try {
    const s = JSON.parse(localStorage.getItem('lax_settings') || '{}');
    picked = String(s.voiceSttProvider || '').toLowerCase();
  } catch {}
  const found = tier.sttProviders.find(p => p.id === picked);
  return found || tier.sttProviders[0];
}

// Populate the dedicated STT provider field (its own labeled .field in the
// card, not buried in the prereq status box). Hidden for tiers that don't
// expose an STT provider choice (Browser, Studio, Realtime).
function _renderSttField(tier) {
  const field = document.getElementById('voice-stt-field');
  const sel = document.getElementById('cfg-voice-stt');
  if (!field || !sel) return;
  if (!tier?.sttProviders?.length) { field.style.display = 'none'; return; }
  field.style.display = '';
  const current = _resolveSttProvider(tier)?.id || tier.sttProviders[0].id;
  sel.innerHTML = tier.sttProviders.map(p =>
    `<option value="${_esc(p.id)}"${p.id === current ? ' selected' : ''}>${_esc(p.label)}</option>`,
  ).join('');
}

async function onSttProviderChange(tierId, providerId) {
  const tier = getTierById(tierId);
  if (!tier?.sttProviders?.length) return;
  const provider = tier.sttProviders.find(p => p.id === providerId);
  if (!provider) return;
  await _persist({ voiceSttProvider: provider.id });
  try {
    const local = JSON.parse(localStorage.getItem('lax_settings') || '{}');
    local.voiceSttProvider = provider.id;
    localStorage.setItem('lax_settings', JSON.stringify(local));
  } catch {}
  // Re-render so the dynamic secret prereq updates to match.
  await _refreshSecretNames();
  _renderTierStatus(tier);
}
window.onSttProviderChange = onSttProviderChange;

function _renderTierStatus(tier) {
  // Tier description lives under the System select as a field hint.
  const detailEl = document.getElementById('voice-tier-detail');
  if (detailEl) detailEl.textContent = tier?.detail || '';
  // STT provider is a real setting — render it as its own labeled field.
  _renderSttField(tier);

  // Build the effective prereqs list. For tiers with sttProviders we
  // synthesize a `secret:` prereq from the user's selected provider so the
  // same row can show "GROQ_API_KEY · Set" or "OPENAI_API_KEY · Missing".
  // Local Whisper has no secret, so no row is added — only push when the
  // chosen provider actually needs a key.
  const provider = _resolveSttProvider(tier);
  const effectivePrereqs = tier.prerequisites.slice();
  if (provider && provider.secret) {
    effectivePrereqs.push({
      kind: `secret:${provider.secret}`,
      label: `${provider.secret} (for STT)`,
    });
  }
  const required = effectivePrereqs.filter(p => !p.optional);
  const allOk = required.every(p => _checkPrereq(p).ok);
  const status = document.getElementById('voice-engine-status');
  if (status) {
    status.className = 'status-badge ' + (allOk ? 'ok' : 'warn');
    status.innerHTML = `<span class="status-dot"></span> ${allOk ? 'Ready: ' : 'Setup needed: '}${_esc(tier.label)}`;
  }

  // Prerequisites panel — diagnostics only, parked at the bottom of the card
  // under a clear header so it reads as status, not configuration.
  const wrap = document.getElementById('voice-tier-status');
  if (!wrap) return;
  if (!effectivePrereqs.length) { wrap.innerHTML = ''; return; }
  const rows = effectivePrereqs.map((p, i) => _renderPrereqRow(p, i, tier.id)).join('');
  wrap.innerHTML = `<div style="margin-top:6px;padding:10px 12px;background:var(--bg);border-radius:8px;border:1px solid var(--border)">`
    + `<div style="font-family:var(--mono);font-size:.62rem;color:var(--muted);letter-spacing:1px;text-transform:uppercase;margin-bottom:2px">Prerequisites</div>`
    + rows
    + `</div>`;
}

async function onTierPrereqAction(tierId, action, target, btn) {
  const tier = getTierById(tierId);
  if (!tier || !btn) return;
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = '…';
  try {
    if (action === 'install-sidecar') {
      btn.textContent = 'Installing… (5–15 min)';
      const d = await apiPost('/api/voices/setup/install', { tier: target });
      if (!d?.ok) {
        // Surface the actual installer output so users see the AV-exclusion
        // hint or whatever else install.ps1 emitted on failure. Generic
        // "exited with code 1" alerts are useless for non-tech users — the
        // installer's stdout has the recovery instructions.
        const tail = (d?.output || '').toString().slice(-1500);
        const isAvLikely = /Defender|antivirus|exclusions|verify|wheel/i.test(tail);
        const lead = d?.exitCode === 2
          ? 'Install verify failed (AV may have deleted a wheel mid-install).'
          : isAvLikely
          ? 'Installer reported a problem likely caused by antivirus.'
          : `Installer exited with code ${d?.exitCode ?? '?'}.`;
        const recovery = isAvLikely || d?.exitCode === 2
          ? '\n\nFix:\n  1. Open Windows Security → Virus & threat protection\n  2. Manage settings → Add or remove exclusions\n  3. Add: %USERPROFILE%\\.lax\n  4. Click Install again.'
          : '';
        alert(lead + recovery + (tail ? '\n\nLast output:\n' + tail : ''));
        throw new Error(lead);
      }
    } else if (action === 'start-sidecar') {
      btn.textContent = 'Starting…';
      const d = await apiPost('/api/voices/setup/start', { tier: target });
      if (!d?.ok && !d?.already) throw new Error(d?.error || 'sidecar did not start');
    } else if (action === 'set-secret') {
      // Defer to existing secrets UI rather than building an inline form.
      if (typeof openSecretsModal === 'function') openSecretsModal();
      else alert(`Add the secret named ${target} from the Security tab → Secrets, then return here.`);
    }
    await _refreshSetupStatus();
    await _refreshSecretNames();
    _renderTierStatus(tier);
  } catch (e) {
    btn.disabled = false; btn.textContent = orig;
    // Don't double-alert when we already surfaced a rich install message above.
    if (action !== 'install-sidecar') alert('Failed: ' + (e?.message || e));
  }
}
window.onTierPrereqAction = onTierPrereqAction;
