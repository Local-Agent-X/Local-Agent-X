// ── Settings → Usage: "Where it went" ──
//
// The runs that used the most tokens, from GET /api/usage/runs (usage-report/):
// what each was, why it ran (you typed, a build decision, a review, a finish
// fix…), its calls, how big they got, how much came from cache, and a plain
// flag for what stands out. Clicking a run loads GET /api/usage/runs/<opId>: its
// calls one by one, the tools it used, and what its biggest prompt was made of.
// Titles come from task text anyone could have written, so every string is
// escaped (esc, shared-escape.js).

function _runsTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${Math.round(v / 1e3)}K`;
  return String(v);
}
function _runsPct(part, whole) {
  return whole > 0 ? `${Math.round((100 * part) / whole)}%` : '—';
}
const _RUNS_CELL = 'padding:6px 8px;vertical-align:top';
const _RUNS_HEAD = 'padding:6px 8px;color:var(--muted);font-size:.6rem;text-align:left';

async function loadUsageRuns() {
  const box = document.getElementById('usage-runs');
  if (!box) return;
  const hours = document.getElementById('usage-runs-hours')?.value || '24';
  box.innerHTML = '<div style="font-size:.75rem;color:var(--muted)">Reading runs…</div>';
  let data;
  try {
    const r = await apiFetch(`/api/usage/runs?hours=${encodeURIComponent(hours)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    data = await r.json();
  } catch (e) {
    box.innerHTML = '<div style="font-size:.75rem;color:var(--muted)">Could not read runs.</div>';
    console.warn('[usage-runs] load failed', e);
    return;
  }
  if (!data.runs || data.runs.length === 0) {
    box.innerHTML = '<div style="font-size:.75rem;color:var(--muted)">No model calls in this window.</div>';
    return;
  }
  const t = data.total;
  const totals = `<div style="font-size:.75rem;color:var(--muted);margin-bottom:10px">${esc(String(t.runs))} runs · ${_runsTokens(t.promptTokens)} input (${_runsPct(t.cachedTokens, t.promptTokens)} from cache) · ${_runsTokens(t.outputTokens)} output · ≈ ${esc(fmtUsd(t.apiPriceUsd))} at API prices</div>`;
  const groups = data.groups.map((g) =>
    `<tr><td style="${_RUNS_CELL}">${esc(g.reason)}</td><td style="${_RUNS_CELL};text-align:right">${g.runs}</td>` +
    `<td style="${_RUNS_CELL};text-align:right">${_runsTokens(g.promptTokens)}</td><td style="${_RUNS_CELL};text-align:right">≈ ${esc(fmtUsd(g.apiPriceUsd))}</td></tr>`).join('');
  const runs = data.runs.map((run) =>
    `<tr class="usage-run-row" data-op="${esc(run.opId)}" style="cursor:pointer;border-top:1px solid var(--border)">` +
    `<td style="${_RUNS_CELL}"><div>${esc(run.reason)}${run.project ? ` · ${esc(run.project)}` : ''}</div><div style="color:var(--muted)">${esc(run.title || '')}</div>` +
    (run.flags.length ? `<div style="color:var(--accent);margin-top:2px">${run.flags.map(esc).join(' · ')}</div>` : '') + `</td>` +
    `<td style="${_RUNS_CELL}">${esc(run.model || '')}</td>` +
    `<td style="${_RUNS_CELL};text-align:right">${run.calls}</td>` +
    `<td style="${_RUNS_CELL};text-align:right">${_runsTokens(run.promptTokens)}</td>` +
    `<td style="${_RUNS_CELL};text-align:right">${_runsPct(run.cachedTokens, run.promptTokens)}</td>` +
    `<td style="${_RUNS_CELL};text-align:right">${_runsTokens(run.peakPromptTokens)}</td>` +
    `<td style="${_RUNS_CELL};text-align:right">≈ ${esc(fmtUsd(run.apiPriceUsd))}</td></tr>` +
    `<tr class="usage-run-detail" data-for="${esc(run.opId)}" style="display:none"><td colspan="7" style="${_RUNS_CELL}"></td></tr>`).join('');
  box.innerHTML = totals +
    `<div style="font-size:.68rem;border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:14px"><table style="width:100%;border-collapse:collapse">` +
    `<tr style="background:var(--bg)"><th style="${_RUNS_HEAD}">WHY IT RAN</th><th style="${_RUNS_HEAD};text-align:right">RUNS</th><th style="${_RUNS_HEAD};text-align:right">INPUT</th><th style="${_RUNS_HEAD};text-align:right">AT API PRICES</th></tr>${groups}</table></div>` +
    `<div style="font-size:.68rem;border:1px solid var(--border);border-radius:8px;overflow:hidden"><table style="width:100%;border-collapse:collapse">` +
    `<tr style="background:var(--bg)"><th style="${_RUNS_HEAD}">RUN</th><th style="${_RUNS_HEAD}">MODEL</th><th style="${_RUNS_HEAD};text-align:right">CALLS</th><th style="${_RUNS_HEAD};text-align:right">INPUT</th><th style="${_RUNS_HEAD};text-align:right">CACHED</th><th style="${_RUNS_HEAD};text-align:right">BIGGEST CALL</th><th style="${_RUNS_HEAD};text-align:right">AT API PRICES</th></tr>${runs}</table></div>`;
  box.querySelectorAll('.usage-run-row').forEach((row) => row.addEventListener('click', () => toggleUsageRun(row.getAttribute('data-op'))));
}

