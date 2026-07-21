// Settings: Local Runtimes
//
// Discovered runtimes and the manual endpoint registry share the existing
// settings card. Verification is an explicit operator action and only reports
// capability evidence; it never changes model selection or chat routing.

const LOCAL_CERTIFICATION_LABELS = {
  baseline_marker: 'Basic response',
  strict_json_schema: 'Structured JSON',
  required_tool_call: 'Required tool call',
  tool_result_continuation: 'Tool continuation',
  context_degradation: 'Long-context response',
};
const localCertificationInflight = new Map();

function localCertificationBadge(status) {
  if (status === 'verified') return '<span class="status-badge ok" data-lr-cert-badge><span class="status-dot"></span> Verified</span>';
  return '<span class="status-badge" data-lr-cert-badge><span class="status-dot"></span> Not verified</span>';
}

function localRuntimeModelRow(runtime, model, advisories) {
  const runtimeKey = esc(encodeURIComponent(runtime.id));
  const modelKey = esc(encodeURIComponent(model.id));
  const verified = model.certification?.status === 'verified';
  const context = model.contextWindow ? `${Number(model.contextWindow).toLocaleString()} ctx` : 'context unknown';
  const tools = model.tools === true ? 'tools' : model.tools === false ? 'no tools' : 'tools unknown';
  const advisory = advisories.get(model.id);
  const fit = advisory
    ? ` &middot; install-time fit: <span style="color:${advisory.status === 'compatible' ? 'var(--accent)' : advisory.status === 'degraded' ? 'var(--warn, #c99a52)' : 'var(--muted)'}">${esc(advisory.status)}</span>`
    : '';
  return `<div data-lr-model-row style="padding:7px 0;border-top:1px solid var(--border)">
    <div style="display:flex;align-items:center;gap:8px;font-size:.75rem">
      <span style="flex:1;min-width:0;font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(model.id)}">${esc(model.id)}</span>
      <span style="color:var(--muted);font-size:.68rem">${esc(context)} &middot; ${esc(tools)}${fit}</span>
      ${localCertificationBadge(verified ? 'verified' : 'unverified')}
      <button class="btn" data-lr-verify data-lr-runtime="${runtimeKey}" data-lr-model="${modelKey}" style="padding:3px 10px;font-size:.7rem">${verified ? 'Verify again' : 'Verify'}</button>
    </div>
    <div data-lr-cert-result style="display:none;margin-top:6px"></div>
  </div>`;
}

function discoveredRuntimeRow(runtime, advisories) {
  const models = Array.isArray(runtime.models) ? runtime.models : [];
  const runtimeAdvisories = runtime.kind === 'ollama' ? advisories : new Map();
  const modelRows = models.length
    ? models.map((model) => localRuntimeModelRow(runtime, model, runtimeAdvisories)).join('')
    : '<div style="padding:7px 0;color:var(--muted);font-size:.72rem">No models reported.</div>';
  return `<div style="padding:8px 10px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px">
    <div style="display:flex;align-items:center;gap:8px;font-size:.78rem">
      <strong style="color:var(--text)">${esc(runtime.label || runtime.id)}</strong>
      <span style="color:var(--muted);font-family:var(--mono)">${esc(runtime.endpoint?.baseUrl || '')}</span>
      <span class="status-badge ok" style="margin-left:auto"><span class="status-dot"></span> Connected</span>
    </div>
    ${modelRows}
  </div>`;
}

function localHardwareProfileHtml(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return '<div style="font-size:.72rem;color:var(--muted);margin-bottom:10px">No installer hardware evidence is available. Runtime discovery and exact verification still work.</div>';
  const gib = (bytes) => Number.isFinite(bytes) && bytes > 0 ? `${(bytes / (1024 ** 3)).toFixed(1)} GiB` : 'unknown';
  const cpu = profile.cpu?.model || 'CPU model unknown';
  const ram = gib(profile.memory?.totalBytes);
  const devices = Array.isArray(profile.gpu?.devices)
    ? profile.gpu.devices.filter((device) => device && typeof device === 'object' && typeof device.name === 'string')
    : [];
  const gpu = devices.length
    ? devices.map((device) => `${device.name}${device.memoryKind === 'shared' ? ' (shared memory)' : device.memoryBytes ? ` (${gib(device.memoryBytes)} VRAM)` : ' (VRAM unknown)'}`).join(' + ')
    : `GPU ${profile.gpu?.status || 'unknown'}`;
  const runtime = profile.ollama?.status === 'installed'
    ? `Ollama ${profile.ollama.version || 'version unknown'} detected when installer evidence was collected`
    : `Ollama ${profile.ollama?.status || 'unknown'} when installer evidence was collected`;
  return `<div style="padding:8px 10px;border:1px solid var(--border);border-radius:8px;margin-bottom:10px;font-size:.72rem">
    <div style="font-size:.68rem;color:var(--muted);margin-bottom:4px">INSTALL-TIME HARDWARE EVIDENCE &middot; advisory only</div>
    <div>${esc(cpu)} &middot; ${esc(ram)} RAM &middot; ${esc(gpu)} &middot; ${esc(runtime)}</div>
    <div style="color:var(--muted);margin-top:4px">Unknown or unsupported hardware does not block local runtime discovery, chat, or exact verification.</div>
  </div>`;
}

