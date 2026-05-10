// ── Chat: Train Voice Modal (SoVITS) ──
//
// Modal builder for kicking off a SoVITS voice-clone training run. Walks
// the user through name + sample upload, posts to the orchestrator, polls
// /api/voices/sovits/training/<id>/status for progress. Largest of the
// three voice modals — its own file to stay under 400 LOC.
//
// External deps: apiFetch / apiPost / esc / AUTH_TOKEN (shared.js).

function openTrainVoiceModal() {
  const existing = document.getElementById('train-voice-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'train-voice-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:9999;display:flex;align-items:center;justify-content:center';
  modal.innerHTML = `
    <div style="background:var(--bg,#fff);color:var(--text,#000);border:1px solid var(--border,#ccc);border-radius:10px;padding:22px;max-width:540px;width:94%">
      <h3 style="margin:0 0 6px;font-size:1.1rem">Train a new voice</h3>
      <p style="margin:0 0 14px;color:var(--muted,#666);font-size:.82rem">
        Paste a YouTube URL with at least 20 minutes of one person speaking — clean dialog, minimal music.
        Pipeline runs locally on your GPU: download → slice → transcribe → train SoVITS + GPT → register.
        Wall time on an RTX 3060: <strong>~30-45 min</strong>. You can close this and the training continues server-side.
      </p>
      <div id="tv-incomplete" style="margin-bottom:14px"></div>
      <div style="margin-bottom:10px">
        <label style="display:block;font-size:.78rem;color:var(--muted,#666);margin-bottom:4px">Voice name</label>
        <input id="tv-name" type="text" placeholder="e.g. Optimus Prime" style="width:100%;padding:8px;border:1px solid var(--border,#ccc);border-radius:6px;font-size:.9rem"/>
      </div>
      <div style="margin-bottom:10px">
        <label style="display:block;font-size:.78rem;color:var(--muted,#666);margin-bottom:4px">YouTube URL</label>
        <input id="tv-url" type="url" placeholder="https://youtube.com/watch?v=..." style="width:100%;padding:8px;border:1px solid var(--border,#ccc);border-radius:6px;font-size:.9rem"/>
      </div>
      <label style="display:flex;align-items:center;gap:8px;font-size:.85rem;margin-bottom:12px;cursor:pointer">
        <input id="tv-denoise" type="checkbox" checked style="margin:0"/>
        <span>Source has background music or noise (run vocal isolation; adds ~3-5 min)</span>
      </label>
      <details style="margin-bottom:12px;font-size:.82rem">
        <summary style="cursor:pointer;color:var(--muted,#666)">Advanced</summary>
        <div style="margin-top:8px;display:flex;gap:10px">
          <label style="flex:1">SoVITS epochs<input id="tv-eps-s" type="number" value="8" min="2" max="40" style="width:100%;padding:6px;border:1px solid var(--border,#ccc);border-radius:5px;margin-top:3px"/></label>
          <label style="flex:1">GPT epochs<input id="tv-eps-g" type="number" value="15" min="2" max="40" style="width:100%;padding:6px;border:1px solid var(--border,#ccc);border-radius:5px;margin-top:3px"/></label>
        </div>
      </details>
      <div id="tv-progress" style="display:none;margin:10px 0">
        <div style="display:flex;justify-content:space-between;font-size:.8rem;color:var(--muted,#666);margin-bottom:4px">
          <span id="tv-stage-label">Starting…</span>
          <span id="tv-pct">0%</span>
        </div>
        <div style="height:6px;background:var(--border,#ccc);border-radius:3px;overflow:hidden">
          <div id="tv-bar" style="height:100%;width:0;background:linear-gradient(90deg,#4a9eff,#7ad4ff);transition:width .4s ease"></div>
        </div>
        <div id="tv-log" style="margin-top:8px;font-family:monospace;font-size:.72rem;color:var(--muted,#666);max-height:120px;overflow:auto;padding:6px;background:var(--surface,#f5f5f5);border-radius:5px"></div>
      </div>
      <div id="tv-status" style="font-size:.82rem;color:var(--muted,#666);margin-bottom:10px;min-height:1em"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="tv-cancel" style="padding:7px 14px;border:1px solid var(--border,#ccc);background:transparent;color:var(--text,#000);border-radius:6px;cursor:pointer">Close</button>
        <button id="tv-start" style="padding:7px 14px;border:none;background:#4a9eff;color:#fff;border-radius:6px;cursor:pointer;font-weight:600">Start training</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  const $ = (id) => modal.querySelector('#' + id);
  let aborter = null;

  let listPollTimer = null;
  // Per-row log-tail pollers. Cleared on re-render (otherwise stale rows
  // leak timers) and on close. _openRowExp tracks which rows are expanded
  // so a re-render can re-bind their log viewers.
  const _rowLogTimers = new Map();
  const _openRowExp = new Set();
  const stopAllRowLogTimers = () => {
    for (const t of _rowLogTimers.values()) clearInterval(t);
    _rowLogTimers.clear();
  };
  const close = () => {
    if (aborter) aborter.abort();
    if (listPollTimer) { clearInterval(listPollTimer); listPollTimer = null; }
    stopAllRowLogTimers();
    modal.remove();
  };
  $('tv-cancel').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  // Fetch and render any in-progress runs the user can resume. Re-polls
  // every 5s while the modal is open so the stage advances live (e.g.
  // user sees "format" → "SoVITS training" → "GPT training" without
  // having to close/reopen the modal).
  const fetchAndRender = async () => {
    try {
      const r = await apiFetch('/api/voices/sovits/training/list');
      if (!r.ok) return null;
      const data = await r.json();
      return (data.runs || []).filter(x => x.stage !== 'register');
    } catch { return null; }
  };
  (async () => {
    try {
      const runs = (await fetchAndRender()) || [];
      if (runs.length === 0) return;
      const stageLabels = {
        download: 'Downloading', slice: 'Slicing', asr: 'Transcribing',
        ref: 'Picking reference', format: 'Extracting features',
        train_sovits: 'SoVITS training', train_gpt: 'GPT training',
      };
      const fmtAge = (ms) => {
        const m = Math.floor((Date.now() - ms) / 60000);
        if (m < 60) return m + 'm ago';
        return Math.floor(m / 60) + 'h ago';
      };
      // Pipeline overall % per stage — matches the STAGE markers the
      // orchestrator emits. Used to render a progress bar on each row.
      const stagePct = {
        download: 5, trim: 10, denoise: 15, slice: 20, asr: 35, ref: 50,
        format: 55, train_sovits: 75, train_gpt: 95, register: 100,
      };
      const renderList = () => {
        const items = runs.map(r => {
          // A run whose workdir was touched in the last 90 seconds is almost
          // certainly still training. For those, show a pulsing green
          // "Live" badge and hide Resume so the user can't accidentally
          // spawn a duplicate pipeline.
          const ageMs = Date.now() - r.mtimeMs;
          const isLive = ageMs < 90_000;
          const stageLabel = esc(stageLabels[r.stage] || r.stage);
          const pct = stagePct[r.stage] ?? 0;
          const badge = isLive
            ? `<span style="display:inline-flex;align-items:center;gap:5px;padding:2px 7px;border-radius:10px;background:rgba(40,180,80,.18);color:#3fcf6f;font-size:.7rem;font-weight:600;margin-left:6px"><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#3fcf6f;animation:vsPulse 1.2s ease-in-out infinite"></span>LIVE</span>`
            : '';
          const actions = isLive
            ? `<button data-clear="${esc(r.name)}" title="Force-stop and delete this run" style="padding:5px 8px;border:1px solid var(--border,#ccc);background:transparent;color:var(--muted,#666);border-radius:5px;cursor:pointer;font-size:.95rem;line-height:1" onclick="event.stopPropagation()">×</button>`
            : `<button data-resume="${esc(r.name)}" style="padding:5px 10px;border:1px solid #4a9eff;background:transparent;color:#4a9eff;border-radius:5px;cursor:pointer;font-size:.78rem" onclick="event.stopPropagation()">Resume</button>
               <button data-clear="${esc(r.name)}" title="Delete this training run + free its disk" style="padding:5px 8px;border:1px solid var(--border,#ccc);background:transparent;color:var(--muted,#666);border-radius:5px;cursor:pointer;font-size:.95rem;line-height:1" onclick="event.stopPropagation()">×</button>`;
          const title = r.displayName || r.name;
          const subline = r.displayName
            ? `<span style="font-family:monospace;font-size:.7rem;color:var(--muted,#666);opacity:.7">${esc(r.name)}</span> · at <strong>${stageLabel}</strong> · ${pct}% · last touched ${fmtAge(r.mtimeMs)}`
            : `at <strong>${stageLabel}</strong> · ${pct}% · last touched ${fmtAge(r.mtimeMs)}`;
          return `
            <div data-row="${esc(r.name)}" style="border:1px solid var(--border,#ccc);border-radius:6px;margin-bottom:6px;font-size:.82rem;cursor:pointer;transition:background .15s" title="Click to view live log">
              <div style="display:flex;align-items:center;gap:6px;padding:8px">
                <div style="flex:1;min-width:0">
                  <div style="font-weight:600">${esc(title)}${badge}</div>
                  <div style="color:var(--muted,#666);font-size:.75rem">${subline}</div>
                </div>
                ${actions}
              </div>
              <div style="height:3px;background:var(--border,#eee);border-radius:0 0 5px 5px;overflow:hidden">
                <div style="height:100%;width:${pct}%;background:${isLive ? 'linear-gradient(90deg,#3fcf6f,#7ad4ff)' : 'linear-gradient(90deg,#4a9eff,#7ad4ff)'};transition:width .4s ease"></div>
              </div>
              <div data-log-pane="${esc(r.name)}" style="display:none;border-top:1px solid var(--border,#eee);padding:6px 10px;background:var(--surface,#f8f8f8);font-family:monospace;font-size:.7rem;color:var(--muted,#666);max-height:160px;overflow:auto;white-space:pre-wrap"></div>
            </div>
          `;
        }).join('');
        $('tv-incomplete').innerHTML = runs.length === 0 ? '' : `
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
            <div style="font-size:.78rem;color:var(--muted,#666)">In-progress training (resume to skip work already done):</div>
            <button id="tv-clear-all" style="border:none;background:transparent;color:var(--muted,#666);font-size:.74rem;cursor:pointer;text-decoration:underline">Clear all</button>
          </div>
          ${items}
        `;
        modal.querySelectorAll('[data-resume]').forEach(btn => {
          btn.addEventListener('click', () => {
            const expName = btn.getAttribute('data-resume');
            // Prefer the run's saved display name from _meta.json. If the
            // user typed something in the Voice name field, use that as an
            // override (lets people rename mid-resume if they want). Falls
            // back to a sane default only when both are missing.
            const run = runs.find(x => x.name === expName);
            const typed = $('tv-name').value.trim();
            const name = typed || (run && run.displayName) || expName;
            startTrainingRequest({ name, resumeExpName: expName });
          });
        });

        // Click row → toggle inline log viewer that polls the bridge's
        // /log endpoint every 2s. Lets the user re-attach to live progress
        // for a run they kicked off and walked away from.
        const startRowPoll = async (expName, pane) => {
          let since = 0;
          const poll = async () => {
            try {
              const r = await apiFetch('/api/voices/sovits/training/' + encodeURIComponent(expName) + '/log?since=' + since);
              if (!r.ok) return;
              const d = await r.json();
              if (since === 0) pane.textContent = '';
              if (d.content) {
                pane.textContent += d.content;
                pane.scrollTop = pane.scrollHeight;
              }
              since = d.size || since;
            } catch { /* */ }
          };
          pane.textContent = 'loading…';
          pane.style.display = 'block';
          await poll();
          const timer = setInterval(poll, 2000);
          _rowLogTimers.set(expName, timer);
        };
        modal.querySelectorAll('[data-row]').forEach(row => {
          const expName = row.getAttribute('data-row');
          // If this row was already expanded before the re-render, keep it
          // open and re-bind a fresh poller (the previous timer was cleared
          // by stopAllRowLogTimers on the renderList call).
          const pane = row.querySelector('[data-log-pane]');
          if (_openRowExp.has(expName) && pane) {
            startRowPoll(expName, pane);
          }
          row.addEventListener('click', async () => {
            if (!pane) return;
            if (pane.style.display === 'none' || pane.style.display === '') {
              _openRowExp.add(expName);
              await startRowPoll(expName, pane);
            } else {
              pane.style.display = 'none';
              _openRowExp.delete(expName);
              const t = _rowLogTimers.get(expName);
              if (t) { clearInterval(t); _rowLogTimers.delete(expName); }
            }
          });
        });
        modal.querySelectorAll('[data-clear]').forEach(btn => {
          btn.addEventListener('click', async () => {
            const expName = btn.getAttribute('data-clear');
            if (!confirm(`Delete training run ${expName}? This frees its disk and removes any partial checkpoints.`)) return;
            btn.disabled = true; btn.textContent = '…';
            try {
              const r = await apiFetch('/api/voices/sovits/training/' + encodeURIComponent(expName), { method: 'DELETE' });
              if (!r.ok) throw new Error('HTTP ' + r.status);
              const idx = runs.findIndex(x => x.name === expName);
              if (idx >= 0) runs.splice(idx, 1);
              renderList();
            } catch (e) {
              btn.disabled = false; btn.textContent = '×';
              alert('Delete failed: ' + e.message);
            }
          });
        });
        const clearAllBtn = $('tv-clear-all');
        if (clearAllBtn) clearAllBtn.addEventListener('click', async () => {
          if (!confirm(`Delete ALL ${runs.length} in-progress training runs?`)) return;
          clearAllBtn.disabled = true; clearAllBtn.textContent = 'clearing…';
          for (const r of runs.slice()) {
            try {
              await apiFetch('/api/voices/sovits/training/' + encodeURIComponent(r.name), { method: 'DELETE' });
            } catch { /* */ }
          }
          runs.length = 0;
          renderList();
        });
      };
      renderList();
      // Poll every 5s and refresh the list in place so the stage label
      // advances as training progresses. Stops on modal close. Each
      // re-render clears any open log-tail pollers; renderList rebinds
      // them for rows still in _openRowExp.
      listPollTimer = setInterval(async () => {
        const next = await fetchAndRender();
        if (!next) return;
        runs.length = 0;
        for (const r of next) runs.push(r);
        stopAllRowLogTimers();
        renderList();
      }, 5000);
    } catch { /* */ }
  })();

  async function startTrainingRequest({ name, resumeExpName }) {
    const url = $('tv-url').value.trim();
    const epsS = parseInt($('tv-eps-s').value) || 8;
    const epsG = parseInt($('tv-eps-g').value) || 15;
    if (!name) return ($('tv-status').textContent = 'Voice name required.');
    if (!resumeExpName && !url) return ($('tv-status').textContent = 'YouTube URL required.');
    $('tv-start').style.display = 'none';
    $('tv-incomplete').style.display = 'none';
    $('tv-status').textContent = resumeExpName ? `Resuming ${resumeExpName}…` : 'Submitting…';
    $('tv-progress').style.display = 'block';
    aborter = new AbortController();
    try {
      const body = { name, epochsSovits: epsS, epochsGpt: epsG };
      if (resumeExpName) {
        body.resumeExpName = resumeExpName;
      } else {
        body.sourceUrl = url;
        body.denoise = $('tv-denoise').checked;
      }
      const res = await apiFetch('/api/voices/sovits/train', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: aborter.signal,
      });
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nlnl;
        while ((nlnl = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, nlnl);
          buf = buf.slice(nlnl + 2);
          const ev = block.split('\n').reduce((acc, line) => {
            const m = line.match(/^(event|data):\s?(.*)$/);
            if (m) acc[m[1]] = (acc[m[1]] || '') + m[2];
            return acc;
          }, {});
          if (!ev.event) continue;
          let data = {};
          try { data = JSON.parse(ev.data || '{}'); } catch {}
          handleTrainEvent(ev.event, data);
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        $('tv-status').textContent = 'Failed: ' + e.message;
        $('tv-start').style.display = '';
      }
    }
  }

  $('tv-start').addEventListener('click', () => {
    startTrainingRequest({ name: $('tv-name').value.trim() });
  });

  function handleTrainEvent(event, data) {
    const logEl = $('tv-log');
    if (event === 'stage') {
      $('tv-stage-label').textContent = data.label || data.id;
      $('tv-pct').textContent = (data.pct || 0) + '%';
      $('tv-bar').style.width = (data.pct || 0) + '%';
      const eta = data.etaSec > 0 ? ` (~${Math.ceil(data.etaSec/60)} min)` : '';
      logEl.innerHTML += `<div style="color:#4a9eff">▸ ${esc(data.label || data.id)}${eta}</div>`;
    } else if (event === 'log') {
      const cls = data.stderr ? 'color:#c66' : 'color:var(--muted,#666)';
      logEl.innerHTML += `<div style="${cls}">${esc(data.line || '')}</div>`;
    } else if (event === 'done') {
      $('tv-bar').style.width = '100%';
      $('tv-pct').textContent = '100%';
      $('tv-stage-label').textContent = 'Done';
      $('tv-status').innerHTML = `&#10003; <strong>${esc(data.name)}</strong> trained (${data.elapsed_sec ? Math.ceil(data.elapsed_sec/60) + ' min' : 'ok'}). Refreshing voice picker…`;
      refreshClonedVoices().then(() => updateStatusBar?.());
      $('tv-cancel').textContent = 'Close';
      $('tv-start').style.display = 'none';
    } else if (event === 'error') {
      $('tv-status').textContent = '⚠ ' + (data.message || 'training failed');
      $('tv-start').style.display = '';
    }
    logEl.scrollTop = logEl.scrollHeight;
  }
}

