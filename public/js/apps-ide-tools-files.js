// ── App IDE — tool cards + preview iframe + file tree ──
// Inline tool-call rendering inside the active assistant bubble, the
// debounced workspace-preview iframe reload, and the right-side file
// list with one-click read-only viewer.

function ideAddToolCard(name, args, riskLevel, context) {
  const el = document.getElementById('ide-assistant-active');
  if (!el) return;
  // Remove thinking indicator if present
  const thinking = el.querySelector('.ide-thinking');
  if (thinking) thinking.remove();

  const card = document.createElement('div');
  card.className = 'tool-card';
  card.dataset.tool = name;
  card.innerHTML =
    '<div class="tool-header" onclick="this.parentElement.classList.toggle(\'open\')">' +
      '<span class="indicator"></span>' +
      '<span class="tool-name">' + esc(name) + '</span>' +
      '<span style="color:var(--muted);font-size:.72rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">' +
        esc(ideToolLabel(name, args)) +
      '</span>' +
      '<span class="ide-tool-spinner"></span>' +
    '</div>' +
    '<div class="tool-detail">' + esc(ideFormatToolArgs(name, args)) + '</div>';
  el.appendChild(card);
  const msgs = document.getElementById('ide-chat-messages');
  if (msgs) msgs.scrollTop = msgs.scrollHeight;
}

function ideFinishToolCard(name, result, allowed) {
  const el = document.getElementById('ide-assistant-active');
  if (!el) return;
  const cards = el.querySelectorAll('.tool-card[data-tool="' + name + '"]');
  const card = cards[cards.length - 1];
  if (!card) return;
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
