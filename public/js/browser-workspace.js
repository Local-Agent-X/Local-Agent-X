// Browser workspace layout. This reuses the existing Browser panel and live
// #chat-main; browser-tab.js remains the sole owner of native view bounds.
(function () {
  var active = false;
  var collapsed = false;
  var latestOpen = false;
  var fullButton = null;
  var dockButton = null;
  var latestButton = null;
  var latestCaret = null;

  function scheduleBrowserSync() {
    var raf = window.requestAnimationFrame || function (cb) { setTimeout(cb, 16); };
    raf(function () {
      if (window.laxBrowserTab) window.laxBrowserTab.sync();
    });
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
    if (previous && previous !== latest) previous.classList.remove('browser-latest-turn');
    if (latest) latest.classList.add('browser-latest-turn');
    document.body.classList.toggle('browser-chat-has-latest', active && !!latest);
    if (latestButton) latestButton.hidden = !active || collapsed || !latest;
    if (!latest && latestOpen) {
      latestOpen = false;
      document.body.classList.remove('browser-chat-latest-open');
      syncMessagesVisibility();
      renderControls();
      scheduleBrowserSync();
    }
    return latest;
  }

  function setLatestOpen(next) {
    var latest = markLatestTurn();
    latestOpen = !!next && active && !collapsed && !!latest;
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
    if (host && !document.getElementById('browser-workspace-toggle')) {
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
      new MutationObserver(markLatestTurn).observe(messages, { childList: true, subtree: true });
    }
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
