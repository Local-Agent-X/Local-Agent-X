// ── Settings: File Access Mode + Autonomy Profile ──
//
// "What can the agent touch?" controls — file access mode (workspace /
// expanded / unrestricted) and autonomy profile (Safe / Normal /
// Developer / Power / Autonomous). File access persists to
// ~/.lax/settings.json (security layer reads it); profile persists to
// ~/.lax/autonomy-profile.json (approval-manager reads it).

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

async function setAutonomyProfile(profile) {
  try {
    await apiFetch('/api/autonomy/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile })
    });
  } catch (e) { console.warn('[autonomy] save failed', e); }
}

// Load saved autonomy profile on settings page open
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const res = await apiFetch('/api/autonomy/profile');
    if (!res.ok) return;
    const s = await res.json();
    if (s?.profile) {
      const el = document.getElementById('cfg-autonomy-profile');
      if (el) el.value = s.profile;
    }
  } catch {}
});

// Self-modify mode removed — platform files always protected

