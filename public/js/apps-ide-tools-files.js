// ── App IDE — tool cards + preview iframe + file tree ──
// Inline tool-call rendering inside the active assistant bubble, the
// debounced workspace-preview iframe reload, and the right-side file
// list with one-click read-only viewer.

// Activity-group wrapper mirrors the regular chat's collapsible bundle —
// one "⚙ Agent activity (N)" header per assistant turn, click to expand.
// Without this every tool call stacked flat in the IDE bubble, flooding
// the chat with 15 cards for one build_app. Same UX as chat-tool-cards.js
// but IDE-scoped DOM (different IDs, smaller card layout).
function ideEnsureActivityGroup(parentEl) {
  let group = parentEl.querySelector(':scope > .ide-activity-group');
  if (group) return group;
  group = document.createElement('div');
  group.className = 'ide-activity-group';
  group.innerHTML =
    '<div class="ide-activity-header" onclick="this.parentElement.classList.toggle(\'open\');this.querySelector(\'.ide-activity-chevron\').textContent=this.parentElement.classList.contains(\'open\')?\'\\u25BC\':\'\\u25B6\'">' +
      '<span class="ide-activity-icon">&#9881;</span>' +
      '<span class="ide-activity-label">Agent activity</span>' +
      '<span class="ide-activity-count">0</span>' +
      '<span class="ide-activity-chevron">&#9654;</span>' +
    '</div>' +
    '<div class="ide-activity-body"></div>';
  parentEl.appendChild(group);
  return group;
}

function ideAddToolCard(name, args, riskLevel, context) {
  const el = document.getElementById('ide-assistant-active');
  if (!el) return;
  // Remove thinking indicator if present
  const thinking = el.querySelector('.ide-thinking');
  if (thinking) thinking.remove();

  const group = ideEnsureActivityGroup(el);
  const body = group.querySelector('.ide-activity-body');
  const lastCard = body.lastElementChild;

  // Same-name dedup ("write ×3") — collapses repeated calls so the count
  // header reflects work density instead of card noise.
  if (lastCard && lastCard.dataset.tool === name && !lastCard.dataset.finished) {
    const count = parseInt(lastCard.dataset.callCount || '1', 10) + 1;
    lastCard.dataset.callCount = String(count);
    const countEl = lastCard.querySelector('.tool-count');
    if (countEl) countEl.textContent = '×' + count;
    const summary = lastCard.querySelector('.tool-summary');
    if (summary) summary.textContent = ideToolLabel(name, args);
    ideBumpActivityCount(group);
    return;
  }

  const card = document.createElement('div');
  card.className = 'tool-card';
  card.dataset.tool = name;
  card.dataset.callCount = '1';
  card.innerHTML =
    '<div class="tool-header" onclick="this.parentElement.classList.toggle(\'open\')">' +
      '<span class="indicator"></span>' +
      '<span class="tool-name">' + esc(name) + '</span>' +
      '<span class="tool-count" style="font-size:.7rem;color:var(--muted);margin-right:.3rem"></span>' +
      '<span class="tool-summary" style="color:var(--muted);font-size:.72rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">' +
        esc(ideToolLabel(name, args)) +
      '</span>' +
      '<span class="ide-tool-spinner"></span>' +
    '</div>' +
    '<div class="tool-detail">' + esc(ideFormatToolArgs(name, args)) + '</div>';
  body.appendChild(card);
  ideBumpActivityCount(group);
  const msgs = document.getElementById('ide-chat-messages');
  if (msgs) msgs.scrollTop = msgs.scrollHeight;
}

function ideBumpActivityCount(group) {
  const countEl = group.querySelector('.ide-activity-count');
  if (!countEl) return;
  const cards = group.querySelectorAll('.tool-card');
  let total = 0;
  for (const c of cards) total += parseInt(c.dataset.callCount || '1', 10);
  countEl.textContent = String(total);
}

function ideFinishToolCard(name, result, allowed) {
  const el = document.getElementById('ide-assistant-active');
  if (!el) return;
  const cards = el.querySelectorAll('.tool-card[data-tool="' + name + '"]');
  const card = cards[cards.length - 1];
  if (!card) return;
  card.dataset.finished = '1';
  const indicator = card.querySelector('.indicator');
  if (indicator) indicator.className = 'indicator ' + (allowed ? 'allowed' : 'blocked');
  const spinner = card.querySelector('.ide-tool-spinner');
  if (spinner) spinner.remove();
  // Add result preview to detail
  if (result) {
    const detail = card.querySelector('.tool-detail');
    if (detail) {
      const preview = typeof result === 'string' ? result.slice(0, 500) : JSON.stringify(result).slice(0, 500);
      detail.textContent += '\n\n' + preview;
    }
  }
}