function manualRuntimeRow(entry, discovered) {
  const live = discovered.find((runtime) => runtime.endpoint && runtime.endpoint.baseUrl === entry.baseUrl);
  const status = live
    ? `<span class="status-badge ok"><span class="status-dot"></span> Connected &middot; ${live.models.length} model${live.models.length === 1 ? '' : 's'}</span>`
    : '<span class="status-badge err"><span class="status-dot"></span> Not reachable</span>';
  return `<div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border);font-size:.78rem">
    <span style="min-width:110px;color:var(--muted)">${esc(entry.kind)}</span>
    <span style="flex:1;font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(entry.baseUrl)}">${esc(entry.baseUrl)}${entry.label ? ` <span style="color:var(--muted)">&middot; ${esc(entry.label)}</span>` : ''}</span>
    ${status}
    <button class="btn" data-lr-remove="${esc(entry.baseUrl)}" style="padding:3px 10px;font-size:.7rem;color:var(--err, #c66)">Remove</button>
  </div>`;
}

async function loadLocalRuntimesEditor() {
  const list = document.getElementById('local-runtimes-list');
  if (!list) return;
  if (!list.dataset.wired) {
    list.addEventListener('click', (e) => {
      const removeBtn = e.target.closest('button[data-lr-remove]');
      if (removeBtn) {
        void removeLocalRuntime(removeBtn.getAttribute('data-lr-remove'));
        return;
      }
      const verifyBtn = e.target.closest('button[data-lr-verify]');
      if (verifyBtn) void verifyLocalRuntime(verifyBtn);
    });
    list.dataset.wired = '1';
  }
  try {
    const [data, setup] = await Promise.all([
      apiJson('/api/local-runtimes'),
      apiJson('/api/setup/status').catch(() => ({ hardwareProfile: null })),
    ]);
    const manual = data.manual || [];
    const discovered = data.runtimes || [];
    const profile = setup && typeof setup === 'object' ? setup.hardwareProfile || null : null;
    const advisories = new Map((Array.isArray(profile?.modelAdvisories) ? profile.modelAdvisories : [])
      .filter((item) => item && typeof item === 'object' && typeof item.model === 'string')
      .map((item) => [item.model, item]));
    const discoveredHtml = discovered.length
      ? discovered.map((runtime) => discoveredRuntimeRow(runtime, advisories)).join('')
      : '<div style="font-size:.75rem;color:var(--muted);margin-bottom:10px">No local runtimes discovered yet.</div>';
    const manualHtml = manual.length
      ? manual.map((entry) => manualRuntimeRow(entry, discovered)).join('')
      : '<div style="font-size:.75rem;color:var(--muted)">No manual runtimes yet. Loopback servers on known ports are found automatically.</div>';
    list.innerHTML = `${localHardwareProfileHtml(profile)}<div style="font-size:.68rem;color:var(--muted);margin-bottom:6px">DISCOVERED</div>${discoveredHtml}
      <div style="font-size:.68rem;color:var(--muted);margin:12px 0 4px">MANUAL ENDPOINTS</div>${manualHtml}`;
  } catch {
    list.innerHTML = '<div style="font-size:.75rem;color:var(--err, #c66)">Failed to load runtimes.</div>';
  }
}

