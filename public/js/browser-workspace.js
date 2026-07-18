// Browser workspace layout. This reuses the existing Browser panel and live
// #chat-main; browser-tab.js remains the sole owner of native view bounds.
(function () {
  var active = false;
  var collapsed = false;
  var fullButton = null;
  var dockButton = null;

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
  }

  function updateButtonVisibility() {
    var browserTab = document.getElementById('side-tab-browser');
    if (fullButton && browserTab) fullButton.hidden = !browserTab.classList.contains('active');
  }

  function setCollapsed(next) {
    if (!active) return;
    collapsed = !!next;
    document.body.classList.toggle('browser-chat-collapsed', collapsed);
    renderControls();
    scheduleBrowserSync();
  }

  function setActive(next) {
    active = !!next;
    if (!active) collapsed = false;
    document.body.classList.toggle('browser-workspace', active);
    document.body.classList.toggle('browser-chat-collapsed', active && collapsed);
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
    renderControls();
    updateButtonVisibility();
  }

  function init() {
    createControls();
    var panel = document.getElementById('agent-feeds');
    var page = document.getElementById('page-chat');
    var browserTab = document.getElementById('side-tab-browser');
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
  }

  window.laxBrowserWorkspace = {
    toggle: function () { setActive(!active); },
    setActive: setActive,
    setCollapsed: setCollapsed,
    onTabHidden: function () { if (active) setActive(false); },
    isActive: function () { return active; },
    isCollapsed: function () { return collapsed; },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
