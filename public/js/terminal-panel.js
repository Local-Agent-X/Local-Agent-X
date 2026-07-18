(function () {
  'use strict';

  var terminal = null;
  var fitAddon = null;
  var started = false;
  var starting = false;
  var removeData = null;
  var removeExit = null;
  var resizeObserver = null;
  var generation = 0;

  function bridge() {
    return window.desktop && window.desktop.terminal;
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

  function fit() {
    if (!started || !fitAddon || !terminal) return;
    fitAddon.fit();
    bridge().resize(terminal.cols, terminal.rows);
  }

  async function start() {
    if (started || starting) return;
    var pty = bridge();
    var host = document.getElementById('terminal-host');
    if (!pty || !host || !window.Terminal || !window.FitAddon) {
      showUnavailable();
      return;
    }
    var run = ++generation;
    var exited = false;
    starting = true;
    var nextTerminal = new window.Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim(),
      fontSize: 12,
      scrollback: 5000,
      theme: terminalTheme(),
    });
    var nextFitAddon = new window.FitAddon.FitAddon();
    terminal = nextTerminal;
    fitAddon = nextFitAddon;
    host.style.display = '';
    var unavailable = document.getElementById('terminal-unavailable');
    if (unavailable) unavailable.style.display = 'none';
    nextTerminal.loadAddon(nextFitAddon);
    nextTerminal.open(host);
    nextFitAddon.fit();
    removeData = pty.onData(function (data) {
      if (generation === run) nextTerminal.write(data);
    });
    removeExit = pty.onExit(function (event) {
      if (generation !== run) return;
      exited = true;
      nextTerminal.write('\r\n\x1b[2m[process exited with code ' + event.exitCode + ']\x1b[0m\r\n');
      started = false;
    });
    nextTerminal.onData(function (data) {
      if (generation === run) pty.write(data);
    });
    try {
      await pty.create(nextTerminal.cols, nextTerminal.rows);
      if (generation !== run || exited) return;
      started = true;
      resizeObserver = new ResizeObserver(fit);
      resizeObserver.observe(host);
      nextTerminal.focus();
    } catch (error) {
      if (generation === run) {
        nextTerminal.dispose();
        terminal = null;
        fitAddon = null;
        showUnavailable('Terminal failed to start. Click + to retry.');
      }
    } finally {
      if (generation === run) starting = false;
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

  async function dispose() {
    generation++;
    if (resizeObserver) resizeObserver.disconnect();
    resizeObserver = null;
    if (removeData) removeData();
    if (removeExit) removeExit();
    removeData = null;
    removeExit = null;
    if (terminal) terminal.dispose();
    terminal = null;
    fitAddon = null;
    started = false;
    starting = false;
    if (bridge()) await bridge().dispose();
  }

  async function restart() {
    await dispose();
    await start();
  }

  function onTabShown() {
    if (started) {
      fit();
      if (terminal) terminal.focus();
      return;
    }
    start();
  }

  var restartButton = document.getElementById('terminal-restart');
  if (restartButton) restartButton.addEventListener('click', restart);
  window.addEventListener('beforeunload', dispose);
  window.laxTerminalPanel = { onTabShown: onTabShown, restart: restart, dispose: dispose };
})();
