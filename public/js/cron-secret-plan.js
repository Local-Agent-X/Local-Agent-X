// ── Missions — "Keys this job may use" ──
// A job's key plan (CronJob.secretPlan, src/cron/job-secret-plan.ts): the saved
// keys its runs may send, each to one site, without stopping for the user.
// Saving the New Mission form or the edit form is the user's approval of the
// plan (no card); the detail view shows every job's plan, whether it was made
// here or approved on a card in the chat, with Remove. Names and sites only:
// /api/secrets lists names and where each key was saved or approved, never a
// value. Anything off the plan still waits in the inbox at run time.
// Wrapped so its helpers do not collide with other pages' globals; escapes with
// shared-escape.js esc().
(function () {
  /** [{ name, sites: [saved origin, ...approved destinations] }], or null before the first load. */
  let vaultKeys = null;
  /** Editor container id → the plan being edited. */
  const editors = {};

  async function loadVaultKeys() {
    try {
      const list = await apiJson('/api/secrets');
      vaultKeys = (Array.isArray(list) ? list : []).map((s) => ({
        name: s.name,
        sites: [...new Set([s.origin, ...(s.approvedDestinations || []).map((a) => a.origin)].filter(Boolean))],
      }));
    } catch { vaultKeys = vaultKeys || []; }
  }

  /** A site as typed, as the origin the server keys it by; null when it is not one. */
  function siteOf(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;
    try {
      const url = new URL(text.includes('://') ? text : 'https://' + text);
      return url.origin !== 'null' ? url.origin : null;
    } catch { return null; }
  }

  function pairRow(pair, removeCall) {
    return `<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;font-size:.78rem">` +
      `<span style="font-family:var(--mono);font-weight:600">${esc(pair.name)}</span>` +
      `<span style="color:var(--muted)">at</span>` +
      `<span style="font-family:var(--mono);color:var(--text);overflow:hidden;text-overflow:ellipsis">${esc(pair.destination)}</span>` +
      `<button type="button" class="action-btn secondary" style="margin-left:auto;padding:2px 10px;font-size:.72rem" onclick="${removeCall}">Remove</button>` +
      `</div>`;
  }

  function renderEditor(id) {
    const el = document.getElementById(id);
    if (!el) return;
    const plan = editors[id] || [];
    const keys = vaultKeys || [];
    const rows = plan.map((p, i) => pairRow(p, `cronSecretPlanRemove('${id}', ${i})`)).join('');
    const options = keys.length
      ? '<option value="">Pick a saved key…</option>' + keys.map((k) => `<option value="${esc(k.name)}">${esc(k.name)}</option>`).join('')
      : `<option value="">${vaultKeys ? 'No saved keys yet (Settings → Secrets)' : 'Loading saved keys…'}</option>`;
    el.innerHTML = rows +
      `<div style="display:flex;gap:6px;flex-wrap:wrap">` +
      `<select class="field-input" id="${id}-key" style="flex:1;min-width:140px" onchange="cronSecretPlanPickKey('${id}')">${options}</select>` +
      `<input class="field-input" id="${id}-site" list="${id}-sites" placeholder="https://api.example.com" style="flex:2;min-width:160px"/>` +
      `<datalist id="${id}-sites"></datalist>` +
      `<button type="button" class="action-btn secondary" onclick="cronSecretPlanAdd('${id}')">Add</button>` +
      `</div>`;
  }

  /** Show `plan` in the editor at `id` and load the saved keys to pick from. */
  window.mountCronSecretPlan = async function (id, plan) {
    editors[id] = (plan || []).map((p) => ({ name: p.name, destination: p.destination }));
    renderEditor(id);
    await loadVaultKeys();
    renderEditor(id);
  };

  /** The plan the editor at `id` holds now, for the save body. */
  window.cronSecretPlanOf = function (id) {
    return (editors[id] || []).map((p) => ({ name: p.name, destination: p.destination }));
  };

  /** A key was picked: its saved site goes in the site box, its approved ones in the suggestions. */
  window.cronSecretPlanPickKey = function (id) {
    const name = document.getElementById(`${id}-key`)?.value || '';
    const key = (vaultKeys || []).find((k) => k.name === name);
    const sites = key ? key.sites : [];
    const list = document.getElementById(`${id}-sites`);
    if (list) list.innerHTML = sites.map((s) => `<option value="${esc(s)}"></option>`).join('');
    const input = document.getElementById(`${id}-site`);
    if (input) input.value = sites[0] || '';
  };

  window.cronSecretPlanAdd = function (id) {
    const name = document.getElementById(`${id}-key`)?.value || '';
    if (!name) { alert('Pick a saved key first.'); return; }
    const destination = siteOf(document.getElementById(`${id}-site`)?.value);
    if (!destination) { alert('Enter the site this key goes to, like https://api.example.com'); return; }
    const plan = editors[id] || (editors[id] = []);
    if (!plan.some((p) => p.name === name && p.destination === destination)) plan.push({ name, destination });
    renderEditor(id);
  };

  window.cronSecretPlanRemove = function (id, index) {
    (editors[id] || []).splice(index, 1);
    renderEditor(id);
  };

  /** The detail view's list: every job's plan, wherever it was approved, with Remove. */
  window.renderCronSecretPlanDetail = function (job) {
    const el = document.getElementById('cron-detail-keys');
    if (!el) return;
    const plan = (job && job.secretPlan) || [];
    el.innerHTML = plan.length
      ? plan.map((p, i) => pairRow(p, `removeCronPlanPair('${esc(job.id)}', ${i})`)).join('')
      : '<div class="field-hint" style="margin-top:0">None. A run asks in your inbox before it sends a key to a site the first time.</div>';
  };

  window.removeCronPlanPair = async function (jobId, index) {
    const job = (typeof cronJobs !== 'undefined' ? cronJobs : []).find((j) => j.id === jobId);
    const pair = job && (job.secretPlan || [])[index];
    if (!pair || !confirm(`Stop letting "${job.name}" send ${pair.name} to ${pair.destination}?\n\nIts runs will ask in your inbox before sending it there.`)) return;
    const secretPlan = job.secretPlan.filter((_, i) => i !== index);
    try {
      const data = await apiJson('/api/cron/' + encodeURIComponent(jobId), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secretPlan }),
      });
      if (data.error) throw new Error(data.error);
      await refreshSelectedCronJob();
    } catch (e) { alert('Could not remove the key: ' + e.message); }
  };
})();
