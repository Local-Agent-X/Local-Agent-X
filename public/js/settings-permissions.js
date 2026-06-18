// ── Settings: System Permissions (macOS) ──
//
// Mouse/keyboard control (Accessibility), screen_capture (Screen Recording),
// and voice (Microphone) are gated by macOS, NOT by LAX — the grant lives in
// System Settings. So this card only REPORTS status and deep-links to the right
// pane; it can't flip the grant. macOS applies a change only after the app
// restarts, which is why the card carries that warning (see app.html).
//
// Desktop-only: the checks ride the renderer→main bridge (window.desktop). In a
// plain browser tab (no bridge) the card hides itself.

const PERM_KINDS = ['accessibility', 'screen', 'microphone'];
const PERM_LABEL = {
  granted: 'Granted', denied: 'Not granted', restricted: 'Restricted',
  'not-determined': 'Not set', unknown: 'Unknown', unsupported: 'Not required on this OS',
};

async function loadSystemPermissions() {
  const card = document.getElementById('system-permissions-card');
  if (!card) return;
  // Only meaningful inside the desktop app (renderer→main IPC bridge).
  if (!window.desktop || typeof window.desktop.checkPermission !== 'function') {
    card.style.display = 'none';
    return;
  }
  for (const kind of PERM_KINDS) {
    const el = document.getElementById('perm-status-' + kind);
    if (!el) continue;
    try {
      const status = await window.desktop.checkPermission(kind);
      el.textContent = PERM_LABEL[status] || status;
      el.dataset.status = status;
    } catch {
      el.textContent = '—';
    }
  }
}

function openPrivacyPane(pane) {
  if (window.desktop && typeof window.desktop.openPrivacyPane === 'function') {
    window.desktop.openPrivacyPane(pane);
  }
}

// Re-check on load and whenever the window regains focus — the user grants in
// System Settings, comes back, and the status should refresh (it still won't be
// ACTIVE until they restart, per the card's warning).
document.addEventListener('DOMContentLoaded', loadSystemPermissions);
window.addEventListener('focus', loadSystemPermissions);
