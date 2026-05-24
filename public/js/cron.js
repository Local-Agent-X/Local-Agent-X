// ── Missions (Scheduled Tasks) — list + shared state ──
// Detail panel (renderCronDetail, polling, reports/history): cron-detail.js
// Modal + CRUD (add/edit/delete/run/cancel): cron-actions.js

let cronJobs = [];
let selectedJob = null;
let cronStatusTimer = null;
// Tracks jobs the user has clicked Stop on. Cleared once the live-status
// poll confirms the run actually wound down (abort signal can take 5-30s
// to propagate through an in-flight tool call). Without this flag the Stop
// button feels broken — the click registers but the UI doesn't change until
// the next /api/cron list poll, and the user mashes the button repeatedly.
const cronStopping = new Set();

function init_missions() { restoreCronSectionState(); loadMissionModelOptions(); loadCronJobs(); }

// Persist open/closed state of the Reports + Recent runs collapsible
// sections across page reloads. Default (no key set) keeps the HTML
// `open` attribute — both sections start expanded for first-time users.
function restoreCronSectionState() {
  const pairs = [
    ['cron-reports-wrap', 'lax_cron_reports_open'],
    ['cron-history-wrap', 'lax_cron_history_open'],
  ];
  for (const [id, key] of pairs) {
    const el = document.getElementById(id);
    if (!el) continue;
    const saved = localStorage.getItem(key);
    if (saved === '0') el.removeAttribute('open');
    else if (saved === '1') el.setAttribute('open', '');
    if (!el.dataset.collapsePersistWired) {
      el.addEventListener('toggle', () => {
        localStorage.setItem(key, el.open ? '1' : '0');
      });
      el.dataset.collapsePersistWired = '1';
    }
  }
}

async function loadCronJobs() {
  try {
    const data = await apiJson('/api/cron');
    cronJobs = data.missions || data.jobs || [];
  } catch { cronJobs = []; }
  renderCronList();
}

function renderCronList() {
  const countEl = document.getElementById('cron-count');
  if (countEl) countEl.textContent = cronJobs.length;
  const el = document.getElementById('cron-list');
  if (!el) return;
  if (cronJobs.length === 0) {
    el.innerHTML = '<div class="drill-empty">No scheduled missions yet. Hit <strong>+ New Mission</strong> to schedule a recurring task.</div>';
    return;
  }
  el.innerHTML = cronJobs.map(j => {
    const failing = (j.consecutiveFailures || 0) > 0;
    const status = j.lastStatus ? cronStatusBadge(j.lastStatus) : '';
    const lastTime = j.lastRun ? formatRelative(j.lastRun) : 'never';
    const dotColor = !j.enabled ? 'var(--muted)' : (failing ? '#e07b5a' : '');
    const failNote = failing ? `<span style="color:#e07b5a;font-weight:600"> · ${j.consecutiveFailures} fail${j.consecutiveFailures > 1 ? 's' : ''}</span>` : '';
    const nextNote = (j.enabled && j.nextRunAt) ? ` · next ${formatRelativeFuture(j.nextRunAt)}` : '';
    const errLine = (j.lastErrorMessage && (j.lastStatus === 'failed' || j.lastStatus === 'error'))
      ? `<div class="cron-row-err" title="${esc(j.lastErrorMessage)}">⚠ ${esc(truncate(j.lastErrorMessage, 80))} <span style="color:var(--muted);cursor:pointer;margin-left:4px" title="Dismiss" onclick="event.stopPropagation();clearCronErrorById('${j.id}')">✕</span></div>` : '';
    const pauseGlyph = j.enabled ? '⏸' : '▶';
    const stopping = cronStopping.has(j.id);
    const runAct = stopping
      ? `<span class="cron-row-act" title="Aborting…" style="color:#e07b5a;font-size:.65rem;font-weight:600;letter-spacing:.5px;cursor:wait;opacity:.85">STOPPING</span>`
      : j.isRunning
        ? `<span class="cron-row-act" title="Stop run" style="color:#e07b5a" onclick="event.stopPropagation();cancelCronRunById('${j.id}')">■</span>`
        : `<span class="cron-row-act" title="Run now" onclick="event.stopPropagation();runCronById('${j.id}')">▶▶</span>`;
    const actions = `<span class="cron-row-actions">`
      + runAct
      + `<span class="cron-row-act" title="${j.enabled ? 'Pause' : 'Resume'}" onclick="event.stopPropagation();toggleCronById('${j.id}')">${pauseGlyph}</span>`
      + `</span>`;
    return `
    <div class="drill-row" onclick="selectCronJob('${j.id}')">
      <span class="secret-dot" style="${dotColor ? `background:${dotColor};box-shadow:none` : ''};flex-shrink:0"></span>
      <div style="flex:1;min-width:0">
        <div style="font-family:var(--mono);font-size:.8rem;color:var(--text)">${esc(j.name)} ${status}</div>
        <div style="font-size:.7rem;color:var(--muted);font-family:var(--mono);margin-top:2px">${esc(j.schedule)} ${j.enabled ? '' : '(paused)'} · last ${lastTime}${nextNote}${failNote}</div>
        ${errLine}
      </div>
      ${actions}
    </div>`;
  }).join('');
}

function selectCronJob(id) {
  selectedJob = cronJobs.find(j => j.id === id) || null;
  if (!selectedJob) { backToMissionsList(); return; }
  renderCronDetail();
  showMissionsDetail();
  startCronStatusPolling();
}

function showMissionsDetail() {
  document.getElementById('missions-list-view')?.classList.add('hidden');
  document.getElementById('cron-detail-wrap')?.classList.add('active');
}

function backToMissionsList() {
  selectedJob = null;
  document.getElementById('cron-detail-wrap')?.classList.remove('active');
  document.getElementById('missions-list-view')?.classList.remove('hidden');
}

// ── Formatting helpers ──
function truncate(s, n) { return !s ? '' : (s.length > n ? s.slice(0, n - 1) + '…' : s); }

function formatRelativeFuture(iso) {
  const d = new Date(iso); if (isNaN(d.getTime())) return iso;
  const diff = d.getTime() - Date.now(); if (diff <= 0) return 'soon';
  const s = Math.floor(diff / 1000); if (s < 60) return `in ${s}s`;
  const m = Math.floor(s / 60); if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60); if (h < 24) return `in ${h}h`;
  return `in ${Math.floor(h / 24)}d`;
}

function formatRelative(iso) {
  const d = new Date(iso); if (isNaN(d.getTime())) return iso;
  const s = Math.floor((Date.now() - d.getTime()) / 1000); if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatElapsed(ms) {
  const s = Math.floor(ms/1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s/60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

function cronStatusBadge(status) {
  const colors = { success: 'var(--accent)', failed: '#e07b5a', error: '#e07b5a', skipped: 'var(--muted)' };
  const c = colors[status] || 'var(--muted)';
  return `<span style="font-size:.65rem;color:${c};margin-left:6px;text-transform:uppercase;letter-spacing:.5px">${esc(status)}</span>`;
}
