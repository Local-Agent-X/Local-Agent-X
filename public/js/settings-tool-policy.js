// ── Settings: Tool Policy category toggles ──
//
// Three boolean kill-switches (Shell, HTTP, Browser) that the server
// enforces at tool-pre-dispatch. Persists through the generic
// /api/settings endpoint — the runtime-settings schema in
// src/settings-schema.ts mirrors these into config.json + ctx.config so
// the gate reads the live value on the very next tool call (no restart).

async function loadToolPolicyToggles() {
  try {
    const r = await apiFetch('/api/settings');
    if (!r.ok) return;
    const s = await r.json();
    setToolPolicyToggle('tp-toggle-shell',   s.enableShell   !== false);
    setToolPolicyToggle('tp-toggle-http',    s.enableHttp    !== false);
    setToolPolicyToggle('tp-toggle-browser', s.enableBrowser !== false);
  } catch (e) { console.warn('[tool-policy] load failed', e); }
}

function setToolPolicyToggle(id, on) {
  const el = document.getElementById(id);
  if (!el) return;
  if (on) el.classList.add('on'); else el.classList.remove('on');
}

async function toolPolicyToggle(field, el) {
  const willBeOn = !el.classList.contains('on');
  // Optimistic UI flip — revert on failure.
  if (willBeOn) el.classList.add('on'); else el.classList.remove('on');
  try {
    const r = await apiFetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: willBeOn })
    });
    if (!r.ok) throw new Error('save failed');
  } catch (e) {
    console.warn('[tool-policy] save failed', e);
    // Revert
    if (willBeOn) el.classList.remove('on'); else el.classList.add('on');
  }
}

document.addEventListener('DOMContentLoaded', loadToolPolicyToggles);
