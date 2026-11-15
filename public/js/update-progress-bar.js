// ── Update progress bar ──
// One bar for the boot banner and Settings → Updates: it reads
// GET /api/updates/progress (src/update-progress.ts), which reports the step
// an update is on and how far it has got. Shown while an install runs; a
// background preparation never puts it in front of the user.

function updateProgressMarkup(p) {
  const pct = Math.max(0, Math.min(100, Number(p && p.percent) || 0));
  const label = (p && p.label) || 'Updating…';
  return `<span class="update-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="Update progress">`
    + `<span class="update-progress-label">${esc(label)}</span>`
    + `<span class="update-progress-track"><span class="update-progress-fill" style="width:${pct}%"></span></span>`
    + `<span class="update-progress-pct">${pct}%</span></span>`;
}

/** Polls the progress once a second into `el` until the returned stop() is called. */
function watchUpdateProgress(el) {
  let stopped = false;
  el.innerHTML = updateProgressMarkup({ percent: 0, label: 'Starting the update…' });
  const tick = async () => {
    if (stopped) return;
    try {
      const p = await apiFetch('/api/updates/progress').then(r => r.json());
      if (!stopped && p && p.mode === 'installing') el.innerHTML = updateProgressMarkup(p);
    } catch { /* the next tick tries again; the apply request reports any real failure */ }
    if (!stopped) setTimeout(tick, 1000);
  };
  setTimeout(tick, 300);
  return () => { stopped = true; };
}

window.updateProgressMarkup = updateProgressMarkup;
window.watchUpdateProgress = watchUpdateProgress;
