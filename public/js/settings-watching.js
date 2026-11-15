// Settings → General → Watching for you: the mail watcher's switches and the
// quiet hours phone alerts respect. Each control saves on change; another tab
// (or the agent) changing one repaints it through renderWatchingSettings.
(function () {
  const TOGGLES = {
    mailWatchEnabled: 'watch-mail-enabled',
    mailWatchLocalOnly: 'watch-mail-local-only',
    quietHoursEnabled: 'watch-quiet-enabled',
  };
  const TIMES = { quietHoursStart: 'watch-quiet-start', quietHoursEnd: 'watch-quiet-end' };
  const DEFAULTS = { mailWatchEnabled: true, mailWatchLocalOnly: false, quietHoursEnabled: true, quietHoursStart: '22:00', quietHoursEnd: '07:00' };

  function renderWatchingSettings(settings) {
    for (const [field, id] of Object.entries(TOGGLES)) {
      const box = document.getElementById(id);
      if (box && field in settings) box.checked = settings[field] === undefined ? DEFAULTS[field] : settings[field] === true;
    }
    for (const [field, id] of Object.entries(TIMES)) {
      const input = document.getElementById(id);
      if (input && field in settings) input.value = typeof settings[field] === 'string' ? settings[field] : DEFAULTS[field];
    }
    const quiet = document.getElementById('watch-quiet-enabled');
    const off = quiet ? !quiet.checked : false;
    for (const id of Object.values(TIMES)) {
      const input = document.getElementById(id);
      if (input) input.disabled = off;
    }
  }

  async function saveWatchingSetting(patch) {
    try {
      const result = await apiPost('/api/settings', patch);
      if (!result.ok) throw new Error(result.error || 'Unable to save');
    } catch {
      loadWatchingSettings();
    }
  }

  async function loadWatchingSettings() {
    try {
      const settings = await apiJson('/api/settings');
      const shown = {};
      for (const field of [...Object.keys(TOGGLES), ...Object.keys(TIMES)]) shown[field] = settings[field] ?? DEFAULTS[field];
      renderWatchingSettings(shown);
    } catch {}
  }

  // Each control posts its own field by name, so the settings schema check
  // (src/settings-schema.ui-posts.test.ts) can follow every key to its declaration.
  function onToggle(id, post) {
    const box = document.getElementById(id);
    box.addEventListener('change', () => { post(box.checked); renderWatchingSettings({}); });
  }
  function onTime(id, post) {
    const input = document.getElementById(id);
    input.addEventListener('change', () => { if (/^\d\d:\d\d$/.test(input.value)) post(input.value); });
  }

  function wire() {
    if (!document.getElementById('watch-mail-enabled')) return;
    onToggle('watch-mail-enabled', (v) => saveWatchingSetting({ mailWatchEnabled: v }));
    onToggle('watch-mail-local-only', (v) => saveWatchingSetting({ mailWatchLocalOnly: v }));
    onToggle('watch-quiet-enabled', (v) => saveWatchingSetting({ quietHoursEnabled: v }));
    onTime('watch-quiet-start', (v) => saveWatchingSetting({ quietHoursStart: v }));
    onTime('watch-quiet-end', (v) => saveWatchingSetting({ quietHoursEnd: v }));
    loadWatchingSettings();
  }

  window.renderWatchingSettings = renderWatchingSettings;
  window.loadWatchingSettings = loadWatchingSettings;
  document.addEventListener('DOMContentLoaded', wire);
}());
