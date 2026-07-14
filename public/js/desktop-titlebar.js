// Behavior for the in-window titlebar (Windows/Linux desktop app). The
// markup lives in app.html and is shown only under body.platform-win, set
// by desktop/src/preload.ts. This wires the dropdown open/close interaction
// and routes each item to the window.desktop.* IPC bridge. In a plain
// browser the bar is display:none and window.desktop is undefined, so the
// action calls below no-op harmlessly.
(function () {
  var bar = document.getElementById('desktop-titlebar');
  if (!bar) return;

  var menus = Array.prototype.slice.call(bar.querySelectorAll('.dtb-menu'));
  var anyOpen = function () { return menus.some(function (m) { return m.classList.contains('open'); }); };
  var closeAll = function () { menus.forEach(function (m) { m.classList.remove('open'); }); };

  document.addEventListener('click', function (e) {
    if (!e.target.closest('#desktop-titlebar')) closeAll();
  });

  menus.forEach(function (menu) {
    var btn = menu.querySelector('.dtb-btn');
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var wasOpen = menu.classList.contains('open');
      closeAll();
      if (!wasOpen) menu.classList.add('open');
    });
    // Once a menu is open, hovering a sibling switches to it — standard
    // menubar behavior.
    btn.addEventListener('mouseenter', function () {
      if (anyOpen()) { closeAll(); menu.classList.add('open'); }
    });
  });

  bar.addEventListener('click', function (e) {
    var item = e.target.closest('.dtb-item');
    if (!item) return;
    e.stopPropagation();
    closeAll();
    runAction(item.getAttribute('data-action'));
  });

  function runAction(action) {
    var d = window.desktop || {};
    if (action.indexOf('edit:') === 0) { d.editCommand && d.editCommand(action.slice(5)); return; }
    switch (action) {
      case 'open-in-browser': d.openInBrowser && d.openInBrowser(); break;
      case 'copy-app-url':    d.copyAppUrl && d.copyAppUrl(); break;
      case 'restart-server':  d.restartServer && d.restartServer(); break;
      case 'quit':            d.quit && d.quit(); break;
      case 'toggle-devtools': d.toggleDevTools && d.toggleDevTools(); break;
      case 'minimize':        d.toggleWindow && d.toggleWindow(); break;
      case 'close-to-tray':   d.toggleWindow && d.toggleWindow(); break;
      case 'about':           d.showAbout && d.showAbout(); break;
      case 'reload':          location.reload(); break;
      case 'toggle-agents':   { if (typeof toggleAgentFeeds === 'function') toggleAgentFeeds(); break; }
      case 'zoom-in':         d.contentZoom && d.contentZoom('in'); break;
      case 'zoom-out':        d.contentZoom && d.contentZoom('out'); break;
      case 'zoom-reset':      d.contentZoom && d.contentZoom('reset'); break;
    }
  }

  // NOTE: keyboard accelerators are NOT wired here anymore. They live in the
  // native (hidden) accelerator menu in desktop/src/app-menu.ts so Windows and
  // macOS bind the exact same keys from one source. A renderer keydown listener
  // here would double-fire alongside those accelerators (e.g. toggle agents
  // twice → net no-op), so it was removed. This file now only drives the
  // click/hover behavior of the visible in-window menu.
})();
