// ── Missions — create / edit / run / cancel ──
// New-mission modal, detail-pane edit form, and the per-job action handlers
// wired to the list-row buttons (Run, Stop, Toggle, Clear-error).
// State + list rendering live in cron.js; detail panel in cron-detail.js.

function openMissionModal() {
  const o = document.getElementById('mission-modal-overlay'); if (!o) return;
  o.classList.add('visible');
  setTimeout(() => document.getElementById('new-cron-name')?.focus(), 50);
}
function closeMissionModal() { document.getElementById('mission-modal-overlay')?.classList.remove('visible'); }

async function addCronJob() {
  const name = document.getElementById('new-cron-name').value.trim();
  const schedule = document.getElementById('new-cron-schedule').value.trim();
  const prompt = document.getElementById('new-cron-prompt').value.trim();
  if (!name || !schedule || !prompt) {
    alert('Name, schedule, and instructions are all required.');
    return;
  }
  try {
    const data = await apiPost('/api/cron', { name, schedule, prompt });
    if (data.ok && data.job) {
      cronJobs.push(data.job);
      document.getElementById('new-cron-name').value = '';
      document.getElementById('new-cron-schedule').value = '';
      document.getElementById('new-cron-prompt').value = '';
      closeMissionModal();
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

async function refreshSelectedCronJob() {
  if (!selectedJob) return;
  const id = selectedJob.id;
  await loadCronJobs();
  selectedJob = cronJobs.find(j => j.id === id) || null;
  renderCronDetail();
}

async function toggleCronById(id) {
  try {
    const data = await apiPost('/api/cron/' + id + '/toggle', {});
    if (data && data.ok) { await loadCronJobs(); if (selectedJob && selectedJob.id === id) refreshSelectedCronJob(); }
  } catch (e) { alert('Failed: ' + e.message); }
}

async function runCronById(id) {
  try {
    await apiPost('/api/cron/' + id + '/run', {});
    setTimeout(() => loadCronJobs(), 800);
    if (selectedJob && selectedJob.id === id) startCronStatusPolling();
  } catch (e) { alert('Failed: ' + e.message); }
}

async function cancelCronRun() {
  if (!selectedJob) return;
  return cancelCronRunById(selectedJob.id);
}

async function cancelCronRunById(id) {
  // Idempotent — repeated clicks while the abort propagates are no-ops.
  // Without this guard the user mashes the button (because nothing visible
  // changes for 5-30s while the agent loop checks its abort signal between
  // iterations) and queues up redundant POSTs.
  if (cronStopping.has(id)) return;
  cronStopping.add(id);
  // Immediate visual feedback BEFORE the network call so the click feels
  // landed even if the server takes a moment to respond.
  if (selectedJob && selectedJob.id === id) applyCronRunButtonState(selectedJob);
  renderCronList();
  try {
    const data = await apiPost('/api/cron/' + id + '/cancel', {});
    if (data && !data.cancelled) {
      // Server didn't find an in-flight run — clear stopping state so the
      // button corrects immediately rather than waiting for the next poll.
      cronStopping.delete(id);
      await loadCronJobs();
      if (selectedJob && selectedJob.id === id) refreshSelectedCronJob();
      renderCronList();
    }
  } catch (e) {
    cronStopping.delete(id);
    if (selectedJob && selectedJob.id === id) applyCronRunButtonState(selectedJob);
    renderCronList();
    alert('Cancel failed: ' + e.message);
  }
}

async function clearCronError() {
  if (!selectedJob) return;
  return clearCronErrorById(selectedJob.id);
}

async function clearCronErrorById(id) {
  try {
    await apiPost('/api/cron/' + id + '/clear-error', {});
    await loadCronJobs();
    if (selectedJob && selectedJob.id === id) refreshSelectedCronJob();
  } catch (e) { alert('Failed: ' + e.message); }
}
