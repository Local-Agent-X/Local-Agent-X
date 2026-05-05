// ── Missions (Scheduled Tasks) ──
// Schedule recurring agent tasks (e.g., check email every hour, daily report)

let cronJobs = [];
let selectedJob = null;
let cronStatusTimer = null;

// Alias so the router's init_missions call works
function init_missions() { loadCronJobs(); }
// Keep backward compat
function init_cron() { loadCronJobs(); }

async function loadCronJobs() {
  try {
    const data = await apiJson('/api/cron');
    cronJobs = data.missions || data.jobs || [];
  } catch {
    // Fallback to localStorage if server is unreachable
    try { cronJobs = JSON.parse(localStorage.getItem('sax_cron_v1') || '[]'); } catch { cronJobs = []; }
  }
  renderCronList();
}

function renderCronList() {
  const countEl = document.getElementById('cron-count');
  if (countEl) countEl.textContent = cronJobs.length;
  const el = document.getElementById('cron-list');
  if (!el) return;
  if (cronJobs.length === 0) {
    el.innerHTML = '<div style="padding:12px;font-size:.78rem;color:var(--muted)">No scheduled missions yet. Create one above.</div>';
    return;
  }
  el.innerHTML = cronJobs.map(j => {
    const failing = (j.consecutiveFailures || 0) > 0;
    const status = j.lastStatus ? cronStatusBadge(j.lastStatus) : '';
    const lastTime = j.lastRun ? formatRelative(j.lastRun) : 'never';
    const dotColor = !j.enabled ? 'var(--muted)' : (failing ? '#e07b5a' : '');
    const failNote = failing ? `<span style="color:#e07b5a;font-weight:600"> · ${j.consecutiveFailures} fail${j.consecutiveFailures > 1 ? 's' : ''}</span>` : '';
    return `
    <div class="secret-item ${selectedJob?.id === j.id ? 'active' : ''}" onclick="selectCronJob('${j.id}')">
      <span class="secret-dot" style="${dotColor ? `background:${dotColor};box-shadow:none` : ''}"></span>
      <div class="secret-info">
        <div class="secret-item-name">${esc(j.name)} ${status}</div>
        <div class="secret-item-service">${esc(j.schedule)} ${j.enabled ? '' : '(paused)'} · last ${lastTime}${failNote}</div>
      </div>
    </div>`;
  }).join('');
}

function cronStatusBadge(status) {
  const colors = { success: 'var(--accent)', failed: '#e07b5a', error: '#e07b5a', skipped: 'var(--muted)' };
  const c = colors[status] || 'var(--muted)';
  return `<span style="font-size:.65rem;color:${c};margin-left:6px;text-transform:uppercase;letter-spacing:.5px">${esc(status)}</span>`;
}

function formatRelative(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const diff = Date.now() - d.getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}

function selectCronJob(id) {
  selectedJob = cronJobs.find(j => j.id === id) || null;
  renderCronList();
  renderCronDetail();
  startCronStatusPolling();
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

function formatElapsed(ms) {
  const s = Math.floor(ms/1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s/60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
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

  const resultEl = document.getElementById('cron-detail-result');
  if (resultEl) {
    const errMsg = selectedJob.lastErrorMessage;
    resultEl.textContent = errMsg ? `⚠ ${errMsg}` : (selectedJob.lastResult || '');
    resultEl.style.color = errMsg ? '#e07b5a' : 'var(--muted)';
  }

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

async function addCronJob() {
  const name = document.getElementById('new-cron-name').value.trim();
  const schedule = document.getElementById('new-cron-schedule').value.trim();
  const prompt = document.getElementById('new-cron-prompt').value.trim();
  if (!name || !schedule || !prompt) return;
  try {
    const data = await apiPost('/api/cron', { name, schedule, prompt });
    if (data.ok && data.job) {
      cronJobs.push(data.job);
      document.getElementById('new-cron-name').value = '';
      document.getElementById('new-cron-schedule').value = '';
      document.getElementById('new-cron-prompt').value = '';
      renderCronList();
      selectCronJob(data.job.id);
    }
  } catch (e) {
    alert('Failed to create mission: ' + e.message);
  }
}

async function toggleCronJob() {
  if (!selectedJob) return;
  try {
    const data = await apiPost('/api/cron/' + selectedJob.id + '/toggle', {});
    if (data.ok && data.job) {
      const id = selectedJob.id;
      await loadCronJobs();
      selectedJob = cronJobs.find(j => j.id === id) || null;
      renderCronList();
      renderCronDetail();
    }
  } catch (e) { alert('Failed: ' + e.message); }
}

async function deleteCronJob() {
  if (!selectedJob || !confirm(`Delete "${selectedJob.name}"?`)) return;
  try {
    await fetch(API + '/api/cron/' + selectedJob.id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + AUTH_TOKEN } });
    cronJobs = cronJobs.filter(j => j.id !== selectedJob.id);
    selectedJob = null;
    renderCronList();
    renderCronDetail();
  } catch (e) { alert('Failed: ' + e.message); }
}

function editCronJob() {
  if (!selectedJob) return;
  document.getElementById('cron-edit-name').value = selectedJob.name || '';
  document.getElementById('cron-edit-schedule').value = selectedJob.schedule || '';
  document.getElementById('cron-edit-prompt').value = selectedJob.prompt || '';
  document.getElementById('cron-edit-form').style.display = '';
  document.getElementById('cron-default-actions').style.display = 'none';
  const promptEl = document.getElementById('cron-detail-prompt');
  if (promptEl) promptEl.style.display = 'none';
}

function cancelCronEdit() {
  document.getElementById('cron-edit-form').style.display = 'none';
  document.getElementById('cron-default-actions').style.display = '';
  const promptEl = document.getElementById('cron-detail-prompt');
  if (promptEl) promptEl.style.display = '';
}

async function saveCronJobEdits() {
  if (!selectedJob) return;
  const name = document.getElementById('cron-edit-name').value.trim();
  const schedule = document.getElementById('cron-edit-schedule').value.trim();
  const prompt = document.getElementById('cron-edit-prompt').value.trim();
  if (!name || !schedule || !prompt) {
    alert('Name, schedule, and instructions are all required.');
    return;
  }
  try {
    const res = await fetch(API + '/api/cron/' + selectedJob.id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AUTH_TOKEN },
      body: JSON.stringify({ name, schedule, prompt }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (data.job) {
      const id = selectedJob.id;
      await loadCronJobs();
      selectedJob = cronJobs.find(j => j.id === id) || null;
      cancelCronEdit();
      renderCronList();
      renderCronDetail();
    }
  } catch (e) { alert('Save failed: ' + e.message); }
}

async function runCronJobNow() {
  if (!selectedJob) return;
  try {
    await apiPost('/api/cron/' + selectedJob.id + '/run', {});
    selectedJob.lastRun = new Date().toISOString();
    renderCronDetail();
    startCronStatusPolling();
  } catch (e) { alert('Failed: ' + e.message); }
}

// Refresh the selected job from the server list (used after status-poll detects completion)
async function refreshSelectedCronJob() {
  if (!selectedJob) return;
  const id = selectedJob.id;
  await loadCronJobs();
  selectedJob = cronJobs.find(j => j.id === id) || null;
  renderCronDetail();
}