function localCertificationResultHtml(result) {
  const scenarios = Array.isArray(result.scenarios) ? result.scenarios : [];
  const rows = scenarios.map((scenario) => {
    const label = LOCAL_CERTIFICATION_LABELS[scenario.id] || scenario.id;
    const detail = scenario.passed ? 'Passed' : (scenario.failure || 'Failed');
    const color = scenario.passed ? 'var(--accent)' : 'var(--err, #c66)';
    return `<div style="display:flex;gap:8px;padding:2px 0;font-size:.69rem">
      <span style="flex:1">${esc(label)}</span><span style="color:${color}">${esc(detail)}</span><span style="color:var(--muted)">${Number(scenario.latencyMs) || 0} ms</span>
    </div>`;
  }).join('');
  let summary = `Failed &middot; ${Number(result.passedCount) || 0}/${Number(result.scenarioCount) || 5} checks passed`;
  if (result.status === 'verified') summary = `Verified &middot; ${Number(result.passedCount) || 0}/${Number(result.scenarioCount) || 5} checks passed`;
  if (result.status === 'identity_unavailable') summary = 'Identity unavailable &middot; result cannot be reused after refresh or restart';
  if (result.status === 'error') summary = 'Verification failed to run';
  const target = result.target && result.target.runtimeId && result.target.model
    ? `<div style="font-size:.68rem;color:var(--muted);margin-bottom:4px">Exact target: ${esc(result.target.runtimeId)} / ${esc(result.target.model)} &middot; ${result.identityEvidence === 'runtime_version_and_model_digest' ? 'declared runtime identity + runtime version + model digest recorded' : 'stable identity unavailable'}</div>`
    : '';
  return `<div style="font-size:.72rem;margin-bottom:3px;color:${result.status === 'verified' ? 'var(--accent)' : 'var(--err, #c66)'}">${summary}</div>${target}${rows}`;
}

async function verifyLocalRuntime(button) {
  const row = button.closest('[data-lr-model-row]');
  const resultEl = row?.querySelector('[data-lr-cert-result]');
  const badge = row?.querySelector('[data-lr-cert-badge]');
  let runtimeId = '';
  let model = '';
  try {
    runtimeId = decodeURIComponent(button.getAttribute('data-lr-runtime') || '');
    model = decodeURIComponent(button.getAttribute('data-lr-model') || '');
  } catch {}
  if (!runtimeId || !model || !resultEl) return;
  button.disabled = true;
  button.textContent = 'Verifying...';
  resultEl.style.display = 'block';
  resultEl.innerHTML = '<div style="font-size:.72rem;color:var(--muted)">Running five behavioral checks. Chat remains available.</div>';
  try {
    const key = JSON.stringify([runtimeId, model]);
    let pending = localCertificationInflight.get(key);
    if (!pending) {
      pending = Promise.resolve(apiPost('/api/local-runtimes/certify', { runtimeId, model }));
      localCertificationInflight.set(key, pending);
      void pending.finally(() => {
        if (localCertificationInflight.get(key) === pending) localCertificationInflight.delete(key);
      }).catch(() => {});
    }
    const result = await pending;
    resultEl.innerHTML = localCertificationResultHtml(result || { status: 'error' });
    if (badge && result?.status === 'verified') {
      badge.className = 'status-badge ok';
      badge.innerHTML = '<span class="status-dot"></span> Verified';
    } else if (badge) {
      badge.className = 'status-badge err';
      badge.innerHTML = '<span class="status-dot"></span> Not verified';
    }
  } catch {
    resultEl.innerHTML = localCertificationResultHtml({ status: 'error', scenarios: [] });
  } finally {
    button.disabled = false;
    button.textContent = 'Verify again';
  }
}

async function addLocalRuntime() {
  const kindEl = document.getElementById('lr-add-kind');
  const urlEl = document.getElementById('lr-add-url');
  const labelEl = document.getElementById('lr-add-label');
  const status = document.getElementById('lr-add-status');
  const btn = document.getElementById('lr-add-btn');
  if (!kindEl || !urlEl) return;
  const baseUrl = urlEl.value.trim();
  if (!baseUrl) { if (status) { status.textContent = 'Enter a base URL first.'; status.style.color = 'var(--err, #c66)'; } return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  if (status) status.textContent = '';
  try {
    const body = { kind: kindEl.value, baseUrl };
    const label = labelEl ? labelEl.value.trim() : '';
    if (label) body.label = label;
    const result = await apiPost('/api/local-runtimes', body);
    if (result && result.ok) {
      if (status) {
        status.textContent = result.reachable ? 'Added and reachable.' : 'Added — not reachable right now (saved; it will appear once the server responds).';
        status.style.color = result.reachable ? 'var(--accent)' : 'var(--muted)';
      }
      urlEl.value = '';
      if (labelEl) labelEl.value = '';
      await loadLocalRuntimesEditor();
      window.refreshProviderPicker?.();
    } else if (status) {
      status.textContent = (result && result.error) || 'Failed to add runtime.';
      status.style.color = 'var(--err, #c66)';
    }
  } catch (error) {
    if (status) { status.textContent = 'Failed: ' + (error?.message || error); status.style.color = 'var(--err, #c66)'; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Add'; }
  }
}

async function removeLocalRuntime(baseUrl) {
  if (!baseUrl) return;
  try {
    await apiFetch('/api/local-runtimes?baseUrl=' + encodeURIComponent(baseUrl), { method: 'DELETE' });
  } catch {}
  await loadLocalRuntimesEditor();
  window.refreshProviderPicker?.();
}
