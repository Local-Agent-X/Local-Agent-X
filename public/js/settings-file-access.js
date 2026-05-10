// ── Settings: File Access Mode + Tool Approval Mode ──
//
// "What can the agent touch?" controls — file access mode (workspace /
// expanded / unrestricted) and tool-approval mode (auto / ask-once /
// always-ask). Both persist to ~/.lax/settings.json and are read by the
// security layer + approval-manager on every tool call.

// ── File Access Mode ──

const FILE_ACCESS_HINTS = {
  workspace: 'Strict: agent can only read project files and memory. Most secure.',
  common: 'Default: agent can also read Downloads, Documents, Desktop, Pictures.',
  unrestricted: 'Full access: agent can read any file on your computer. Use with trust.'
};

async function loadFileAccessMode() {
  try {
    const r = await fetch(`${API}/api/security/file-access`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    const d = await r.json();
    const sel = document.getElementById('cfg-file-access');
    if (sel) sel.value = d.mode || 'common';
    const hint = document.getElementById('file-access-hint');
    if (hint) hint.textContent = FILE_ACCESS_HINTS[d.mode] || '';
  } catch {}
}

async function setFileAccessMode(mode) {
  const hint = document.getElementById('file-access-hint');
  if (hint) hint.textContent = FILE_ACCESS_HINTS[mode] || '';
  try {
    await fetch(`${API}/api/security/file-access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ mode })
    });
  } catch {}
}

async function setApprovalMode(mode) {
  // Save via the generic /api/settings endpoint (merged into settings.json).
  // approval-manager.ts reads settings.json.toolApproval on every tool call.
  try {
    await apiFetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolApproval: mode })
    });
  } catch (e) { console.warn('[approval-mode] save failed', e); }
}

// Load saved approval mode on settings page open
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const res = await apiFetch('/api/settings');
    if (!res.ok) return;
    const s = await res.json();
    if (s?.toolApproval) {
      const el = document.getElementById('cfg-approval-mode');
      if (el) el.value = s.toolApproval;
    }
  } catch {}
});

// Self-modify mode removed — platform files always protected

