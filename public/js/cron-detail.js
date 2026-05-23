// ── Missions — detail panel ──
// Right-pane rendering: status, model picker, live progress, history, reports.
// State (selectedJob, cronJobs, cronStopping, cronStatusTimer) lives in cron.js.

// Cached list of {provider, model, label} pairs for the per-mission model
// picker. Loaded once when the missions panel first opens; reused across
// mission switches. Refreshed implicitly only on page reload.
let cronModelOptions = null;
let cronModelOptionsLoading = null;

async function loadMissionModelOptions() {
  if (cronModelOptions) return cronModelOptions;
  if (cronModelOptionsLoading) return cronModelOptionsLoading;
  cronModelOptionsLoading = (async () => {
    try {
      const data = await apiJson('/api/providers');
      const flat = [];
      for (const p of (data.providers || [])) {
        for (const m of (p.models || [])) {
          flat.push({ provider: p.id, model: m, label: `${p.name} · ${m}` });
        }
      }
      cronModelOptions = flat;
    } catch { cronModelOptions = []; }
    return cronModelOptions;
  })();
  return cronModelOptionsLoading;
}

function renderMissionModelPicker(job) {
  const sel = document.getElementById('cron-detail-model');
  if (!sel) return;
  const opts = cronModelOptions || [];
  const currentValue = (job.provider && job.model) ? `${job.provider}:${job.model}` : '';
  // If the job's saved provider/model isn't in the live options list
  // (creds removed, model removed from registry, etc.), surface it
  // anyway so the user can see what was picked and pick something else.
  const haveCurrent = !currentValue || opts.some(o => `${o.provider}:${o.model}` === currentValue);
  let html = `<option value=""${currentValue ? '' : ' selected'}>System default</option>`;
  if (!haveCurrent) html += `<option value="${esc(currentValue)}" selected>(unavailable) ${esc(currentValue)}</option>`;
  for (const o of opts) {
    const val = `${o.provider}:${o.model}`;
    const selAttr = val === currentValue ? ' selected' : '';
    html += `<option value="${esc(val)}"${selAttr}>${esc(o.label)}</option>`;
  }
  sel.innerHTML = html;
}

