const BROWSER_MODE_STATUS = {
  'in-app': 'Active: the agent drives the embedded in-app browser you can watch and co-drive. Falls back to an isolated browser when no app window is available.',
  isolated: 'Active: each session gets a separate ephemeral identity. Sign-ins are discarded when that session closes.',
  continuity: 'Active: sign-ins persist in one dedicated agent identity. Only one session owns its live context at a time.',
  'advanced-shared': 'Active: all sessions share the same live browser context.',
};

function renderBrowserMode(mode) {
  const canonical = BROWSER_MODE_STATUS[mode] ? mode : 'in-app';
  const select = document.getElementById('cfg-browser-mode');
  const status = document.getElementById('browser-mode-status');
  const warning = document.getElementById('browser-mode-warning');
  if (select) {
    select.value = canonical;
    select.dataset.current = canonical;
  }
  if (status) status.textContent = BROWSER_MODE_STATUS[canonical];
  if (warning) warning.style.display = canonical === 'advanced-shared' ? '' : 'none';
}

async function loadBrowserMode() {
  try {
    const response = await apiFetch('/api/settings');
    if (!response.ok) return;
    const settings = await response.json();
    renderBrowserMode(settings.browserMode || 'in-app');
  } catch (error) {
    console.warn('[browser-mode] load failed', error);
  }
}

async function setBrowserMode(mode) {
  const select = document.getElementById('cfg-browser-mode');
  const previous = select?.dataset.current || 'in-app';
  try {
    const response = await apiFetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ browserMode: mode }),
    });
    if (!response.ok) throw new Error('save failed');
    renderBrowserMode(mode);
  } catch (error) {
    console.warn('[browser-mode] save failed', error);
    renderBrowserMode(previous);
  }
}

document.addEventListener('DOMContentLoaded', loadBrowserMode);
