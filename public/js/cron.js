// ── Cron Jobs Panel ──
// Schedule recurring agent tasks (e.g., check email every hour, daily report)

let cronJobs = [];
let selectedJob = null;

function init_cron() { loadCronJobs(); }

function loadCronJobs() {
  try { cronJobs = JSON.parse(localStorage.getItem('sax_cron_v1') || '[]'); } catch { cronJobs = []; }
  renderCronList();
}

function saveCronJobs() { localStorage.setItem('sax_cron_v1', JSON.stringify(cronJobs)); }

function renderCronList() {
  document.getElementById('cron-count').textContent = cronJobs.length;
  const el = document.getElementById('cron-list');
  if (!el) return;
  if (cronJobs.length === 0) {
    el.innerHTML = '<div style="padding:12px;font-size:.78rem;color:var(--muted)">No cron jobs yet.</div>';
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
  if (!selectedJob) { empty.style.display = 'flex'; view.style.display = 'none'; return; }
  empty.style.display = 'none'; view.style.display = 'block';
  document.getElementById('cron-detail-name').textContent = selectedJob.name;
  document.getElementById('cron-detail-schedule').textContent = selectedJob.schedule;
  document.getElementById('cron-detail-prompt').textContent = selectedJob.prompt;
  document.getElementById('cron-detail-status').textContent = selectedJob.enabled ? 'Active' : 'Paused';
  document.getElementById('cron-detail-status').style.color = selectedJob.enabled ? 'var(--accent)' : 'var(--muted)';
  const lastRun = selectedJob.lastRun ? new Date(selectedJob.lastRun).toLocaleString() : 'Never';
  document.getElementById('cron-detail-lastrun').textContent = lastRun;
}

function addCronJob() {
  const name = document.getElementById('new-cron-name').value.trim();
  const schedule = document.getElementById('new-cron-schedule').value.trim();
  const prompt = document.getElementById('new-cron-prompt').value.trim();
  if (!name || !schedule || !prompt) return;
  const job = { id: uid(), name, schedule, prompt, enabled: true, createdAt: Date.now(), lastRun: null };
  cronJobs.push(job);
  saveCronJobs();
  document.getElementById('new-cron-name').value = '';
  document.getElementById('new-cron-schedule').value = '';
  document.getElementById('new-cron-prompt').value = '';
  renderCronList();
  selectCronJob(job.id);
}

function toggleCronJob() {
  if (!selectedJob) return;
  selectedJob.enabled = !selectedJob.enabled;
  saveCronJobs(); renderCronList(); renderCronDetail();
}

function deleteCronJob() {
  if (!selectedJob || !confirm(`Delete "${selectedJob.name}"?`)) return;
  cronJobs = cronJobs.filter(j => j.id !== selectedJob.id);
  selectedJob = null;
  saveCronJobs(); renderCronList(); renderCronDetail();
}

async function runCronJobNow() {
  if (!selectedJob) return;
  selectedJob.lastRun = Date.now();
  saveCronJobs(); renderCronDetail();
  // Send the prompt to the agent
  const sessionId = 'cron-' + selectedJob.id;
  try {
    await apiPost('/api/chat', { message: selectedJob.prompt, sessionId });
  } catch (e) { console.error('Cron run failed:', e); }
}
