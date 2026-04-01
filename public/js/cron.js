// ── Missions (Scheduled Tasks) ──
// Schedule recurring agent tasks (e.g., check email every hour, daily report)

let cronJobs = [];
let selectedJob = null;

// Alias so the router's init_missions call works
function init_missions() { loadCronJobs(); }
// Keep backward compat
function init_cron() { loadCronJobs(); }

async function loadCronJobs() {
  try {
    const data = await apiJson('/api/cron');
    cronJobs = data.jobs || [];
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
  el.innerHTML = cronJobs.map(j => `
    <div class="secret-item ${selectedJob?.id === j.id ? 'active' : ''}" onclick="selectCronJob('${j.id}')">
      <span class="secret-dot" style="${j.enabled ? '' : 'background:var(--muted);box-shadow:none'}"></span>
      <div class="secret-info">
        <div class="secret-item-name">${esc(j.name)}</div>
        <div class="secret-item-service">${esc(j.schedule)} ${j.enabled ? '' : '(paused)'}</div>
      </div>
    </div>
  `).join('');
}

function selectCronJob(id) {
  selectedJob = cronJobs.find(j => j.id === id) || null;
  renderCronList();
  renderCronDetail();
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
  document.getElementById('cron-detail-status').textContent = selectedJob.enabled ? 'Active' : 'Paused';
  document.getElementById('cron-detail-status').style.color = selectedJob.enabled ? 'var(--accent)' : 'var(--muted)';
  const lastRun = selectedJob.lastRun ? new Date(selectedJob.lastRun).toLocaleString() : 'Never';
  document.getElementById('cron-detail-lastrun').textContent = lastRun;
  const resultEl = document.getElementById('cron-detail-result');
  if (resultEl) resultEl.textContent = selectedJob.lastResult || '';
  loadCronReports(selectedJob.id);
}

async function loadCronReports(jobId) {
  const el = document.getElementById('cron-reports');
  if (!el) return;
  try {
    const data = await apiJson(`/api/cron/${jobId}/reports`);
    const reports = data.reports || [];
    if (reports.length === 0) {
      el.innerHTML = '<div style="color:var(--muted);font-size:.78rem;padding:4px 0">No reports yet</div>';
      return;
    }
    el.innerHTML = reports.slice(0, 10).map(r => {
      const date = r.name.replace('.md', '').replace(/T/, ' ').replace(/-/g, (m, i) => i > 9 ? ':' : '-').slice(0, 19);
      return `<div class="report-link" onclick="viewCronReport('${jobId}','${esc(r.name)}')" style="cursor:pointer;padding:4px 8px;font-size:.78rem;color:var(--accent);border-bottom:1px solid var(--border)">${date}</div>`;
    }).join('');
  } catch { el.innerHTML = ''; }
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
      selectedJob.enabled = data.job.enabled;
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

async function runCronJobNow() {
  if (!selectedJob) return;
  try {
    await apiPost('/api/cron/' + selectedJob.id + '/run', {});
    selectedJob.lastRun = new Date().toISOString();
    renderCronDetail();
  } catch (e) { alert('Failed: ' + e.message); }
}
