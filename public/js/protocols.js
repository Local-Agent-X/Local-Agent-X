// ── Protocols Page ──
// Browse the agent's pre-built workflows

function init_protocols() { loadProtocols(); }

async function loadProtocols() {
  const el = document.getElementById('protocols-list');
  const countEl = document.getElementById('protocol-count');
  if (!el) return;
  el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted)">Loading protocols...</div>';
  try {
    const data = await apiGet('/api/protocols');
    const protocols = data.protocols || [];
    if (countEl) countEl.textContent = protocols.length + ' protocols';
    if (protocols.length === 0) {
      el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted)">No protocols found.</div>';
      return;
    }
    // Group by category
    const groups = {};
    for (const p of protocols) {
      const cat = p.category || 'General';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(p);
    }
    const categoryIcons = {
      'Social Media': '&#128247;',
      'Developer': '&#128187;',
      'Research': '&#128270;',
      'Communication': '&#128172;',
      'Smart Home': '&#127968;',
      'General': '&#9889;',
    };
    el.innerHTML = Object.entries(groups).map(([cat, items]) => `
      <div style="margin-bottom:20px">
        <div style="font-family:var(--mono);font-size:.78rem;color:var(--accent);margin-bottom:10px;display:flex;align-items:center;gap:6px">
          <span>${categoryIcons[cat] || '&#9889;'}</span> ${esc(cat)}
          <span style="color:var(--muted);font-size:.65rem">(${items.length})</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px">
          ${items.map(p => `
            <div style="padding:14px;border-radius:10px;border:1px solid var(--border);background:var(--surface);cursor:pointer;transition:all .2s"
                 onmouseenter="this.style.borderColor='var(--accent)'"
                 onmouseleave="this.style.borderColor='var(--border)'"
                 onclick="useProtocol('${esc(p.triggers[0] || p.name)}')">
              <div style="font-family:var(--mono);font-size:.82rem;color:var(--text);font-weight:600;margin-bottom:4px">${esc(p.name.replace(/_/g, ' '))}</div>
              <div style="font-size:.72rem;color:var(--muted);line-height:1.4;margin-bottom:8px">${esc(p.description)}</div>
              <div style="display:flex;justify-content:space-between;align-items:center">
                <span style="font-size:.65rem;color:var(--muted);font-family:var(--mono)">${p.steps} steps</span>
                <span style="font-size:.6rem;color:var(--accent);font-family:var(--mono)">say: "${esc(p.triggers[0] || p.name)}"</span>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `).join('');
  } catch (e) {
    el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--danger)">Failed to load protocols.</div>';
  }
}

function useProtocol(trigger) {
  // Navigate to chat and pre-fill the trigger phrase
  navigate('chat');
  const input = document.getElementById('msg-input');
  if (input) {
    input.value = trigger;
    input.focus();
  }
}
