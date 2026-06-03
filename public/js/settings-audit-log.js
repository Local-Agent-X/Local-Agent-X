// Settings: Audit Log — recent tamper-evident audit entries + hash-chain verify.
// Mirrors settings-run-traces.js (sibling Security-tab panel). Backed by the
// ari-kernel cryptographic audit log over /api/security/audit + /api/audit/verify.

function escapeHtmlAL(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function decisionBadgeAL(decision) {
  const color = decision === 'allow' ? '#138a36'
    : decision === 'block' ? '#b3261e'
    : decision === 'warn' ? '#a36a00'
    : '#6b6b6b';
  return `<span style="color:${color};font-weight:600">${escapeHtmlAL(decision)}</span>`;
}

function renderAuditSummary(summary) {
  if (!summary || !summary.totalEntries) return '';
  const d = summary.decisions || {};
  const parts = Object.keys(d).map((k) => `${escapeHtmlAL(k)}: ${escapeHtmlAL(d[k])}`);
  return `<div style="font-family:var(--mono);font-size:.72rem;color:var(--muted);margin-bottom:8px">
    ${escapeHtmlAL(summary.totalEntries)} entries · ${parts.join(' · ')}
  </div>`;
}

function renderAuditEntries(entries) {
  if (!entries || entries.length === 0) {
    return '<div style="color:var(--muted);padding:8px 0">No audit entries yet.</div>';
  }
  return entries.map((e) => {
    const when = new Date(e.timestamp).toLocaleString();
    const tool = e.toolName ? ` · ${escapeHtmlAL(e.toolName)}` : '';
    const level = e.threatLevel ? ` · ${escapeHtmlAL(e.threatLevel)}` : '';
    const role = e.role ? ` · ${escapeHtmlAL(e.role)}` : '';
    return `<div style="padding:6px 0;border-bottom:1px solid var(--border)">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span style="font-family:var(--mono);font-size:.72rem;color:var(--muted)">#${escapeHtmlAL(e.seq)} · ${escapeHtmlAL(when)}</span>
        <strong>${escapeHtmlAL(e.event)}</strong>${tool}
        <span>${decisionBadgeAL(e.decision)}</span>
        <span style="color:var(--muted);font-size:.72rem">${role}${level}</span>
      </div>
      <div style="font-size:.72rem;color:var(--muted);margin-top:2px">${escapeHtmlAL(e.reason || '')}</div>
    </div>`;
  }).join('');
}

async function loadAuditLog() {
  const host = document.getElementById('audit-log-list');
  if (!host) return;
  host.textContent = 'Loading...';
  try {
    const [entriesRes, summaryRes] = await Promise.all([
      apiFetch('/api/security/audit?pageSize=50&sortOrder=desc'),
      apiFetch('/api/security/audit/summary'),
    ]);
    if (!entriesRes.ok) { host.textContent = 'Could not load audit log.'; return; }
    const page = await entriesRes.json();
    let summaryHtml = '';
    if (summaryRes.ok) {
      try { summaryHtml = renderAuditSummary(await summaryRes.json()); }
      catch (e) { summaryHtml = ''; }
    }
    host.innerHTML = summaryHtml + renderAuditEntries(page.entries || []);
  } catch (e) {
    host.textContent = 'Could not load audit log: ' + e.message;
  }
}

async function verifyAuditChain() {
  const out = document.getElementById('audit-verify-result');
  if (!out) return;
  const date = new Date().toISOString().slice(0, 10);
  out.textContent = 'Verifying...';
  try {
    const res = await apiFetch(`/api/audit/verify?date=${encodeURIComponent(date)}`);
    if (!res.ok) { out.textContent = 'Could not verify chain.'; return; }
    const r = await res.json();
    if (r.valid) {
      out.innerHTML = `<span style="color:#138a36;font-weight:600">✓ Chain intact</span> <span style="color:var(--muted)">(${escapeHtmlAL(r.total)} entries for ${escapeHtmlAL(date)})</span>`;
    } else {
      const at = (r.brokenAt !== undefined && r.brokenAt !== null) ? ` at entry #${escapeHtmlAL(r.brokenAt)}` : '';
      out.innerHTML = `<span style="color:#b3261e;font-weight:600">✗ Chain TAMPERED</span><span style="color:var(--muted)">${escapeHtmlAL(at)} (${escapeHtmlAL(r.total)} entries for ${escapeHtmlAL(date)})</span>`;
    }
  } catch (e) {
    out.textContent = 'Could not verify chain: ' + e.message;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('audit-log-list')) loadAuditLog();
});

// Expose the pure render functions for unit tests (no-op effect in the browser,
// where the bare declarations above already serve inline onclick handlers).
if (typeof window !== 'undefined') {
  window.renderAuditEntries = renderAuditEntries;
  window.renderAuditSummary = renderAuditSummary;
}
