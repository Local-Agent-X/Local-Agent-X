// Artifacts tab in the right sidebar — lists images, videos, files, and links
// extracted from the chat on screen, or from every chat with the tab's
// "This chat / All chats" switch (server does the extraction, see
// src/routes/artifacts.ts). Also owns tab switching for the sidebar; the
// AGENTS tab keeps everything it had (chat-agent-feeds*.js untouched).

var sidePanelTab = 'agents';
var artifactsCache = null;
var artifactsFetchedAt = 0;
// What artifactsCache holds: a chat's id, or 'all'.
var artifactsCacheFor = '';
var ARTIFACTS_SCOPE_KEY = 'lax_artifacts_scope';
var artifactsScope = (function() {
  try { return localStorage.getItem(ARTIFACTS_SCOPE_KEY) === 'all' ? 'all' : 'chat'; } catch (e) { return 'chat'; }
})();
var artifactsFilter = 'all';
var ARTIFACTS_TTL_MS = 15000;

// Each tab is a #side-tab-<name> button and a #<name>-tab-body pane.
var SIDE_PANEL_TABS = ['agents', 'preview', 'inbox', 'artifacts', 'changes', 'browser', 'android', 'terminal'];

// The chat on screen changed: each tab that lists one chat's things turns to
// that chat. Called from every place the chat on screen changes
// (app-sidebar-actions.js), beside the Browser bind and the Preview tab's own.
window.laxSidePanelChat = {
  onChatChanged: function() {
    if (window.laxAgentFeedsScope) window.laxAgentFeedsScope.onChatChanged();
    if (sidePanelTab === 'artifacts') loadArtifacts(false);
    if (window.laxTerminalPanel && window.laxTerminalPanel.onChatChanged) window.laxTerminalPanel.onChatChanged();
  },
};

function switchSidePanelTab(tab) {
  sidePanelTab = tab;
  SIDE_PANEL_TABS.forEach(function(name) {
    var body = document.getElementById(name + '-tab-body');
    var button = document.getElementById('side-tab-' + name);
    if (body) body.style.display = tab === name ? '' : 'none';
    if (button) button.classList.toggle('active', tab === name);
  });
  var autoBtn = document.getElementById('agent-feeds-autoopen-toggle');
  // AUTO (auto-open on agent spawn) only makes sense on the agents tab.
  if (autoBtn) autoBtn.style.display = tab === 'agents' ? '' : 'none';
  if (tab === 'artifacts') loadArtifacts(false);
  if (tab === 'changes' && typeof renderFileChangesTab === 'function') renderFileChangesTab();
  // An item posted from an out-of-process worker has no live frame here.
  if (tab === 'inbox' && typeof loadInbox === 'function') loadInbox();
  if (typeof applyAgentFeedsTabWidth === 'function') applyAgentFeedsTabWidth(tab);
  if (tab !== 'browser' && window.laxBrowserWorkspace) {
    window.laxBrowserWorkspace.onTabHidden();
  }
  // The browser pane hosts a native overlay (browser-tab.js) that must be
  // hidden the moment its tab is not the visible one.
  if (window.laxBrowserTab) {
    if (tab === 'browser') window.laxBrowserTab.onTabShown();
    else window.laxBrowserTab.onTabHidden();
  }
  if (tab === 'terminal' && window.laxTerminalPanel) window.laxTerminalPanel.onTabShown();
  if (window.laxPreviewTab) {
    window.laxPreviewTab.rememberTab(tab);
    if (tab === 'preview') window.laxPreviewTab.onTabShown();
  }
  if (window.laxAndroidTab) {
    if (tab === 'android') window.laxAndroidTab.onTabShown();
    else window.laxAndroidTab.onTabHidden();
  }
}

// The chat whose artifacts the tab shows, or 'all'.
function artifactsWanted() {
  var chatId = '';
  try { chatId = (typeof activeChat !== 'undefined' && activeChat && activeChat.id) || ''; } catch (e) { /* no chat open */ }
  return artifactsScope === 'all' || !chatId ? 'all' : chatId;
}

function setArtifactsScope(scope) {
  artifactsScope = scope === 'all' ? 'all' : 'chat';
  try { localStorage.setItem(ARTIFACTS_SCOPE_KEY, artifactsScope); } catch (e) { /* private mode: the choice lasts the page */ }
  loadArtifacts(false);
}

function loadArtifacts(force) {
  var wanted = artifactsWanted();
  if (!force && artifactsCache && artifactsCacheFor === wanted && Date.now() - artifactsFetchedAt < ARTIFACTS_TTL_MS) {
    renderArtifacts();
    return;
  }
  var list = document.getElementById('artifacts-list');
  // Another chat's list never shows under this chat while its own loads.
  if (artifactsCacheFor !== wanted) artifactsCache = null;
  if (list && !artifactsCache) list.innerHTML = '<div class="artifacts-empty">Loading…</div>';
  apiJson('/api/artifacts' + (wanted === 'all' ? '' : '?session=' + encodeURIComponent(wanted))).then(function(data) {
    // The chat changed while this was in flight: its own request answers it.
    if (wanted !== artifactsWanted()) return;
    artifactsCache = (data && data.artifacts) || [];
    artifactsCacheFor = wanted;
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
  var scopeEl = document.getElementById('artifacts-scope');
  if (scopeEl && typeof panelScopeHtml === 'function') {
    scopeEl.innerHTML = panelScopeHtml(artifactsScope, 'setArtifactsScope', 'What this chat made, read or linked', 'Every chat’s artifacts');
  }
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
    listEl.innerHTML = '<div class="artifacts-empty">' + (artifactsCacheFor === 'all' ? 'No artifacts yet' : 'No artifacts in this chat yet') + '</div>';
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
  // Workspace files: the same opener as a chat link (shared-dom.js), so an
  // Office file goes to its program and anything viewable renders in a window.
  if (/^\/files\//.test(a.ref)) {
    openFileLink(a.ref);
    return;
  }
  // Served media (/images|/videos|/uploads): a window can't send the auth
  // header, so it opens the link the server signed for this one file
  // (openUrl). The operator token never goes in a URL a browser keeps.
  if (/^\/(images|videos|uploads)\//.test(a.ref)) {
    window.open(a.openUrl || a.ref, '_blank', 'noopener');
    return;
  }
  // Plain file path — copy it so the user can paste into chat or an editor.
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(a.ref).then(function() {
      if (typeof showToast === 'function') showToast('Path copied');
    });
  }
}
