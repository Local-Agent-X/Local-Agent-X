// ── Missions — create / edit / run / cancel ──
// New-mission modal, detail-pane edit form, and the per-job action handlers
// wired to the list-row buttons (Run, Stop, Toggle, Clear-error).
// State + list rendering live in cron.js; detail panel in cron-detail.js.

// Provider/model data for the mission model picker. Server is the single
// source of truth (/api/providers/registry) — same feed the apps gallery uses.
let MISSION_PROVIDERS = [];
let MISSION_MODELS = {};

async function initMissionModelSelector() {
  const provSel = document.getElementById('new-cron-provider');
  const modelSel = document.getElementById('new-cron-model');
  if (!provSel || !modelSel) return;
  try {
    const reg = await apiFetch('/api/providers/registry').then(r => r.json());
    MISSION_PROVIDERS = (reg.providers || []).map(p => ({ value: p.id, label: p.label }));
    MISSION_MODELS = Object.fromEntries((reg.providers || []).map(p => [p.id, p.models]));
  } catch { /* leave whatever we had; the empty "default" option still works */ }
  // Leading blank = "use my chat default" — keeps the model optional.
  provSel.innerHTML = '<option value="">Default</option>' +
    MISSION_PROVIDERS.map(p => `<option value="${p.value}">${p.label}</option>`).join('');
  provSel.value = '';
  populateMissionModels('');
}

function populateMissionModels(provider) {
  const modelSel = document.getElementById('new-cron-model');
  if (!modelSel) return;
  const models = provider ? (MISSION_MODELS[provider] || []) : [];
  if (models.length) {
    modelSel.innerHTML = models.map(m => `<option value="${m}">${m}</option>`).join('');
    modelSel.disabled = false;
  } else {
    modelSel.innerHTML = '<option value="">default</option>';
    modelSel.disabled = true;
  }
}

// Fill a <select> with the runtime's IANA timezone list, a leading
// "Server local time" (value="") option, and `selected` pre-chosen. When
// `selected` is undefined we default to this device's detected zone so a
// clock-time cron (e.g. "0 9 * * *") fires at the user's local 9am, not the
// server's. Falls back to a tiny curated list if the engine lacks
// Intl.supportedValuesOf (older runtimes).
function populateTimezoneSelect(el, selected) {
  if (!el) return;
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = []; }
  const detected = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } })();
  if (!zones.length) zones = [detected, 'UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Paris', 'Asia/Tokyo'].filter(Boolean);
  const want = selected !== undefined ? selected : detected;
  const opts = ['<option value="">Server local time</option>']
    .concat(zones.map(z => `<option value="${z}"${z === want ? ' selected' : ''}>${z}</option>`));
  el.innerHTML = opts.join('');
  el.value = want || '';
}

function openMissionModal() {
  const o = document.getElementById('mission-modal-overlay'); if (!o) return;
  o.classList.add('visible');
  initMissionModelSelector();
  populateTimezoneSelect(document.getElementById('new-cron-tz')); // default = this device's zone
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
  const provider = document.getElementById('new-cron-provider')?.value || '';
  const model = (provider && document.getElementById('new-cron-model')?.value) || '';
  const profile = document.getElementById('new-cron-profile')?.value || '';
  const tz = document.getElementById('new-cron-tz')?.value || '';
  const body = { name, schedule, prompt };
  if (provider) body.provider = provider;
  if (model) body.model = model;
  if (profile) body.profile = profile;
  if (tz) body.tz = tz;
  try {
    const data = await apiPost('/api/cron', body);
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
    backToMissionsList();
    renderCronList();
  } catch (e) { alert('Failed: ' + e.message); }
}

function editCronJob() {
  if (!selectedJob) return;
  document.getElementById('cron-edit-name').value = selectedJob.name || '';
  document.getElementById('cron-edit-schedule').value = selectedJob.schedule || '';
  document.getElementById('cron-edit-prompt').value = selectedJob.prompt || '';
  // Pass the job's existing tz explicitly so an unset job shows "Server local
  // time" rather than defaulting to this device's zone (which would silently
  // change behavior on the next save).
  populateTimezoneSelect(document.getElementById('cron-edit-tz'), selectedJob.tz || '');
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
  // Always send tz (even "") so editing a job can CLEAR a timezone back to
  // server local — the server treats an empty tz as "use server local time".
  const tz = document.getElementById('cron-edit-tz')?.value ?? '';
  try {
    const res = await fetch(API + '/api/cron/' + selectedJob.id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AUTH_TOKEN },
      body: JSON.stringify({ name, schedule, prompt, tz }),
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
