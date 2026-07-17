// ── Media tab voice picker — voice-list option builders ──
// Per-tier <option> HTML for the Voice dropdown. Reads catalog (window.C
// → C.EDGE_VOICES) and _kokoroCatalog from
// voice-picker.js, plus window._chatterboxVoices populated by
// chat-voice-modals.js after the user imports clones.

function _kokoroOptions(current) {
  const voices = (_kokoroCatalog?.voices || []).slice().sort((a, b) => {
    const aEn = a.language?.startsWith('en') ? 0 : 1;
    const bEn = b.language?.startsWith('en') ? 0 : 1;
    return aEn - bEn || (a.id || '').localeCompare(b.id || '');
  });
  const groups = { 'American Male': [], 'American Female': [], 'British Male': [], 'British Female': [], 'Other': [] };
  for (const v of voices) {
    const id = v.id || '';
    if (id.startsWith('am_')) groups['American Male'].push(v);
    else if (id.startsWith('af_')) groups['American Female'].push(v);
    else if (id.startsWith('bm_')) groups['British Male'].push(v);
    else if (id.startsWith('bf_')) groups['British Female'].push(v);
    else groups['Other'].push(v);
  }
  const labelOf = (v) => v.name || (v.id?.split('_').slice(1).join('_').replace(/\b\w/g, c => c.toUpperCase())) || v.id;
  let html = '';
  for (const [g, list] of Object.entries(groups)) {
    if (!list.length) continue;
    html += `<optgroup label="${_esc(g)}">` +
      list.map(v => `<option value="${_esc(v.id)}"${v.id === current ? ' selected' : ''}>${_esc(labelOf(v))}</option>`).join('') +
      `</optgroup>`;
  }
  return html;
}

function _edgeOptions(current) {
  const compact = (v) => v.replace('Neural', '').replace('en-US-', '').replace('en-GB-', 'GB · ').replace('en-AU-', 'AU · ').replace('en-CA-', 'CA · ');
  return C.EDGE_VOICES.map(([g, list]) =>
    `<optgroup label="${_esc(g)}">` +
    list.map(v => `<option value="${_esc(v)}"${v === current ? ' selected' : ''}>${_esc(compact(v))}</option>`).join('') +
    `</optgroup>`,
  ).join('');
}

function _browserOptions(current) {
  let voices = [];
  try { voices = (window.speechSynthesis?.getVoices?.() || []).filter(v => v.lang?.startsWith('en')); } catch {}
  if (!voices.length) return `<option value="">(default browser voice)</option>`;
  return voices.map(v => `<option value="${_esc(v.name)}"${v.name === current ? ' selected' : ''}>${_esc(v.name)} — ${_esc(v.lang)}${v.default ? ' (default)' : ''}</option>`).join('');
}

function _studioOptions(current) {
  const vx = Array.isArray(window._voxcpmVoices) ? window._voxcpmVoices : [];
  const cb = Array.isArray(window._chatterboxVoices) ? window._chatterboxVoices : [];
  let html = `<optgroup label="Kokoro built-ins">${_kokoroOptions(current)}</optgroup>`;
  if (vx.length) {
    html += `<optgroup label="Cloned voices (VoxCPM)">` + vx.map(c => {
      const v = 'vx:' + c.id;
      return `<option value="${_esc(v)}"${v === current ? ' selected' : ''}>${_esc(c.name || c.id)}</option>`;
    }).join('') + `</optgroup>`;
  }
  // Chatterbox is the backup engine — only list ids VoxCPM doesn't already
  // have, so imported clones don't show up twice in the picker.
  const vxIds = new Set(vx.map(c => c.id));
  const cbOnly = cb.filter(c => !vxIds.has(c.id));
  if (cbOnly.length) {
    html += `<optgroup label="Clones (Chatterbox backup)">` + cbOnly.map(c => {
      const v = 'cb:' + c.id;
      return `<option value="${_esc(v)}"${v === current ? ' selected' : ''}>${_esc(c.name || c.id)}</option>`;
    }).join('') + `</optgroup>`;
  }
  return html;
}

function _voiceListForTier(tierId, current) {
  if (tierId === 'browser') return _browserOptions(current);
  if (tierId === 'edge') return _edgeOptions(current);
  if (tierId === 'studio') return _studioOptions(current);
  return _kokoroOptions(current);
}
window.voiceListForTier = _voiceListForTier;
