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
      case 'toggle-agents':   { var b = document.getElementById('agents-toggle'); if (b) b.click(); break; }
      case 'zoom-in':         d.contentZoom && d.contentZoom('in'); break;
      case 'zoom-out':        d.contentZoom && d.contentZoom('out'); break;
      case 'zoom-reset':      d.contentZoom && d.contentZoom('reset'); break;
    }
  }

  // Keyboard accelerators for menu actions Electron doesn't already cover
  // (zoom/devtools) and window.ts doesn't block (reload). Reuses runAction so a
  // shortcut and its menu item always do the same thing.
  document.addEventListener('keydown', function (e) {
    if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
    var action = { a: 'toggle-agents', b: 'open-in-browser', l: 'copy-app-url' }[e.key.toLowerCase()];
    if (action) { e.preventDefault(); runAction(action); }
  });
})();
