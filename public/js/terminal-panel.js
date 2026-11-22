// ── Right panel: the Terminal tab ──
// One shell per chat (desktop/src/terminal-pty.ts), opened in that chat's
// project folder. Each chat's shell has its own pane inside #terminal-host;
// the pane of the chat on screen is the one shown, and the others keep running
// with their scrollback. A shell starts the first time its chat's Terminal tab
// is shown, never just because a chat was opened.
(function () {
  'use strict';

  // chat id ('' with no chat on screen) → that chat's shell.
  var shells = {};
  var removeData = null;
  var removeExit = null;
  var resizeObserver = null;

  function bridge() {
    return window.desktop && window.desktop.terminal;
  }

  function chatKey() {
    try { return (typeof activeChat !== 'undefined' && activeChat && activeChat.id) || ''; } catch (e) { return ''; }
  }

  function shellOf(key) {
    if (!shells[key]) shells[key] = { terminal: null, fitAddon: null, pane: null, started: false, starting: false, generation: 0 };
    return shells[key];
  }

  function showUnavailable(message) {
    var host = document.getElementById('terminal-host');
    var unavailable = document.getElementById('terminal-unavailable');
    if (host) host.style.display = 'none';
    if (unavailable) {
      unavailable.textContent = message || 'Terminal requires the desktop app';
      unavailable.style.display = 'grid';
    }
  }

  // The pane of one chat's shell; only the chat on screen's is displayed.
  function paneOf(key, host) {
    var shell = shellOf(key);
    if (!shell.pane) {
      shell.pane = document.createElement('div');
      shell.pane.className = 'terminal-chat-pane';
      host.appendChild(shell.pane);
    }
    return shell.pane;
  }

  function showPane(key) {
    Object.keys(shells).forEach(function (k) {
      if (shells[k].pane) shells[k].pane.style.display = k === key ? '' : 'none';
    });
  }

  function fit() {
    var key = chatKey();
    var shell = shells[key];
    if (!shell || !shell.started || !shell.fitAddon || !shell.terminal) return;
    shell.fitAddon.fit();
    bridge().resize(shell.terminal.cols, shell.terminal.rows, key);
  }

  // Output and exit arrive tagged with their chat: one listener each routes
  // them to that chat's pane, shown or not.
  function wire(pty) {
    if (removeData) return;
    removeData = pty.onData(function (data, chat) {
      var shell = shells[chat || ''];
      if (shell && shell.terminal) shell.terminal.write(data);
    });
    removeExit = pty.onExit(function (event) {
      var shell = shells[(event && event.chat) || ''];
      if (!shell) return;
      shell.started = false;
      shell.exited = true;
      if (shell.terminal) shell.terminal.write('\r\n\x1b[2m[process exited with code ' + event.exitCode + ']\x1b[0m\r\n');
    });
  }

  // The chat's project folder, where its shell opens; null when it has none
  // (the desktop then opens it in LAX's own folder, as before).
  async function folderOf(key) {
    if (!key || typeof apiJson !== 'function') return null;
    try {
      var data = await apiJson('/api/session-folder?session=' + encodeURIComponent(key));
      return (data && data.folder) || null;
    } catch (e) {
      return null;
    }
  }

  async function start(key) {
    var shell = shellOf(key);
    if (shell.started || shell.starting) return;
    var pty = bridge();
    var host = document.getElementById('terminal-host');
    if (!pty || !host || !window.Terminal || !window.FitAddon) {
      showUnavailable();
      return;
    }
    var run = ++shell.generation;
    shell.exited = false;
    shell.starting = true;
    if (shell.terminal) shell.terminal.dispose();
    var nextTerminal = new window.Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim(),
      fontSize: 12,
      scrollback: 5000,
      theme: terminalTheme(),
    });
    var nextFitAddon = new window.FitAddon.FitAddon();
    shell.terminal = nextTerminal;
    shell.fitAddon = nextFitAddon;
    host.style.display = '';
    var unavailable = document.getElementById('terminal-unavailable');
    if (unavailable) unavailable.style.display = 'none';
    var pane = paneOf(key, host);
    showPane(chatKey());
    nextTerminal.loadAddon(nextFitAddon);
    nextTerminal.open(pane);
    nextFitAddon.fit();
    wire(pty);
    nextTerminal.onData(function (data) {
      if (shell.generation === run) pty.write(data, key);
    });
    try {
      // No chat on screen has no folder to ask for: the shell starts at once.
      var folder = key ? await folderOf(key) : null;
      if (shell.generation !== run) return;
      await pty.create(nextTerminal.cols, nextTerminal.rows, key, folder);
      if (shell.generation !== run || shell.exited) return;
      shell.started = true;
      if (!resizeObserver) {
        resizeObserver = new ResizeObserver(fit);
        resizeObserver.observe(host);
      }
      if (key === chatKey()) nextTerminal.focus();
    } catch (error) {
      if (shell.generation === run) {
        nextTerminal.dispose();
        shell.terminal = null;
        shell.fitAddon = null;
        showUnavailable('Terminal failed to start. Click + to retry.');
      }
    } finally {
      if (shell.generation === run) shell.starting = false;
    }
  }

  function terminalTheme() {
    var styles = getComputedStyle(document.documentElement);
    return {
      background: styles.getPropertyValue('--bg').trim(),
      foreground: styles.getPropertyValue('--text').trim(),
      cursor: styles.getPropertyValue('--accent').trim(),
      selectionBackground: styles.getPropertyValue('--accent-dim').trim(),
    };
  }

  // Close one chat's shell and drop its pane.
  async function disposeShell(key) {
    var shell = shells[key];
    if (shell) {
      shell.generation++;
      if (shell.terminal) shell.terminal.dispose();
      if (shell.pane && shell.pane.parentNode) shell.pane.parentNode.removeChild(shell.pane);
      delete shells[key];
    }
    if (bridge()) await bridge().dispose(key);
  }

  async function dispose() {
    if (resizeObserver) resizeObserver.disconnect();
    resizeObserver = null;
    if (removeData) removeData();
    if (removeExit) removeExit();
    removeData = null;
    removeExit = null;
    await Promise.all(Object.keys(shells).map(disposeShell));
  }

  // "+": a fresh shell for the chat on screen.
  async function restart() {
    var key = chatKey();
    await disposeShell(key);
    await start(key);
  }

  function onTabShown() {
    var key = chatKey();
    var shell = shells[key];
    showPane(key);
    if (shell && shell.started) {
      fit();
      if (shell.terminal) shell.terminal.focus();
      return;
    }
    start(key);
  }

  function tabIsShown() {
    var body = document.getElementById('terminal-tab-body');
    var panelOpen = typeof agentFeedsOpen === 'undefined' || agentFeedsOpen;
    return !!body && body.style.display !== 'none' && panelOpen;
  }

  var restartButton = document.getElementById('terminal-restart');
  if (restartButton) restartButton.addEventListener('click', restart);
  window.addEventListener('beforeunload', dispose);
  window.laxTerminalPanel = {
    onTabShown: onTabShown,
    restart: restart,
    dispose: dispose,
    /** Another chat came on screen: its pane is the one shown, its shell started if the tab is open. */
    onChatChanged: function () { if (tabIsShown()) onTabShown(); else showPane(chatKey()); },
    /** A chat was deleted: its shell goes with it. */
    onChatRemoved: function (id) { if (id) return disposeShell(id); },
  };
})();
