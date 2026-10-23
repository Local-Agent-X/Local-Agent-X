// ── Right panel: the Preview tab ──
// A code session's app (an App IDE session, `ide-<appId>`, src/session/mode.ts),
// shown live or as its files by the Preview / Code switch. The loaders are the
// App IDE's own (apps-ide-tools-files.js loadAppPreview / loadAppFileTree /
// fetchAppFile), so an agent-built app is shown one way, from the agent origin.
// It refreshes when the session's agent changes files or finishes a turn.
//
// A code session opens the right panel on this tab, and each mode remembers
// the tab last chosen in it (per machine, localStorage); a chat keeps the
// panel's own default.

(function() {
  // The tools whose result can change an app's files, as the App IDE refreshes on.
  const FILE_CHANGING_TOOLS = new Set(['write', 'edit', 'build_app', 'bash']);
  const TAB_KEY = (mode) => `lax_side_tab_${mode}`;
  let view = 'preview';
  let shownApp = null;
  let refreshTimer = null;

  function activeAppId() {
    const id = activeChat && activeChat.id;
    return typeof id === 'string' && id.startsWith('ide-') ? id.slice('ide-'.length) : null;
  }

  function el(id) { return document.getElementById(id); }

  function isShown() {
    const body = el('preview-tab-body');
    return !!body && body.style.display !== 'none';
  }

  function render() {
    const appId = activeAppId();
    const empty = el('preview-tab-empty');
    const frame = el('preview-tab-frame');
    const files = el('preview-tab-files');
    const title = el('preview-tab-title');
    if (!frame || !files || !empty) return;
    // A session with no messages yet carries the server's placeholder title.
    if (title) title.textContent = appId ? (activeChat.title && activeChat.title !== 'New Chat' ? activeChat.title : appId) : '';
    if (!appId) {
      shownApp = null;
      frame.style.display = 'none';
      files.style.display = 'none';
      empty.style.display = '';
      empty.textContent = 'Nothing to preview yet. Open an app with Edit, or build one, and it shows here.';
      return;
    }
    empty.style.display = 'none';
    frame.style.display = view === 'preview' ? '' : 'none';
    files.style.display = view === 'code' ? '' : 'none';
    if (view === 'preview' && shownApp !== appId) {
      shownApp = appId;
      loadAppPreview(frame, appId, (id) => id === activeAppId());
    }
    if (view === 'code') loadAppFileTree(el('preview-tab-tree'), appId, 'openPreviewFile');
  }

  function setView(next) {
    view = next === 'code' ? 'code' : 'preview';
    for (const v of ['preview', 'code']) {
      const btn = el(`preview-view-${v}`);
      if (btn) { btn.classList.toggle('active', v === view); btn.setAttribute('aria-pressed', String(v === view)); }
    }
    render();
  }

  function refresh() {
    shownApp = null;
    render();
  }

  async function openFile(name) {
    const appId = activeAppId();
    if (!appId) return;
    const text = await fetchAppFile(appId, name);
    el('preview-tab-file-name').textContent = name;
    el('preview-tab-file-content').textContent = text === null ? 'Failed to load file' : text;
    el('preview-tab-tree').style.display = 'none';
    el('preview-tab-viewer').style.display = 'flex';
  }

  function closeFile() {
    el('preview-tab-tree').style.display = '';
    el('preview-tab-viewer').style.display = 'none';
  }

  /** The mode of the chat now open (sidebar-mode.js chatModeOf). */
  function currentMode() {
    return typeof chatModeOf === 'function' && chatModeOf(activeChat) === 'code' ? 'code' : 'chat';
  }

  // Refresh after the agent changes files or ends its turn, debounced so
  // writes reach disk first (the App IDE waits the same 500ms).
  if (window.ChatStreamStore && typeof ChatStreamStore.subscribeAll === 'function') {
    ChatStreamStore.subscribeAll(function(sessionId, _entry, ev) {
      if (!ev || !activeChat || sessionId !== activeChat.id || !isShown()) return;
      const changed = (ev.type === 'tool_end' && FILE_CHANGING_TOOLS.has(ev.toolName)) || ev.type === 'done';
      if (!changed) return;
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(function() { refreshTimer = null; refresh(); }, 500);
    });
  }

  window.laxPreviewTab = {
    onTabShown: render,
    /** The chat now open changed: re-render if the tab is showing. */
    onChatChanged: function() { if (isShown()) render(); },
    /** Remember the tab just chosen for the mode of the chat now open. */
    rememberTab: function(tab) { try { localStorage.setItem(TAB_KEY(currentMode()), tab); } catch {} },
    /** The tab the panel should open on: a code session's remembered one, Preview by default. */
    openingTab: function() {
      if (currentMode() !== 'code') return null;
      try { return localStorage.getItem(TAB_KEY('code')) || 'preview'; } catch { return 'preview'; }
    },
  };
  window.setPreviewView = setView;
  window.refreshPreviewTab = refresh;
  window.openPreviewFile = openFile;
  window.closePreviewFile = closeFile;
})();
