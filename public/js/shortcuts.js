// ── Keyboard Shortcuts & Command Palette ──

// Command palette state
let commandPaletteOpen = false;

// All available commands
function getCommands() {
  const cmds = [
    { id: 'new-chat', label: 'New Chat', shortcut: '', action: () => newChat() },
    { id: 'settings', label: 'Open Settings', shortcut: '', action: () => navigate('settings') },
    { id: 'secrets', label: 'Open Secrets Vault', shortcut: '', action: () => navigate('secrets') },
    { id: 'cron', label: 'Open Cron Jobs', shortcut: '', action: () => navigate('cron') },
    { id: 'chat', label: 'Go to Chat', shortcut: '', action: () => navigate('chat') },
    { id: 'theme-toggle', label: 'Toggle Theme', shortcut: '', action: () => toggleTheme() },
    { id: 'voice-toggle', label: 'Toggle Voice Mode', shortcut: '', action: () => toggleMic() },
    { id: 'tts-toggle', label: 'Toggle TTS', shortcut: '', action: () => toggleTTS() },
    { id: 'focus-input', label: 'Focus Message Input', shortcut: '/', action: () => { document.getElementById('msg-input')?.focus(); } },
    { id: 'search-chats', label: 'Search Chats', shortcut: '', action: () => { document.getElementById('chat-search-input')?.focus(); } },
  ];
  // Add recent chats
  if (typeof chats !== 'undefined') {
    chats.slice(0, 10).forEach(c => {
      cmds.push({ id: 'chat-' + c.id, label: 'Open: ' + (c.title || 'Untitled'), shortcut: '', action: () => selectChat(c.id) });
    });
  }
  return cmds;
}

function openCommandPalette() {
  if (commandPaletteOpen) return;
  commandPaletteOpen = true;
  let overlay = document.getElementById('cmd-palette-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'cmd-palette-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Command palette');
    overlay.innerHTML = `
      <div id="cmd-palette">
        <input id="cmd-search" type="text" placeholder="Type a command..." autocomplete="off" aria-label="Search commands" />
        <div id="cmd-results" role="listbox"></div>
      </div>
    `;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeCommandPalette(); });
    document.body.appendChild(overlay);
  }
  overlay.classList.add('visible');
  const input = document.getElementById('cmd-search');
  input.value = '';
  input.focus();
  renderCommandResults('');

  input.oninput = () => renderCommandResults(input.value);
  input.onkeydown = (e) => {
    if (e.key === 'Escape') { closeCommandPalette(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); moveCmdSelection(1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveCmdSelection(-1); }
    if (e.key === 'Enter') { e.preventDefault(); executeCmdSelection(); }
  };
}

function closeCommandPalette() {
  commandPaletteOpen = false;
  const overlay = document.getElementById('cmd-palette-overlay');
  if (overlay) overlay.classList.remove('visible');
}

let cmdSelectedIdx = 0;
let cmdFilteredList = [];

function renderCommandResults(query) {
  const el = document.getElementById('cmd-results');
  if (!el) return;
  const q = query.toLowerCase().trim();
  cmdFilteredList = getCommands().filter(c => !q || c.label.toLowerCase().includes(q));
  cmdSelectedIdx = 0;
  el.innerHTML = cmdFilteredList.map((c, i) => `
    <div class="cmd-item${i === 0 ? ' selected' : ''}" data-idx="${i}" role="option"
         onmouseenter="highlightCmd(${i})" onclick="executeCmdAt(${i})">
      <span class="cmd-label">${esc(c.label)}</span>
      ${c.shortcut ? `<span class="cmd-shortcut">${esc(c.shortcut)}</span>` : ''}
    </div>
  `).join('') || '<div class="cmd-empty">No matching commands</div>';
}

function highlightCmd(idx) {
  cmdSelectedIdx = idx;
  document.querySelectorAll('.cmd-item').forEach((el, i) => el.classList.toggle('selected', i === idx));
}

function moveCmdSelection(dir) {
  if (cmdFilteredList.length === 0) return;
  cmdSelectedIdx = (cmdSelectedIdx + dir + cmdFilteredList.length) % cmdFilteredList.length;
  document.querySelectorAll('.cmd-item').forEach((el, i) => el.classList.toggle('selected', i === cmdSelectedIdx));
  const selected = document.querySelector('.cmd-item.selected');
  if (selected) selected.scrollIntoView({ block: 'nearest' });
}

function executeCmdSelection() {
  if (cmdFilteredList[cmdSelectedIdx]) {
    closeCommandPalette();
    cmdFilteredList[cmdSelectedIdx].action();
  }
}

function executeCmdAt(idx) {
  if (cmdFilteredList[idx]) {
    closeCommandPalette();
    cmdFilteredList[idx].action();
  }
}

// ── Global keyboard shortcuts ──
document.addEventListener('keydown', (e) => {
  // Ctrl+K — Command palette
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    if (commandPaletteOpen) closeCommandPalette();
    else openCommandPalette();
    return;
  }

  // Ctrl+Enter — Send message
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    const input = document.getElementById('msg-input');
    if (document.activeElement === input || document.activeElement?.closest('#input-area')) {
      e.preventDefault();
      if (typeof sendMessage === 'function') sendMessage();
    }
    return;
  }

  // Escape — Close modals/overlays
  if (e.key === 'Escape') {
    if (commandPaletteOpen) { closeCommandPalette(); return; }
    // Close lightbox
    const lb = document.getElementById('img-preview-overlay');
    if (lb && lb.style.display !== 'none') { lb.style.display = 'none'; return; }
    // Close secret modal
    const sm = document.getElementById('secret-modal-overlay');
    if (sm && sm.classList.contains('visible')) { cancelSecret(); return; }
    // Close install modal
    const im = document.getElementById('install-modal');
    if (im) { im.remove(); return; }
    // Close onboarding
    const ob = document.getElementById('onboarding-overlay');
    if (ob) { ob.remove(); return; }
    // Close mobile sidebar
    const sidebar = document.getElementById('sidebar');
    if (sidebar && sidebar.classList.contains('mobile-open')) {
      sidebar.classList.remove('mobile-open');
      const backdrop = document.getElementById('sidebar-backdrop');
      if (backdrop) backdrop.remove();
      return;
    }
  }
});

// ── Browser Notifications (feature 96) ──
let notificationsEnabled = false;
let taskStartTime = 0;
const LONG_TASK_THRESHOLD = 10000; // 10 seconds

function requestNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') { notificationsEnabled = true; return; }
  if (Notification.permission !== 'denied') {
    Notification.requestPermission().then(p => { notificationsEnabled = (p === 'granted'); });
  }
}

function notifyTaskComplete(title) {
  if (!notificationsEnabled || document.hasFocus()) return;
  if (Date.now() - taskStartTime < LONG_TASK_THRESHOLD) return;
  const n = new Notification('Agent X — Task Complete', {
    body: title || 'Your agent has finished responding.',
    icon: '/favicon.ico',
    tag: 'sax-complete'
  });
  n.onclick = () => { window.focus(); n.close(); };
}

// Hook into streaming lifecycle
const _origSendMessage = typeof sendMessage === 'function' ? sendMessage : null;
document.addEventListener('DOMContentLoaded', () => {
  requestNotificationPermission();
});
// Notification triggers are wired through the streaming events in chat.js via
// window.notifyTaskComplete and window.taskStartTime
window.notifyTaskComplete = notifyTaskComplete;
window.taskStartTime = 0;
