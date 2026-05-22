// Settings: Run Traces — recent agent runs + expandable tool-call timelines.
// Matches the visual idiom of settings-rollback.js (sibling card).

function escapeHtmlRT(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function statusBadgeRT(status) {
  const color = status === 'succeeded' ? '#138a36'
    : status === 'failed' ? '#b3261e'
    : status === 'cancelled' ? '#6b6b6b'
    : '#a36a00';
  return `<span style="color:${color};font-weight:600">${escapeHtmlRT(status)}</span>`;
}

function fmtDurationRT(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

function fmtArgsRT(s) {
  if (!s) return '(none)';
  try { return JSON.stringify(JSON.parse(s), null, 2); }
  catch { return s; }
}

function renderTraceTimeline(events) {
  if (!events || events.length === 0) {
    return '<div style="color:var(--muted);padding:8px 0">No trace events recorded for this run.</div>';
  }
  // Pair started/completed by toolCallId so the row carries both decision and outcome.
  const startMap = new Map();
  const rows = [];
  for (const ev of events) {
    if (ev.type === 'run_start') {
      rows.push({ kind: 'run_start', ts: ev.ts, role: ev.role, task: ev.task });
    } else if (ev.type === 'run_end') {
      rows.push({ kind: 'run_end', ts: ev.ts, status: ev.status, tokensUsed: ev.tokensUsed });
    } else if (ev.type === 'tool_call_started') {
      startMap.set(ev.toolCallId, ev);
      rows.push({ kind: 'tool', ts: ev.ts, start: ev, end: null });
    } else if (ev.type === 'tool_call_completed') {
      const start = startMap.get(ev.toolCallId);
      const row = rows.find((r) => r.kind === 'tool' && r.start && r.start.toolCallId === ev.toolCallId && !r.end);
      if (row) row.end = ev;
      else rows.push({ kind: 'tool', ts: ev.ts, start, end: ev });
    }
  }
  return rows.map((r, i) => {
    const when = new Date(r.ts).toLocaleTimeString();
    if (r.kind === 'run_start') {
      return `<div style="padding:6px 0;border-bottom:1px dashed var(--border);font-family:var(--mono);font-size:.72rem;color:var(--muted)">
        ${escapeHtmlRT(when)} · run_start (${escapeHtmlRT(r.role)}) — ${escapeHtmlRT((r.task || '').slice(0, 120))}
      </div>`;
    }
    if (r.kind === 'run_end') {
      const tok = r.tokensUsed ? ` · ${r.tokensUsed} tokens` : '';
      return `<div style="padding:6px 0;border-top:1px dashed var(--border);font-family:var(--mono);font-size:.72rem;color:var(--muted)">
        ${escapeHtmlRT(when)} · run_end · ${statusBadgeRT(r.status)}${escapeHtmlRT(tok)}
      </div>`;
    }
    const start = r.start;
    const end = r.end;
    const okIcon = end ? (end.ok ? '✓' : '✗') : '…';
    const okColor = end ? (end.ok ? '#138a36' : '#b3261e') : '#a36a00';
    const dur = end ? fmtDurationRT(end.durationMs) : '(running)';
    const detailId = `rt-detail-${i}-${Math.random().toString(36).slice(2, 7)}`;
    const argsBody = start ? fmtArgsRT(start.args) : '(no start event)';
    const resBody = end
      ? (end.error ? `error: ${end.error}\n\n${end.resultPreview || ''}` : (end.resultPreview || '(empty)'))
      : '(pending)';
    return `<div style="padding:6px 0;border-bottom:1px solid var(--border)">
      <div style="display:flex;align-items:center;gap:8px;cursor:pointer" onclick="(function(el){var d=document.getElementById('${detailId}');d.style.display=d.style.display==='none'?'block':'none';})(this)">
        <span style="color:${okColor};font-weight:700;width:14px">${okIcon}</span>
        <span style="font-family:var(--mono);font-size:.72rem;color:var(--muted)">${escapeHtmlRT(when)}</span>
        <strong>${escapeHtmlRT(start ? start.toolName : '?')}</strong>
        <span style="color:var(--muted);font-size:.72rem">${escapeHtmlRT(start ? start.risk : '')} · ${escapeHtmlRT(start ? start.decision : '')} · ${escapeHtmlRT(dur)}</span>
      </div>
      <div id="${detailId}" style="display:none;margin-top:6px;padding:6px 10px;background:#f7f7f7;border-radius:4px;border:1px solid var(--border)">
        <div style="font-size:.7rem;color:var(--muted);margin-bottom:2px">args</div>
        <pre style="margin:0 0 8px 0;font-family:var(--mono);font-size:.7rem;white-space:pre-wrap;word-break:break-word">${escapeHtmlRT(argsBody)}</pre>
        <div style="font-size:.7rem;color:var(--muted);margin-bottom:2px">result</div>
        <pre style="margin:0;font-family:var(--mono);font-size:.7rem;white-space:pre-wrap;word-break:break-word">${escapeHtmlRT(resBody)}</pre>
      </div>
    </div>`;
  }).join('');
}

async function loadRunTrace(runId, host) {
  host.innerHTML = '<div style="color:var(--muted);padding:6px 0">Loading trace...</div>';
  try {
    const r = await apiFetch(`/api/runs/${encodeURIComponent(runId)}/trace`);
    if (!r.ok) { host.textContent = 'Could not load trace.'; return; }
    const d = await r.json();
    host.innerHTML = renderTraceTimeline(d.events || []);
  } catch (e) {
    host.textContent = 'Could not load trace: ' + e.message;
  }
}

function toggleRunTrace(runId, btn) {
  const host = document.getElementById(`run-trace-${runId}`);
  if (!host) return;
  if (host.style.display === 'none' || host.style.display === '') {
    host.style.display = 'block';
    btn.textContent = 'Collapse';
    if (!host.dataset.loaded) {
      host.dataset.loaded = '1';
      loadRunTrace(runId, host);
    }
  } else {
    host.style.display = 'none';
    btn.textContent = 'Expand';
  }
}

async function loadRunTracesList() {
  const host = document.getElementById('run-traces-list');
  if (!host) return;
  host.textContent = 'Loading...';
  try {
    const res = await apiFetch('/api/runs/recent?limit=20');
    if (!res.ok) { host.textContent = 'Could not load runs.'; return; }
    const { runs } = await res.json();
    if (!runs || runs.length === 0) {
      host.innerHTML = '<span style="color:var(--muted)">No agent runs yet. Spawn one and refresh.</span>';
      return;
    }
    host.innerHTML = runs.map((r) => {
      const when = new Date(r.startedAt).toLocaleString();
      const dur = r.completedAt && r.completedAt > r.startedAt
        ? fmtDurationRT(r.completedAt - r.startedAt) : '—';
      return `<div style="padding:8px 0;border-bottom:1px solid var(--border)">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="flex:1;min-width:0">
            <div style="font-family:var(--mono);font-size:.72rem;color:var(--muted)">${escapeHtmlRT(r.id)} · ${escapeHtmlRT(when)} · ${escapeHtmlRT(dur)}</div>
            <div><strong>${escapeHtmlRT(r.name || r.role || 'agent')}</strong> <span style="color:var(--muted)">(${escapeHtmlRT(r.role || '')})</span> · ${statusBadgeRT(r.status)}</div>
            <div style="font-size:.72rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtmlRT(r.task || '')}</div>
          </div>
          <div>
            <button class="action-btn" style="font-size:.7rem;padding:3px 10px" onclick="toggleRunTrace('${escapeHtmlRT(r.id)}', this)">Expand</button>
          </div>
        </div>
        <div id="run-trace-${escapeHtmlRT(r.id)}" style="display:none;margin-top:6px;padding-left:8px"></div>
      </div>`;
    }).join('');
  } catch (e) {
    host.textContent = 'Could not load runs: ' + e.message;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('run-traces-list')) loadRunTracesList();
});
