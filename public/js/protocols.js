// ── Protocols Page ──
// Browse the agent's pre-built workflows

function init_protocols() { loadProtocols(); }

async function loadProtocols() {
  const el = document.getElementById('protocols-list');
  const countEl = document.getElementById('protocol-count');
  if (!el) { console.error('[protocols] No #protocols-list element'); return; }
  el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted)">Loading...</div>';
  try {
    const data = await apiFetch('/api/protocols').then(r => r.json());
    const protocols = data.protocols || [];
    if (countEl) countEl.textContent = protocols.length + ' protocols';
    if (protocols.length === 0) {
      el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted)">No protocols yet. Add a SKILL.md file to ~/.sax/skills/my-protocol/ to create one.</div>';
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
      'General': '&#9889;',
    };
    const order = ['Social Media', 'Research', 'Communication', 'Developer', 'General'];
    const sorted = order.filter(c => groups[c]).concat(Object.keys(groups).filter(c => !order.includes(c)));

    el.innerHTML = sorted.map(cat => {
      const items = groups[cat];
      return `
      <div style="margin-bottom:24px">
        <div style="font-family:var(--mono);font-size:.7rem;color:var(--accent);letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:6px">
          <span style="font-size:.85rem">${categoryIcons[cat] || '&#9889;'}</span> ${esc(cat)}
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px">
          ${items.map(p => `
            <div class="protocol-card" onclick="useProtocol('${esc(p.triggers[0] || p.name)}')">
              <div class="protocol-name">${esc(p.name.replace(/_/g, ' '))}</div>
              <div class="protocol-desc">${esc(p.description)}</div>
              <div class="protocol-footer">
                <span>${p.steps} steps</span>
                <span class="protocol-trigger">"${esc(p.triggers[0] || p.name)}"</span>
              </div>
            </div>
          `).join('')}
        </div>
      </div>`;
    }).join('');
  } catch (e) {
    el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--danger)">Failed to load protocols.</div>';
  }
}

// Auto-init if page is already active (handles direct URL navigation)
if (document.getElementById('page-protocols')?.classList.contains('active')) {
  loadProtocols();
}

function useProtocol(trigger) {
  navigate('chat');
  const input = document.getElementById('msg-input');
  if (input) {
    input.value = trigger;
    input.focus();
  }
}
