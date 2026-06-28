// ── Settings: Usage dashboard + spending limits ──
//
// Reads GET /api/usage (tokens, billable vs shadow cost, byModel, auth mode,
// budgets) and renders an honest view: a subscription (oauth) user pays a flat
// rate, so dollars are shown as an ESTIMATE ("what this would cost on the API"),
// never as a bill. Budget inputs write through the canonical /api/settings POST
// (per-control, like settings-tool-policy.js) — not the localStorage sweep.

function fmtUsd(n) {
  const v = Number(n) || 0;
  return v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`;
}
function fmtTokens(n) {
  const v = Number(n) || 0;
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
}

async function loadUsage() {
  const period = document.getElementById('usage-period')?.value || 'today';
  let data;
  try {
    const r = await apiFetch(`/api/usage?period=${encodeURIComponent(period)}`);
    if (!r.ok) throw new Error('load failed');
    data = await r.json();
  } catch (e) {
    const s = document.getElementById('usage-stats');
    if (s) s.textContent = 'Usage unavailable.';
    console.warn('[usage] load failed', e);
    return;
  }

  const subscription = data.authMode === 'subscription';
  const note = document.getElementById('usage-mode-note');
  if (note) {
    note.textContent = subscription
      ? 'You’re on a flat-rate subscription, so dollar figures are an estimate of API-equivalent cost, not what you pay.'
      : data.authMode === 'api-key'
        ? 'You’re on a per-call API key, so these are real costs.'
        : '';
  }

  // Headline stats. For a subscription user the cost is the shadow estimate.
  const costLabel = subscription ? 'Est. API-equivalent' : 'Real spend';
  const costValue = subscription ? data.shadowUsd : data.billableUsd;
  const stats = [
    ['Input tokens', fmtTokens(data.inputTokens)],
    ['Output tokens', fmtTokens(data.outputTokens)],
    [costLabel, `${subscription ? '≈ ' : ''}${fmtUsd(costValue)}`],
  ];
  if (subscription && data.billableUsd > 0) stats.push(['Real spend (API-key)', fmtUsd(data.billableUsd)]);
  const statsEl = document.getElementById('usage-stats');
  if (statsEl) {
    statsEl.innerHTML = stats.map(([label, val]) =>
      `<div><div style="font-size:1.15rem;color:var(--accent)">${val}</div>` +
      `<div style="font-size:.62rem;color:var(--muted);letter-spacing:.5px;text-transform:uppercase">${label}</div></div>`
    ).join('');
  }

  // By-model breakdown.
  const byModel = data.byModel || {};
  const rows = Object.entries(byModel).sort((a, b) => (b[1].cost || 0) - (a[1].cost || 0));
  const tableEl = document.getElementById('usage-by-model');
  if (tableEl) {
    if (rows.length === 0) {
      tableEl.innerHTML = '<div style="font-size:.75rem;color:var(--muted)">No usage in this period yet.</div>';
    } else {
      const head = `<tr style="background:var(--bg)">
        <th style="padding:6px 10px;text-align:left;color:var(--accent);font-size:.6rem">MODEL</th>
        <th style="padding:6px 10px;text-align:right;color:var(--muted);font-size:.6rem">INPUT</th>
        <th style="padding:6px 10px;text-align:right;color:var(--muted);font-size:.6rem">OUTPUT</th>
        <th style="padding:6px 10px;text-align:right;color:var(--muted);font-size:.6rem">${subscription ? 'EST.' : 'COST'}</th></tr>`;
      const body = rows.map(([model, m]) =>
        `<tr><td style="padding:6px 10px">${model}</td>` +
        `<td style="padding:6px 10px;text-align:right">${fmtTokens(m.input)}</td>` +
        `<td style="padding:6px 10px;text-align:right">${fmtTokens(m.output)}</td>` +
        `<td style="padding:6px 10px;text-align:right">${subscription ? '≈ ' : ''}${fmtUsd(m.cost)}</td></tr>`
      ).join('');
      tableEl.innerHTML =
        `<div style="font-size:.68rem;border:1px solid var(--border);border-radius:8px;overflow:hidden">
          <table style="width:100%;border-collapse:collapse;font-family:var(--mono)">${head}${body}</table></div>`;
    }
  }

  // Populate budget inputs from the live config.
  const daily = document.getElementById('cfg-daily-budget');
  const session = document.getElementById('cfg-session-budget');
  if (daily) daily.value = data.budgets?.dailyBudgetUsd ?? 0;
  if (session) session.value = data.budgets?.sessionBudgetUsd ?? 0;
}

async function saveBudget(field, value) {
  const n = Math.max(0, Number(value) || 0);
  const status = document.getElementById('usage-budget-status');
  try {
    const r = await apiFetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: n }),
    });
    if (!r.ok) throw new Error('save failed');
    if (status) {
      status.textContent = n > 0 ? `Saved — ${field === 'dailyBudgetUsd' ? 'daily' : 'session'} limit ${fmtUsd(n)}.` : 'Saved — limit off.';
      setTimeout(() => { if (status) status.textContent = ''; }, 3000);
    }
  } catch (e) {
    if (status) status.textContent = 'Could not save limit.';
    console.warn('[usage] budget save failed', e);
  }
}
