// ── Settings: Usage dashboard + spending limits ──
//
// Reads GET /api/usage and renders an honest, per-connection view:
//   • API key (real money)   → company name (Anthropic / OpenAI / xAI), real $,
//                               and a per-model daily-limit picker.
//   • Subscription (oauth)   → consumer brand (Claude / ChatGPT / Grok), cost
//                               shown as "≈ est." (flat-rate — never capped).
//   • Local (Ollama)         → "Local", token counts only, marked Free.
// Budgets write through the canonical /api/settings POST (per-control), and the
// per-model map is sent whole (the server shallow-merges).

let _modelBudgets = {};   // model -> daily USD limit (api-key models only)

function fmtUsd(n) {
  const v = Number(n) || 0;
  return v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`;
}
function fmtTokens(n) {
  const v = Number(n) || 0;
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
}

// (provider, billable) → the label a subscriber/buyer actually recognizes.
function connectionLabel(provider, billable) {
  if (provider === 'local') return 'Local';
  if (billable) {
    return ({ anthropic: 'Anthropic', openai: 'OpenAI', xai: 'xAI', gemini: 'Google', cerebras: 'Cerebras', 'ollama-cloud': 'Ollama Cloud' })[provider] || provider;
  }
  return ({ anthropic: 'Claude', xai: 'Grok', codex: 'ChatGPT' })[provider] || provider;
}

// api = real money + cappable; sub = subscription estimate; local = free.
function modelCategory(entry) {
  if (entry.provider === 'local') return 'local';
  return entry.billable ? 'api' : 'sub';
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

  _modelBudgets = { ...(data.budgets?.modelDailyBudgetsUsd || {}) };

  const subscription = data.authMode === 'subscription';
  const note = document.getElementById('usage-mode-note');
  if (note) {
    note.textContent = subscription
      ? 'On a flat-rate subscription, dollars are an estimate of API-equivalent cost, not what you pay.'
      : data.authMode === 'api-key'
        ? 'On a per-call API key — these are real costs.'
        : data.authMode === 'local'
          ? 'Running a local model — usage is free; token counts are shown for reference.'
          : '';
  }

  // Headline stats.
  const costLabel = subscription ? 'Est. API-equivalent' : data.authMode === 'local' ? 'Cost' : 'Real spend';
  const costValue = subscription ? data.shadowUsd : data.billableUsd;
  const stats = [
    ['Input tokens', fmtTokens(data.inputTokens)],
    ['Output tokens', fmtTokens(data.outputTokens)],
    [costLabel, data.authMode === 'local' && (data.billableUsd + data.shadowUsd) === 0 ? 'Free' : `${subscription ? '≈ ' : ''}${fmtUsd(costValue)}`],
  ];
  const statsEl = document.getElementById('usage-stats');
  if (statsEl) {
    statsEl.innerHTML = stats.map(([label, val]) =>
      `<div><div style="font-size:1.15rem;color:var(--accent)">${val}</div>` +
      `<div style="font-size:.62rem;color:var(--muted);letter-spacing:.5px;text-transform:uppercase">${label}</div></div>`
    ).join('');
  }

  // By-model table — labeled by connection, cost framed by category.
  const byModel = data.byModel || {};
  const rows = Object.entries(byModel).sort((a, b) => (b[1].cost || 0) - (a[1].cost || 0));
  const tableEl = document.getElementById('usage-by-model');
  if (tableEl) {
    if (rows.length === 0) {
      tableEl.innerHTML = '<div style="font-size:.75rem;color:var(--muted)">No usage in this period yet.</div>';
    } else {
      const head = `<tr style="background:var(--bg)">
        <th style="padding:6px 10px;text-align:left;color:var(--accent);font-size:.6rem">CONNECTION</th>
        <th style="padding:6px 10px;text-align:left;color:var(--muted);font-size:.6rem">MODEL</th>
        <th style="padding:6px 10px;text-align:right;color:var(--muted);font-size:.6rem">INPUT</th>
        <th style="padding:6px 10px;text-align:right;color:var(--muted);font-size:.6rem">OUTPUT</th>
        <th style="padding:6px 10px;text-align:right;color:var(--muted);font-size:.6rem">COST</th></tr>`;
      const body = rows.map(([model, m]) => {
        const cat = modelCategory(m);
        const costCell = cat === 'local' ? 'Free' : cat === 'sub' ? `≈ ${fmtUsd(m.cost)}` : fmtUsd(m.cost);
        const capped = cat === 'api' && (_modelBudgets[model] ?? 0) > 0 ? ` <span style="color:var(--accent)">· cap ${fmtUsd(_modelBudgets[model])}</span>` : '';
        return `<tr><td style="padding:6px 10px">${connectionLabel(m.provider, m.billable)}</td>` +
          `<td style="padding:6px 10px">${model}</td>` +
          `<td style="padding:6px 10px;text-align:right">${fmtTokens(m.input)}</td>` +
          `<td style="padding:6px 10px;text-align:right">${fmtTokens(m.output)}</td>` +
          `<td style="padding:6px 10px;text-align:right">${costCell}${capped}</td></tr>`;
      }).join('');
      tableEl.innerHTML =
        `<div style="font-size:.68rem;border:1px solid var(--border);border-radius:8px;overflow:hidden">
          <table style="width:100%;border-collapse:collapse;font-family:var(--mono)">${head}${body}</table></div>`;
    }
  }

  // Per-model limit picker — only API-key (billable, non-local) models.
  const pick = document.getElementById('usage-model-pick');
  if (pick) {
    const apiModels = rows.filter(([, m]) => m.billable && m.provider !== 'local').map(([model, m]) => ({ model, provider: m.provider }));
    const prev = pick.value;
    pick.innerHTML = '<option value="">Pick an API model…</option>' +
      apiModels.map(({ model, provider }) => `<option value="${model}">${connectionLabel(provider, true)} — ${model}</option>`).join('');
    if (apiModels.some(a => a.model === prev)) pick.value = prev;
    onUsageModelPick();
  }

  // Global budget inputs.
  const daily = document.getElementById('cfg-daily-budget');
  const session = document.getElementById('cfg-session-budget');
  if (daily) daily.value = data.budgets?.dailyBudgetUsd ?? 0;
  if (session) session.value = data.budgets?.sessionBudgetUsd ?? 0;
}

function onUsageModelPick() {
  const pick = document.getElementById('usage-model-pick');
  const input = document.getElementById('usage-model-limit');
  if (!pick || !input) return;
  const model = pick.value;
  input.style.display = model ? '' : 'none';
  if (model) input.value = _modelBudgets[model] ?? 0;
}

async function saveModelBudget() {
  const pick = document.getElementById('usage-model-pick');
  const input = document.getElementById('usage-model-limit');
  if (!pick?.value || !input) return;
  const model = pick.value;
  const n = Math.max(0, Number(input.value) || 0);
  // Send the whole map — the server shallow-merges, so a partial would drop the rest.
  const next = { ..._modelBudgets };
  if (n > 0) next[model] = n; else delete next[model];

  const status = document.getElementById('usage-budget-status');
  try {
    const r = await apiFetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelDailyBudgetsUsd: next }),
    });
    if (!r.ok) throw new Error('save failed');
    _modelBudgets = next;
    if (status) {
      status.textContent = n > 0 ? `Saved — ${model} capped at ${fmtUsd(n)}/day.` : `Saved — ${model} limit removed.`;
      setTimeout(() => { if (status) status.textContent = ''; }, 3000);
    }
    loadUsage(); // refresh the "· cap" markers
  } catch (e) {
    if (status) status.textContent = 'Could not save model limit.';
    console.warn('[usage] model budget save failed', e);
  }
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
