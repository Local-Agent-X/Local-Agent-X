// Artifacts tab in the right sidebar — lists images, videos, files, and links
// extracted from all chat sessions (server does the extraction, see
// src/routes/artifacts.ts). Also owns tab switching for the sidebar; the
// AGENTS tab keeps everything it had (chat-agent-feeds*.js untouched).

var sidePanelTab = 'agents';
var artifactsCache = null;
var artifactsFetchedAt = 0;
var artifactsFilter = 'all';
var ARTIFACTS_TTL_MS = 15000;

function switchSidePanelTab(tab) {
  sidePanelTab = tab;
  var agentsBody = document.getElementById('agents-tab-body');
  var artifactsBody = document.getElementById('artifacts-tab-body');
  var browserBody = document.getElementById('browser-tab-body');
  var agentsTab = document.getElementById('side-tab-agents');
  var artifactsTab = document.getElementById('side-tab-artifacts');
  var browserTab = document.getElementById('side-tab-browser');
  var autoBtn = document.getElementById('agent-feeds-autoopen-toggle');
  if (agentsBody) agentsBody.style.display = tab === 'agents' ? '' : 'none';
  if (artifactsBody) artifactsBody.style.display = tab === 'artifacts' ? '' : 'none';
  if (browserBody) browserBody.style.display = tab === 'browser' ? '' : 'none';
  if (agentsTab) agentsTab.classList.toggle('active', tab === 'agents');
  if (artifactsTab) artifactsTab.classList.toggle('active', tab === 'artifacts');
  if (browserTab) browserTab.classList.toggle('active', tab === 'browser');
  // AUTO (auto-open on agent spawn) only makes sense on the agents tab.
  if (autoBtn) autoBtn.style.display = tab === 'agents' ? '' : 'none';
  if (tab === 'artifacts') loadArtifacts(false);
  // The browser pane hosts a native overlay (browser-tab.js) that must be
  // hidden the moment its tab is not the visible one.
  if (window.laxBrowserTab) {
    if (tab === 'browser') window.laxBrowserTab.onTabShown();
    else window.laxBrowserTab.onTabHidden();
  }
}

function loadArtifacts(force) {
  if (!force && artifactsCache && Date.now() - artifactsFetchedAt < ARTIFACTS_TTL_MS) {
    renderArtifacts();
    return;
  }
  var list = document.getElementById('artifacts-list');
  if (list && !artifactsCache) list.innerHTML = '<div class="artifacts-empty">Loading…</div>';
  apiJson('/api/artifacts').then(function(data) {
    artifactsCache = (data && data.artifacts) || [];
    artifactsFetchedAt = Date.now();
    renderArtifacts();
  }).catch(function() {
    if (list) list.innerHTML = '<div class="artifacts-empty">Failed to load artifacts</div>';
  });
}

function setArtifactsFilter(filter) {
  artifactsFilter = filter;
  renderArtifacts();
}

var ARTIFACT_ICONS = { image: '&#128444;', video: '&#127916;', file: '&#128196;', link: '&#128279;' };
var ARTIFACT_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'image', label: 'Images' },
  { key: 'video', label: 'Videos' },
  { key: 'file', label: 'Files' },
  { key: 'link', label: 'Links' },
];

function artifactDate(ts) {
  var d = new Date(ts);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' +
    d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function renderArtifacts() {
  var filtersEl = document.getElementById('artifacts-filters');
  var listEl = document.getElementById('artifacts-list');
  if (!filtersEl || !listEl) return;
  var items = artifactsCache || [];

  var counts = { all: items.length, image: 0, video: 0, file: 0, link: 0 };
  items.forEach(function(a) { if (counts[a.type] !== undefined) counts[a.type]++; });
  filtersEl.innerHTML = ARTIFACT_FILTERS.map(function(f) {
    return '<button class="artifact-filter' + (artifactsFilter === f.key ? ' active' : '') + '" ' +
      'onclick="setArtifactsFilter(\'' + f.key + '\')">' + f.label +
      ' <span class="artifact-filter-count">' + counts[f.key] + '</span></button>';
  }).join('') +
  '<button class="artifact-filter artifacts-refresh" onclick="loadArtifacts(true)" title="Refresh">&#8635;</button>';

  var visible = artifactsFilter === 'all' ? items : items.filter(function(a) { return a.type === artifactsFilter; });
  if (!visible.length) {
    listEl.innerHTML = '<div class="artifacts-empty">No artifacts yet</div>';
    return;
  }
  listEl.innerHTML = visible.map(function(a, i) {
    return '<div class="artifact-row" data-idx="' + i + '" onclick="openArtifact(\'' + artifactsFilter + '\',' + i + ')" title="' + esc(a.ref) + '">' +
      '<span class="artifact-icon">' + (ARTIFACT_ICONS[a.type] || ARTIFACT_ICONS.file) + '</span>' +
      '<div class="artifact-main">' +
        '<div class="artifact-name">' + esc(a.name) + '</div>' +
        '<div class="artifact-ref">' + esc(a.ref) + '</div>' +
        '<div class="artifact-session">' + esc(a.sessionTitle || a.sessionId) + ' &middot; ' + artifactDate(a.ts) + '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

function openArtifact(filter, idx) {
  var items = artifactsCache || [];
  var visible = filter === 'all' ? items : items.filter(function(a) { return a.type === filter; });
  var a = visible[idx];
  if (!a) return;
  if (a.type === 'link') {
    window.open(a.ref, '_blank', 'noopener');
    return;
  }
  // Served media (/images|/videos|/uploads|/files) — static-assets auth is
  // header-or-?token=, and a plain window.open can't send headers.
  if (/^\/(images|videos|uploads|files)\//.test(a.ref)) {
    window.open(a.ref + '?token=' + encodeURIComponent(AUTH_TOKEN), '_blank', 'noopener');
    return;
  }
  // Plain file path — copy it so the user can paste into chat or an editor.
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(a.ref).then(function() {
      if (typeof showToast === 'function') showToast('Path copied');
    });
  }
}