async function toggleUsageRun(opId) {
  const cell = document.querySelector(`.usage-run-detail[data-for="${CSS.escape(opId)}"]`);
  if (!cell) return;
  if (cell.style.display !== 'none') { cell.style.display = 'none'; return; }
  cell.style.display = '';
  const td = cell.firstElementChild;
  td.innerHTML = '<span style="color:var(--muted)">Reading the run…</span>';
  try {
    const r = await apiFetch(`/api/usage/runs/${encodeURIComponent(opId)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    td.innerHTML = renderUsageRunDetail(await r.json());
  } catch (e) {
    td.innerHTML = '<span style="color:var(--muted)">Could not read this run.</span>';
    console.warn('[usage-runs] detail failed', e);
  }
}

function renderUsageRunDetail(d) {
  const peak = Math.max(1, ...d.calls.map((c) => c.promptTokens));
  // One bar per call: its prompt's size against the biggest, the cached part darker.
  const bars = d.calls.map((c) =>
    `<div title="call ${c.turnIdx + 1}: ${_runsTokens(c.promptTokens)} in (${_runsPct(c.cachedTokens, c.promptTokens)} cached), ${_runsTokens(c.outputTokens)} out${c.tools.length ? ' · ' + esc(c.tools.map((t) => t.tool).join(', ')) : ''}" ` +
    `style="flex:1;min-width:2px;display:flex;flex-direction:column;justify-content:flex-end;height:60px">` +
    `<div style="height:${Math.round((60 * c.promptTokens) / peak)}px;background:var(--accent);opacity:.35;position:relative">` +
    `<div style="position:absolute;bottom:0;left:0;right:0;height:${c.promptTokens > 0 ? Math.round((100 * c.cachedTokens) / c.promptTokens) : 0}%;background:var(--accent);opacity:1"></div></div></div>`).join('');
  const tools = Object.entries(d.toolCounts).sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([name, n]) => `${esc(name)} ×${n}`).join(' · ');
  const big = d.biggestCall;
  const makeup = !big ? '' : big.makeup
    ? `<div style="margin-top:10px"><div style="color:var(--muted);margin-bottom:4px">Biggest call (${_runsTokens(big.promptTokens)}), made of:</div>` +
      big.makeup.map((p) => `<div style="display:flex;gap:8px;align-items:center"><div style="width:180px">${esc(p.source)}</div>` +
        `<div style="flex:1;background:var(--bg);height:8px;border-radius:4px;overflow:hidden"><div style="width:${_runsPct(p.tokens, big.promptTokens)};height:100%;background:var(--accent)"></div></div>` +
        `<div style="width:110px;text-align:right">${_runsTokens(p.tokens)} · ${_runsPct(p.tokens, big.promptTokens)}</div></div>`).join('') + '</div>'
    : `<div style="margin-top:10px;color:var(--muted)">What the biggest call held isn't recorded for this run.</div>`;
  return `<div style="color:var(--muted);margin-bottom:4px">${d.calls.length} calls, each bar one call's prompt (darker: from cache).</div>` +
    `<div style="display:flex;gap:1px;align-items:flex-end">${bars}</div>` +
    (tools ? `<div style="margin-top:8px"><span style="color:var(--muted)">Tools:</span> ${tools}</div>` : '') + makeup;
}