async function setMissionModel(value) {
  if (!selectedJob) return;
  let provider = '', model = '';
  if (value) {
    const idx = value.indexOf(':');
    if (idx > 0) { provider = value.slice(0, idx); model = value.slice(idx + 1); }
  }
  try {
    const res = await apiJson(`/api/cron/${selectedJob.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, model }),
    });
    if (res?.job) {
      // Refresh local cache so the next switch reflects the new state.
      selectedJob.provider = res.job.provider || '';
      selectedJob.model = res.job.model || '';
      const idx = cronJobs.findIndex(j => j.id === selectedJob.id);
      if (idx >= 0) cronJobs[idx] = { ...cronJobs[idx], ...res.job };
    }
  } catch (e) {
    alert('Failed to set model: ' + (e?.message || e));
  }
}

function startCronStatusPolling() {
  if (cronStatusTimer) { clearInterval(cronStatusTimer); cronStatusTimer = null; }
  if (!selectedJob) return;
  let wasRunning = false;
  const poll = async () => {
    if (!selectedJob) { if (cronStatusTimer) { clearInterval(cronStatusTimer); cronStatusTimer = null; } return; }
    try {
      const data = await apiJson(`/api/cron/${selectedJob.id}/status`);
      renderCronLiveStatus(data);
      if (selectedJob.isRunning !== data.running) {
        selectedJob.isRunning = !!data.running;
      }
      // Run wound down — clear "stopping" state so the Run button can come
      // back. Until this fires, Stop stays disabled and Run stays hidden.
      if (!data.running && cronStopping.has(selectedJob.id)) {
        cronStopping.delete(selectedJob.id);
        renderCronList();
      }
      applyCronRunButtonState(selectedJob);
      // When a run transitions from running → idle, refresh job state + history
      if (wasRunning && !data.running) {
        refreshSelectedCronJob();
        loadCronHistory(selectedJob.id);
      } else if (!data.running) {
        loadCronReports(selectedJob.id);
      }
      wasRunning = !!data.running;
    } catch {}
  };
  poll();
  cronStatusTimer = setInterval(poll, 2500);
}

function applyCronRunButtonState(job) {
  const runBtn = document.getElementById('cron-run-btn');
  const stopBtn = document.getElementById('cron-stop-btn');
  if (!runBtn || !stopBtn) return;
  const stopping = cronStopping.has(job.id);
  if (stopping) {
    runBtn.style.display = 'none';
    stopBtn.style.display = '';
    stopBtn.disabled = true;
    stopBtn.textContent = 'Stopping…';
  } else if (job.isRunning) {
    runBtn.style.display = 'none';
    stopBtn.style.display = '';
    stopBtn.disabled = false;
    stopBtn.textContent = 'Stop';
  } else {
    runBtn.style.display = '';
    stopBtn.style.display = 'none';
    stopBtn.disabled = false;
    stopBtn.textContent = 'Stop';
  }
}

function renderCronLiveStatus(data) {
  const box = document.getElementById('cron-live-status');
  if (!box) return;
  if (!data || !data.running) { box.style.display = 'none'; return; }
  box.style.display = 'block';
  const elapsed = document.getElementById('cron-live-elapsed');
  const agents = document.getElementById('cron-live-agents');
  const subs = data.subAgents || [];
  if (subs.length === 0) {
    if (elapsed) elapsed.textContent = '';
    if (agents) agents.innerHTML = '<span style="color:var(--muted)">Planning...</span>';
    return;
  }
  // Show longest-running sub-agent's elapsed time in header
  const maxElapsed = Math.max(...subs.map(s => s.elapsed || 0));
  if (elapsed) elapsed.textContent = formatElapsed(maxElapsed);
  if (agents) {
    agents.innerHTML = subs.map(a => {
      const tools = (a.recentTools && a.recentTools.length) ? a.recentTools.slice(-3).join(' → ') : '(working)';
      const tok = a.tokensUsed ? ` · ${(a.tokensUsed/1000).toFixed(1)}K tok` : '';
      return `<div style="margin-bottom:4px"><span style="color:var(--accent)">▸</span> <b>${esc(a.name || a.role || 'agent')}</b> <span style="color:var(--muted)">${esc(a.status)}${tok}</span><br><span style="color:var(--muted);margin-left:14px">${esc(tools)}</span></div>`;
    }).join('');
  }
}

function renderCronDetail() {
  const empty = document.getElementById('cron-detail-empty');
  const view = document.getElementById('cron-detail-view');
  if (!selectedJob) { if (empty) empty.style.display = 'flex'; if (view) view.style.display = 'none'; return; }
  if (empty) empty.style.display = 'none';
  if (view) view.style.display = 'block';
  document.getElementById('cron-detail-name').textContent = selectedJob.name;
  document.getElementById('cron-detail-schedule').textContent = selectedJob.schedule;
  document.getElementById('cron-detail-prompt').textContent = selectedJob.prompt;

  const statusEl = document.getElementById('cron-detail-status');
  if (selectedJob.enabled) {
    statusEl.textContent = 'Active';
    statusEl.style.color = 'var(--accent)';
  } else {
    const fails = selectedJob.consecutiveFailures || 0;
    statusEl.textContent = fails >= 5 ? `Auto-paused (${fails} fails)` : 'Paused';
    statusEl.style.color = fails >= 5 ? '#e07b5a' : 'var(--muted)';
  }

  const lastRun = selectedJob.lastRun ? new Date(selectedJob.lastRun).toLocaleString() : 'Never';
  const lastStatus = selectedJob.lastStatus ? ` (${selectedJob.lastStatus})` : '';
  document.getElementById('cron-detail-lastrun').textContent = lastRun + lastStatus;

  const nextEl = document.getElementById('cron-detail-nextrun');
  if (nextEl) {
    nextEl.textContent = selectedJob.nextRunAt
      ? new Date(selectedJob.nextRunAt).toLocaleString()
      : (selectedJob.enabled ? '—' : 'paused');
  }

  const failsEl = document.getElementById('cron-detail-fails');
  if (failsEl) {
    const n = selectedJob.consecutiveFailures || 0;
    failsEl.textContent = String(n);
    failsEl.style.color = n > 0 ? '#e07b5a' : 'var(--muted)';
  }

  // Model picker — re-rendered on every mission switch so the dropdown
  // reflects the just-selected job's saved choice. Options come from
  // /api/providers (cached by loadMissionModelOptions, kicked off at
  // missions-panel init time).
  if (cronModelOptions) renderMissionModelPicker(selectedJob);
  else loadMissionModelOptions().then(() => { if (selectedJob) renderMissionModelPicker(selectedJob); });

  const resultEl = document.getElementById('cron-detail-result');
  if (resultEl) {
    const errMsg = selectedJob.lastErrorMessage;
    resultEl.textContent = errMsg ? `⚠ ${errMsg}` : (selectedJob.lastResult || '');
    resultEl.style.color = errMsg ? '#e07b5a' : 'var(--muted)';
  }

  applyCronRunButtonState(selectedJob);
  const clearErrBtn = document.getElementById('cron-clear-error-btn');
  if (clearErrBtn) clearErrBtn.style.display = selectedJob.lastErrorMessage ? '' : 'none';

  loadCronReports(selectedJob.id);
  loadCronHistory(selectedJob.id);
}

async function loadCronHistory(jobId) {
  const el = document.getElementById('cron-history');
  if (!el) return;
  try {
    const data = await apiJson(`/api/cron/${jobId}/history?limit=20`);
    const runs = data.runs || [];
    if (runs.length === 0) {
      el.innerHTML = '<div style="color:var(--muted);font-size:.78rem;padding:4px 0">No runs yet</div>';
      return;
    }
    el.innerHTML = runs.map(r => {
      const when = r.startedAt ? new Date(r.startedAt).toLocaleString() : '';
      const dur = r.durationMs != null ? ` · ${(r.durationMs / 1000).toFixed(1)}s` : '';
      const colors = { success: 'var(--accent)', failed: '#e07b5a', error: '#e07b5a', skipped: 'var(--muted)' };
      const c = colors[r.status] || 'var(--muted)';
      const tag = `<span style="color:${c};font-weight:600;text-transform:uppercase;font-size:.65rem;letter-spacing:.5px">${esc(r.status)}</span>`;
      const manual = r.manual ? ' <span style="color:var(--muted);font-size:.65rem">(manual)</span>' : '';
      const note = r.errorMessage ? `<div style="color:#e07b5a;font-size:.7rem;margin-top:2px;margin-left:14px">${esc(r.errorMessage)}</div>` : '';
      return `<div style="padding:6px 8px;border-bottom:1px solid var(--border);font-size:.75rem">
        <div>${tag} <span>${esc(when)}${esc(dur)}</span>${manual}</div>
        ${note}
      </div>`;
    }).join('');
  } catch { el.innerHTML = ''; }
}

async function loadCronReports(jobId) {
  const el = document.getElementById('cron-reports');
  if (!el) return;
  try {
    const data = await apiJson(`/api/cron/${jobId}/reports`);
    const reports = data.reports || [];
    const countEl = document.getElementById('cron-reports-count');
    if (countEl) countEl.textContent = reports.length ? `${reports.length} total` : '';
    if (reports.length === 0) {
      el.innerHTML = '<div style="color:var(--muted);font-size:.78rem;padding:4px 0">No reports yet</div>';
      return;
    }
    el.innerHTML = reports.map(r => {
      // Filename is toISOString() with ":" and "." replaced by "-", e.g. 2026-04-06T07-15-19-348Z.md
      // Reconstruct a parseable ISO string then display in local time.
      const raw = r.name.replace(/\.md$/, '');
      const iso = raw.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z');
      const d = new Date(iso);
      const date = isNaN(d.getTime()) ? raw : d.toLocaleString();
      return `<div style="display:flex;align-items:center;gap:6px;padding:4px 8px;font-size:.78rem;border-bottom:1px solid var(--border)">
        <span onclick="viewCronReport('${jobId}','${esc(r.name)}')" style="cursor:pointer;color:var(--accent);flex:1">${date}</span>
        <span onclick="deleteCronReport('${jobId}','${esc(r.name)}')" title="Delete report" style="cursor:pointer;color:var(--muted);padding:0 4px">×</span>
      </div>`;
    }).join('');
  } catch { el.innerHTML = ''; }
}

async function deleteCronReport(jobId, fileName) {
  if (!confirm(`Delete report ${fileName}?`)) return;
  try {
    await fetch(API + '/api/cron/' + jobId + '/reports/' + fileName, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + AUTH_TOKEN }
    });
    loadCronReports(jobId);
  } catch (e) { alert('Failed: ' + e.message); }
}

async function viewCronReport(jobId, fileName) {
  try {
    const data = await apiJson(`/api/cron/${jobId}/reports/${fileName}`);
    const content = data.content || 'Empty report';
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:999;display:flex;align-items:center;justify-content:center';
    modal.onclick = e => { if (e.target === modal) modal.remove(); };
    modal.innerHTML = `<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;max-width:700px;width:90%;max-height:80vh;overflow:auto;padding:24px;white-space:pre-wrap;font-size:.82rem;line-height:1.5">${esc(content)}<div style="margin-top:16px;text-align:right"><button onclick="this.closest('[style*=fixed]').remove()" class="btn btn-sm">Close</button></div></div>`;
    document.body.appendChild(modal);
  } catch (e) { alert('Failed to load report: ' + e.message); }
}
