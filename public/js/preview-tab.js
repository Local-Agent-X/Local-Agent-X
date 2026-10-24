// ── Right panel: the Preview tab ──
// A code session's app (an App IDE session, `ide-<appId>`, src/session/mode.ts),
// shown live or as its files by the Preview / Code switch. The loaders are the
// App IDE's own (apps-ide-tools-files.js loadAppPreview / loadAppFileTree /
// fetchAppFile), so an agent-built app is shown one way, from the agent origin,
// and Select is the App IDE's element picker (apps-ide-picker.js), whose picks
// go into the main chat's composer. It refreshes when the session's agent
// changes files or finishes a turn.
//
// The panel's tab belongs to each chat: switching chats turns the open panel
// to the tab that chat last had, and a chat that never chose one gets its
// mode's default — Preview for a code session, the panel's own default
// (Agents) for a chat — so a chat never shows another chat's app. Remembered
// per machine (localStorage).

(function() {
  // The tools whose result can change an app's files, as the App IDE refreshes on.
  const FILE_CHANGING_TOOLS = new Set(['write', 'edit', 'build_app', 'bash']);
  const TAB_BY_CHAT_KEY = 'lax_side_tab_by_chat';
  const TABS_REMEMBERED = 200;
  const DEFAULT_TAB = { code: 'preview', chat: 'agents' };
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

  /** The mode of the chat now open (sidebar-mode.js chatModeOf). */
  function currentMode() {
    return typeof chatModeOf === 'function' && chatModeOf(activeChat) === 'code' ? 'code' : 'chat';
  }

  function tabsByChat() {
    try { return JSON.parse(localStorage.getItem(TAB_BY_CHAT_KEY) || '{}') || {}; } catch { return {}; }
  }

  /** The tab the chat now open should show: its own last one, else its mode's default. */
  function tabForChat() {
    const own = activeChat && tabsByChat()[activeChat.id];
    return own || DEFAULT_TAB[currentMode()];
  }

  function setPicker(on) {
    if (typeof togglePicker === 'function') togglePicker('preview', on);
  }

  /** Unload an app the chat now open does not own, shown or not, and stop its picker. */
  function dropForeignApp() {
    const frame = el('preview-tab-frame');
    if (shownApp === null || shownApp === activeAppId() || !frame) return;
    frame.src = 'about:blank';
    setPicker(false);
    shownApp = null;
  }

  function render() {
    const appId = activeAppId();
    const empty = el('preview-tab-empty');
    const frame = el('preview-tab-frame');
    const files = el('preview-tab-files');
    const title = el('preview-tab-title');
    const picker = el('preview-picker-btn');
    if (!frame || !files || !empty) return;
    // A session with no messages yet carries the server's placeholder title.
    if (title) title.textContent = appId ? (activeChat.title && activeChat.title !== 'New Chat' ? activeChat.title : appId) : '';
    if (picker) picker.style.display = appId && view === 'preview' ? '' : 'none';
    dropForeignApp();
    if (!appId) {
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
      loadAppPreview(frame, appId, (id) => id === activeAppId(), () => pickerOnPreviewLoad('preview'));
    }
    if (view === 'code') loadAppFileTree(el('preview-tab-tree'), appId, 'openPreviewFile');
  }

  function setView(next) {
    view = next === 'code' ? 'code' : 'preview';
    for (const v of ['preview', 'code']) {
      const btn = el(`preview-view-${v}`);
      if (btn) { btn.classList.toggle('active', v === view); btn.setAttribute('aria-pressed', String(v === view)); }
    }
    if (view === 'code') setPicker(false);
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
    /** The chat now open changed: an open panel turns to that chat's tab. */
    onChatChanged: function() {
      // Nothing of another chat's app keeps running behind this chat's tab.
      dropForeignApp();
      const panelOpen = typeof agentFeedsOpen !== 'undefined' && agentFeedsOpen;
      const want = tabForChat();
      if (panelOpen && typeof switchSidePanelTab === 'function' && typeof sidePanelTab !== 'undefined' && sidePanelTab !== want) {
        switchSidePanelTab(want);
      } else if (isShown()) {
        render();
      }
    },
    /** Remember the tab just chosen for the chat now open. */
    rememberTab: function(tab) {
      if (!activeChat || !activeChat.id) return;
      try {
        const byChat = tabsByChat();
        delete byChat[activeChat.id];
        byChat[activeChat.id] = tab;
        const ids = Object.keys(byChat);
        for (const id of ids.slice(0, Math.max(0, ids.length - TABS_REMEMBERED))) delete byChat[id];
        localStorage.setItem(TAB_BY_CHAT_KEY, JSON.stringify(byChat));
      } catch {}
    },
    /** The tab the panel opens on for the chat now open. */
    openingTab: tabForChat,
  };
  window.setPreviewView = setView;
  window.refreshPreviewTab = refresh;
  window.openPreviewFile = openFile;
  window.closePreviewFile = closeFile;
})();
