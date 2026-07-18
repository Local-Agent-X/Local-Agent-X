// Browser workspace layout. This reuses the existing Browser panel and live
// #chat-main; browser-tab.js remains the sole owner of native view bounds.
(function () {
  var overlayRenderer = new URLSearchParams(window.location.search).has('browserChatOverlay');
  var browserBridge = window.desktop && window.desktop.browser;
  var workspaceChannel = typeof BroadcastChannel === 'function'
    ? new BroadcastChannel('lax-browser-workspace') : null;
  var active = false;
  var collapsed = false;
  var latestOpen = false;
  var fullButton = null;
  var dockButton = null;
  var latestButton = null;
  var latestCaret = null;
  var lastOverlayKey = '';
  var overlaySessionId = null;
  var overlaySelectingId = null;
  var overlayLatestAvailable = false;
  var overlayLatestKnown = false;
  var lastReportedLatestAvailable = null;

  function requestHostControl(control, value) {
    if (!overlayRenderer || !workspaceChannel) return false;
    workspaceChannel.postMessage({
      type: 'browser-workspace-control', control: control, value: !!value,
      hasLatest: !!latestTurnNode(),
    });
    return true;
  }

  function chatOverlayBounds() {
    var ids = collapsed
      ? ['browser-chat-dock-bar']
      : ['browser-chat-latest', 'messages', 'input-area', 'browser-chat-dock-bar'];
    var rects = ids.map(function (id) {
      var el = document.getElementById(id);
      return el && !el.hidden ? el.getBoundingClientRect() : null;
    }).filter(function (rect) { return rect && rect.width > 0 && rect.height > 0; });
    if (!rects.length) return null;
    var left = Math.min.apply(null, rects.map(function (rect) { return rect.left; }));
    var top = Math.min.apply(null, rects.map(function (rect) { return rect.top; }));
    var right = Math.max.apply(null, rects.map(function (rect) { return rect.right; }));
    var bottom = Math.max.apply(null, rects.map(function (rect) { return rect.bottom; }));
    return {
      x: Math.floor(left), y: Math.floor(top),
      width: Math.ceil(right - left), height: Math.ceil(bottom - top),
    };
  }

  function syncChatOverlay() {
    if (overlayRenderer || !browserBridge || !browserBridge.setChatOverlay) return;
    var bounds = active ? chatOverlayBounds() : null;
    var sessionId = window.activeChat && window.activeChat.id || null;
    var url = new URL(window.location.href);
    url.pathname = '/';
    url.searchParams.set('browserChatOverlay', '1');
    url.hash = 'chat';
    var payload = bounds ? {
      bounds: bounds, overlayUrl: url.toString(), sessionId: sessionId,
      collapsed: collapsed, latestOpen: latestOpen,
    } : null;
    var key = JSON.stringify(payload);
    if (key === lastOverlayKey) return;
    lastOverlayKey = key;
    Promise.resolve(browserBridge.setChatOverlay(payload)).catch(function () {});
  }

  function scheduleBrowserSync() {
    var raf = window.requestAnimationFrame || function (cb) { setTimeout(cb, 16); };
    raf(function () {
      if (window.laxBrowserTab) window.laxBrowserTab.sync();
      syncChatOverlay();
    });
  }

  function selectOverlaySession() {
    if (!overlaySessionId || window.activeChat && window.activeChat.id === overlaySessionId) {
      overlaySelectingId = null;
      return;
    }
    if (overlaySelectingId === overlaySessionId) return;
    if (typeof window.selectChat !== 'function' && typeof selectChat !== 'function') {
      setTimeout(selectOverlaySession, 100);
      return;
    }
    overlaySelectingId = overlaySessionId;
    var sync = typeof syncChatsFromServer === 'function'
      ? Promise.resolve(syncChatsFromServer()) : Promise.resolve();
    sync.then(function () {
      if (overlaySessionId) selectChat(overlaySessionId);
      overlaySelectingId = null;
    }).catch(function () { overlaySelectingId = null; });
  }

  function applyOverlayState(state) {
    if (!state) return;
    active = true;
    collapsed = !!state.collapsed;
    latestOpen = !!state.latestOpen && !collapsed;
    overlaySessionId = state.sessionId || null;
    document.body.classList.add('browser-workspace', 'browser-chat-overlay-renderer');
    document.body.classList.toggle('browser-chat-collapsed', collapsed);
    document.body.classList.toggle('browser-chat-latest-open', latestOpen);
    syncMessagesVisibility();
    markLatestTurn();
    renderControls();
    selectOverlaySession();
  }

  function renderControls() {
    if (fullButton) {
      fullButton.textContent = active ? '\u2922' : '\u26f6';
      fullButton.title = active ? 'Exit full-page Browser' : 'Open full-page Browser';
      fullButton.setAttribute('aria-label', fullButton.title);
      fullButton.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    if (dockButton) {
      dockButton.textContent = collapsed ? '\u2303' : '\u2304';
      dockButton.title = collapsed ? 'Expand chat' : 'Collapse chat';
      dockButton.setAttribute('aria-label', dockButton.title);
      dockButton.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    }
    if (latestButton) {
      latestButton.setAttribute('aria-label', latestOpen ? 'Hide latest turn' : 'Show latest turn');
      latestButton.setAttribute('aria-expanded', latestOpen ? 'true' : 'false');
      if (latestCaret) latestCaret.textContent = latestOpen ? '\u2303' : '\u2304';
    }
  }

  function latestTurnNode() {
    var messages = document.getElementById('messages');
    if (!messages) return null;
    var assistants = messages.querySelectorAll('.msg.assistant');
    return assistants.length ? assistants[assistants.length - 1] : null;
  }

  function syncMessagesVisibility() {
    var messages = document.getElementById('messages');
    if (!messages) return;
    if (!active) {
      messages.style.removeProperty('display');
      return;
    }
    messages.style.display = latestOpen && !collapsed ? 'flex' : 'none';
  }

  function markLatestTurn() {
    var messages = document.getElementById('messages');
    if (!messages) return null;
    var previous = messages.querySelector('.browser-latest-turn');
    var latest = latestTurnNode();
    var hasLatest = overlayLatestKnown ? overlayLatestAvailable : !!latest;
    if (previous && previous !== latest) previous.classList.remove('browser-latest-turn');
    if (latest) latest.classList.add('browser-latest-turn');
    document.body.classList.toggle('browser-chat-has-latest', active && hasLatest);
    if (latestButton) latestButton.hidden = !active || collapsed || !hasLatest;
    if (overlayRenderer && workspaceChannel && lastReportedLatestAvailable !== !!latest) {
      lastReportedLatestAvailable = !!latest;
      workspaceChannel.postMessage({ type: 'browser-workspace-control', control: 'latestAvailable', value: !!latest });
    }
    if (!hasLatest && latestOpen) {
      latestOpen = false;
      document.body.classList.remove('browser-chat-latest-open');
      syncMessagesVisibility();
      renderControls();
      scheduleBrowserSync();
    }
    return latest;
  }

  function setLatestOpen(next) {
    if (requestHostControl('latestOpen', next)) return;
    var latest = markLatestTurn();
    var hasLatest = overlayLatestKnown ? overlayLatestAvailable : !!latest;
    latestOpen = !!next && active && !collapsed && hasLatest;
    document.body.classList.toggle('browser-chat-latest-open', latestOpen);
    syncMessagesVisibility();
    renderControls();
    scheduleBrowserSync();
  }

  function updateButtonVisibility() {
    var browserTab = document.getElementById('side-tab-browser');
    if (fullButton && browserTab) fullButton.hidden = !browserTab.classList.contains('active');
  }

  function setCollapsed(next) {
    if (requestHostControl('collapsed', next)) return;
    if (!active) return;
    collapsed = !!next;
    if (collapsed) latestOpen = false;
    document.body.classList.toggle('browser-chat-collapsed', collapsed);
    document.body.classList.toggle('browser-chat-latest-open', latestOpen);
    syncMessagesVisibility();
    markLatestTurn();
    renderControls();
    scheduleBrowserSync();
  }

  function setActive(next) {
    active = !!next;
    if (!active) {
      collapsed = false;
      latestOpen = false;
      overlayLatestAvailable = false;
      overlayLatestKnown = false;
    }
    document.body.classList.toggle('browser-workspace', active);
    document.body.classList.toggle('browser-chat-collapsed', active && collapsed);
    document.body.classList.toggle('browser-chat-latest-open', active && latestOpen);
    syncMessagesVisibility();
    markLatestTurn();
    renderControls();
    scheduleBrowserSync();
  }

  function createControls() {
    var host = document.querySelector('.agent-feeds-header') ||
      document.getElementById('browser-address-bar');
    if (!overlayRenderer && host && !document.getElementById('browser-workspace-toggle')) {
      fullButton = document.createElement('button');
      fullButton.id = 'browser-workspace-toggle';
      fullButton.type = 'button';
      fullButton.className = 'artifact-filter browser-workspace-toggle';
      fullButton.addEventListener('click', function () { setActive(!active); });
      host.appendChild(fullButton);
    } else {
      fullButton = document.getElementById('browser-workspace-toggle');
    }

    var chat = document.getElementById('chat-main');
    if (chat && !document.getElementById('browser-chat-dock-bar')) {
      var bar = document.createElement('div');
      bar.id = 'browser-chat-dock-bar';
      var label = document.createElement('span');
      label.textContent = 'CHAT';
      bar.appendChild(label);
      dockButton = document.createElement('button');
      dockButton.id = 'browser-chat-collapse';
      dockButton.type = 'button';
      dockButton.addEventListener('click', function () { setCollapsed(!collapsed); });
      bar.appendChild(dockButton);
      chat.insertBefore(bar, chat.firstChild);
    } else {
      dockButton = document.getElementById('browser-chat-collapse');
    }
    var messages = document.getElementById('messages');
    if (chat && messages && !document.getElementById('browser-chat-latest')) {
      latestButton = document.createElement('button');
      latestButton.id = 'browser-chat-latest';
      latestButton.type = 'button';
      latestButton.setAttribute('aria-label', 'Show latest turn');
      var latestLabel = document.createElement('span');
      latestLabel.textContent = 'Latest turn';
      latestCaret = document.createElement('span');
      latestCaret.className = 'browser-chat-latest-caret';
      latestButton.appendChild(latestLabel);
      latestButton.appendChild(latestCaret);
      latestButton.addEventListener('click', function () { setLatestOpen(!latestOpen); });
      chat.insertBefore(latestButton, messages);
    } else {
      latestButton = document.getElementById('browser-chat-latest');
      latestCaret = latestButton && latestButton.querySelector('.browser-chat-latest-caret');
    }
    markLatestTurn();
    renderControls();
    updateButtonVisibility();
  }

  function init() {
    createControls();
    var panel = document.getElementById('agent-feeds');
    var page = document.getElementById('page-chat');
    var browserTab = document.getElementById('side-tab-browser');
    var messages = document.getElementById('messages');
    if (workspaceChannel && !overlayRenderer) {
      workspaceChannel.onmessage = function (event) {
        var data = event.data;
        if (!data || data.type !== 'browser-workspace-control') return;
        if (typeof data.hasLatest === 'boolean') {
          overlayLatestAvailable = data.hasLatest;
          overlayLatestKnown = true;
        }
        if (data.control === 'latestAvailable') {
          overlayLatestAvailable = !!data.value;
          overlayLatestKnown = true;
          markLatestTurn();
          scheduleBrowserSync();
        }
        if (data.control === 'latestOpen') setLatestOpen(data.value);
        if (data.control === 'collapsed') setCollapsed(data.value);
      };
    }
    if (overlayRenderer) {
      active = true;
      document.body.classList.add('browser-workspace', 'browser-chat-overlay-renderer');
      syncMessagesVisibility();
      if (browserBridge && browserBridge.onChatOverlayState) {
        browserBridge.onChatOverlayState(applyOverlayState);
      }
      if (typeof MutationObserver !== 'undefined' && messages) {
        new MutationObserver(markLatestTurn).observe(messages, { childList: true, subtree: true });
      }
      renderControls();
      return;
    }
    if (typeof MutationObserver !== 'undefined' && panel) {
      new MutationObserver(function () {
        if (active && panel.classList.contains('collapsed')) setActive(false);
      }).observe(panel, { attributes: true, attributeFilter: ['class'] });
    }
    if (typeof MutationObserver !== 'undefined' && page) {
      new MutationObserver(function () {
        if (active && !page.classList.contains('active')) setActive(false);
      }).observe(page, { attributes: true, attributeFilter: ['class'] });
    }
    if (typeof MutationObserver !== 'undefined' && browserTab) {
      new MutationObserver(updateButtonVisibility)
        .observe(browserTab, { attributes: true, attributeFilter: ['class'] });
    }
    if (typeof MutationObserver !== 'undefined' && messages) {
      new MutationObserver(function () {
        markLatestTurn();
        scheduleBrowserSync();
      }).observe(messages, { childList: true, subtree: true });
    }
    window.addEventListener('resize', scheduleBrowserSync);
  }

  window.laxBrowserWorkspace = {
    toggle: function () { setActive(!active); },
    setActive: setActive,
    setCollapsed: setCollapsed,
    setLatestOpen: setLatestOpen,
    onTabHidden: function () { if (active) setActive(false); },
    isActive: function () { return active; },
    isCollapsed: function () { return collapsed; },
    isLatestOpen: function () { return latestOpen; },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
