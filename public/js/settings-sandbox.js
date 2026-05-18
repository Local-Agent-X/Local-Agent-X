// ── Settings: Bash Sandbox Mode ──
//
// Toggles whether the bash tool runs commands directly on host (default)
// or inside a network-isolated Docker container. Persists to
// ~/.lax/config.json via /api/sandbox.

const SANDBOX_HINTS = {
  host: 'Bash runs directly on your host OS. Faster, OS-native commands work normally, network access available.',
  docker: 'Bash runs inside a Docker container (Alpine Linux, --network=none, workspace-only). Strongest isolation, but breaks host-OS commands and network scans.'
};

async function loadSandboxMode() {
  try {
    const r = await apiFetch('/api/sandbox');
    if (!r.ok) return;
    const d = await r.json();
    const sel = document.getElementById('cfg-sandbox-mode');
    if (sel) sel.value = d.mode || 'host';
    const hint = document.getElementById('sandbox-hint');
    if (hint) hint.textContent = SANDBOX_HINTS[d.mode] || SANDBOX_HINTS.host;
    if (sel && !d.dockerAvailable) {
      const dockerOpt = sel.querySelector('option[value="docker"]');
      if (dockerOpt) {
        dockerOpt.disabled = true;
        dockerOpt.textContent = 'On — Docker not installed (install Docker Desktop first)';
      }
    }
  } catch (e) { console.warn('[sandbox] load failed', e); }
}

async function setSandboxModeUI(mode) {
  const hint = document.getElementById('sandbox-hint');
  if (hint) hint.textContent = SANDBOX_HINTS[mode] || '';
  try {
    const r = await apiFetch('/api/sandbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode })
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      console.warn('[sandbox] save failed', err);
      const sel = document.getElementById('cfg-sandbox-mode');
      if (sel) sel.value = 'host';
      if (hint) hint.textContent = err.error || 'Failed to set sandbox mode.';
    }
  } catch (e) { console.warn('[sandbox] save failed', e); }
}

document.addEventListener('DOMContentLoaded', loadSandboxMode);