function ideFormatToolArgs(name, args) {
  if (!args) return '';
  switch (name) {
    case 'write': case 'read': case 'edit': return args.path || '';
    case 'bash': return '$ ' + (args.command || '');
    case 'build_app': return (args.name || '') + ': ' + (args.prompt || '').slice(0, 100);
    case 'glob': return args.pattern || '';
    case 'grep': return args.pattern || '';
    default: return JSON.stringify(args).slice(0, 200);
  }
}

// ── Preview ──
let _ideRefreshTimer = null;

function ideRefreshPreview() {
  // Debounce: wait 500ms after last call so file writes flush to disk
  if (_ideRefreshTimer) clearTimeout(_ideRefreshTimer);
  _ideRefreshTimer = setTimeout(_ideDoRefresh, 500);
}

function _ideDoRefresh() {
  _ideRefreshTimer = null;
  const frame = document.getElementById('ide-preview-frame');
  if (!frame || !_ideAppId) return;
  // Always use the workspace file URL, never the registry render URL
  const port = location.port || '7007';
  const appUrl = `http://127.0.0.1:${port}/apps/${_ideAppId}/index.html`;
  window._ideAppUrl = appUrl;
  frame.src = appUrl + '?_t=' + Date.now();
  // Re-inject the element picker if it was on — the iframe just got a
  // fresh window, so the previous load's script is gone.
  if (typeof _ideOnPreviewLoad === 'function') {
    frame.addEventListener('load', _ideOnPreviewLoad, { once: true });
  }
  if (typeof _ideOnPreviewLoadErrors === 'function') {
    frame.addEventListener('load', _ideOnPreviewLoadErrors, { once: true });
  }
}

// ── File tree ──
async function ideLoadFiles() {
  const tree = document.getElementById('ide-file-tree');
  if (!tree || !_ideAppId) return;
  try {
    const r = await fetch(`${API}/api/apps/${_ideAppId}/files`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` }
    });
    if (!r.ok) { tree.innerHTML = '<div class="ide-file-empty">No files yet</div>'; return; }
    const files = await r.json();
    if (!Array.isArray(files) || files.length === 0) {
      tree.innerHTML = '<div class="ide-file-empty">No files yet</div>';
      return;
    }
    tree.innerHTML = files.map(f => {
      const ext = f.split('.').pop() || '';
      const icon = { html: '&#128196;', css: '&#127912;', js: '&#9881;', ts: '&#9881;', json: '&#128203;', md: '&#128221;', png: '&#128444;', svg: '&#128444;' }[ext] || '&#128196;';
      return `<div class="ide-file-item" onclick="ideViewFile('${esc(f)}')" title="${esc(f)}">
        <span class="icon">${icon}</span><span class="name">${esc(f)}</span>
      </div>`;
    }).join('');
  } catch {
    tree.innerHTML = '<div class="ide-file-empty">Could not load files</div>';
  }
}

async function ideViewFile(filename) {
  const tree = document.getElementById('ide-file-tree');
  const viewer = document.getElementById('ide-file-viewer');
  const nameEl = document.getElementById('ide-file-viewer-name');
  const contentEl = document.getElementById('ide-file-viewer-content');
  if (!viewer || !contentEl) return;
  try {
    const r = await fetch(`${API}/api/apps/${_ideAppId}/files/${encodeURIComponent(filename)}`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` }
    });
    if (!r.ok) throw new Error('Failed to fetch');
    const text = await r.text();
    if (nameEl) nameEl.textContent = filename;
    contentEl.textContent = text;
    if (tree) tree.style.display = 'none';
    viewer.style.display = 'flex';
  } catch {
    contentEl.textContent = 'Failed to load file';
  }
}

function ideCloseFileViewer() {
  const tree = document.getElementById('ide-file-tree');
  const viewer = document.getElementById('ide-file-viewer');
  if (tree) tree.style.display = '';
  if (viewer) viewer.style.display = 'none';
}

window.ideRefreshPreview = ideRefreshPreview;
window.ideCloseFileViewer = ideCloseFileViewer;
window.ideViewFile = ideViewFile;
