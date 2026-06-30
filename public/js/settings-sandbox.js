// ── Settings: Bash Sandbox Mode ──
//
// Controls how the bash tool's commands are confined. Persists to
// ~/.lax/config.json via /api/sandbox.
//
// The "guarded" option is injected here rather than declared in app.html: this
// JS already mutates the <select> at runtime (it disables docker when Docker
// isn't installed), and keeping the option list owned here avoids editing the
// shared app.html markup.

const SANDBOX_HINTS = {
  guarded: 'Bash runs under a kernel cage that blocks reads of your credential files (~/.ssh, ~/.aws, API keys) — even via indirection a text filter would miss — while keeping network and dev tools (npm/git/gh) working. Recommended.',
  host: 'Bash runs directly on your host with no kernel cage. Full functionality, but a prompt-injected command could read credential files.',
  docker: 'Bash runs inside a Docker container (Alpine Linux, --network=none, workspace-only). Strongest isolation, but breaks host-OS commands and network access.'
};

function ensureGuardedOption(sel) {
  if (!sel || sel.querySelector('option[value="guarded"]')) return;
  const opt = document.createElement('option');
  opt.value = 'guarded';
  opt.textContent = 'Protected — block credential files, keep network (default)';
  sel.insertBefore(opt, sel.firstChild);
}

async function loadSandboxMode() {
  try {
    const r = await apiFetch('/api/sandbox');
    if (!r.ok) return;
    const d = await r.json();
    const sel = document.getElementById('cfg-sandbox-mode');
    ensureGuardedOption(sel);
    if (sel) sel.value = d.mode || 'guarded';
    const hint = document.getElementById('sandbox-hint');
    if (hint) hint.textContent = SANDBOX_HINTS[d.mode] || SANDBOX_HINTS.guarded;
    if (sel && !d.dockerAvailable) {
      const dockerOpt = sel.querySelector('option[value="docker"]');
      if (dockerOpt) {
        dockerOpt.disabled = true;
        dockerOpt.textContent = 'Maximum — Docker not installed (install Docker Desktop first)';
      }
    }
    if (sel && d.guardedAvailable === false) {
      const guardedOpt = sel.querySelector('option[value="guarded"]');
      if (guardedOpt) {
        guardedOpt.disabled = true;
        guardedOpt.textContent = 'Protected — not available on this OS (needs macOS or Linux)';
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
      // Reflect what the server actually settled on (it downgrades an
      // unavailable mode to host) rather than guessing.
      const sel = document.getElementById('cfg-sandbox-mode');
      if (sel && err.actual) sel.value = err.actual;
      if (hint) hint.textContent = err.error || 'Failed to set sandbox mode.';
    }
  } catch (e) { console.warn('[sandbox] save failed', e); }
}

document.addEventListener('DOMContentLoaded', loadSandboxMode);
