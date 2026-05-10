// ── Settings: Settings Import/Export ──
//
// Full settings round-trip via a JSON blob — exportSettings dumps every
// `sax_*` localStorage entry; importSettings replays them.

// ── HTTPS ──

// ── Settings Import/Export (feature 98) ──

function exportSettings() {
  const data = {};
  // Collect all sax_ localStorage keys
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('sax_') && !key.includes('token')) {
      try { data[key] = JSON.parse(localStorage.getItem(key)); } catch { data[key] = localStorage.getItem(key); }
    }
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'agent-x-settings-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click(); URL.revokeObjectURL(url);
}

function importSettings() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.json';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      let count = 0;
      for (const [key, value] of Object.entries(data)) {
        if (key.startsWith('sax_') && !key.includes('token')) {
          localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
          count++;
        }
      }
      alert('Imported ' + count + ' settings. Reloading...');
      location.reload();
    } catch (err) {
      alert('Import failed: ' + err.message);
    }
  };
  input.click();
}

// Onboarding Wizard moved to /js/settings-onboarding.js

