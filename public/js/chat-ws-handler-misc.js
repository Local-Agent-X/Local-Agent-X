// ── Chat WS: top-level (non-event) message handlers ──
// Covers msg.type families that are NOT msg.type === 'event': agent-driven
// settings changes, sidebar pin sync, pinned-app iframe reload, and the
// legacy agent-* feed events.

function handleSettingsChanged(msg) {
  if (msg.settings.theme && typeof applyTheme === 'function') {
    localStorage.setItem('sax_theme', msg.settings.theme);
    applyTheme(msg.settings.theme);
    // Agent-driven theme changes arrive here (not via toggleTheme), so mirror
    // the choice to the Electron wrapper too — otherwise the renderer flips
    // CSS but the native Windows titleBarOverlay (top-right min/max/X strip)
    // keeps its old color until the user manually toggles theme twice.
    try { window.desktop?.setSetting?.('theme', msg.settings.theme); } catch {}
  }
  // Provider / model change from agent → force-refresh the status bar's
  // dropdowns so it stops showing the stale previous provider.
  if (msg.settings.provider || msg.settings.model) {
    try { const s = JSON.parse(localStorage.getItem('sax_settings') || '{}');
      if (msg.settings.provider) s.provider = msg.settings.provider;
      if (msg.settings.model) s.model = msg.settings.model;
      localStorage.setItem('sax_settings', JSON.stringify(s)); } catch {}
    _providersCacheTime = 0;
    if (typeof loadProviders === 'function') loadProviders().then(() => updateStatusBar()).catch(() => {});
  }
  // Tool Policy toggles (enableShell / enableHttp / enableBrowser) →
  // re-sync the DOM state so the settings page reflects what the agent
  // (or another tab) just flipped. Without this the toggles stay green
  // even though config.json says off, and the user reasonably asks
  // "is the agent lying?" Live failure 2026-05-19.
  if ('enableShell' in msg.settings || 'enableHttp' in msg.settings || 'enableBrowser' in msg.settings) {
    if (typeof setToolPolicyToggle === 'function') {
      if ('enableShell' in msg.settings)   setToolPolicyToggle('tp-toggle-shell',   msg.settings.enableShell   !== false);
      if ('enableHttp' in msg.settings)    setToolPolicyToggle('tp-toggle-http',    msg.settings.enableHttp    !== false);
      if ('enableBrowser' in msg.settings) setToolPolicyToggle('tp-toggle-browser', msg.settings.enableBrowser !== false);
    }
  }
}

function handleSidebarPinsChanged(msg) {
  try {
    _sidebarPins = msg.pins;
    renderSidebarPins();
  } catch(e) { /* app.js not loaded yet — will pick up on next page load */ }
}

// Agent (or another tab) asked to wipe the Conversations list from the
// sidebar. Tombstone non-integration chat IDs so sync doesn't resurrect
// them, but PRESERVE wa-/tg-/sms- sessions — those drive the Messaging
// section, not Conversations, and were getting nuked by the original
// implementation. Also un-tombstones any integration IDs an earlier
// version of this handler wrongly tombstoned, so the Messaging section
// self-heals on next sidebar_clear call (or page load + refresh).
// Backend session files are NOT touched — recovery for the conversation
// IDs is "clear tombstones."
function _isIntegrationSessionId(id) {
  return typeof id === 'string' && (id.startsWith('wa-') || id.startsWith('tg-') || id.startsWith('sms-'));
}
function handleSidebarClearChats() {
  try {
    // Heal prior mistake: drop any integration-prefix tombstones so the
    // Messaging section comes back on next sync.
    try {
      const t = JSON.parse(localStorage.getItem('sax_deleted_sessions') || '{}');
      let mutated = false;
      for (const k of Object.keys(t)) {
        if (_isIntegrationSessionId(k)) { delete t[k]; mutated = true; }
      }
      if (mutated) localStorage.setItem('sax_deleted_sessions', JSON.stringify(t));
    } catch {}

    if (typeof chats !== 'undefined' && Array.isArray(chats)) {
      const keepers = [];
      for (const c of chats) {
        if (!c || !c.id) continue;
        if (_isIntegrationSessionId(c.id)) { keepers.push(c); continue; }
        if (typeof markDeleted === 'function') markDeleted(c.id);
      }
      chats = keepers;
      try { window.chats = chats; } catch {}
    }
    if (typeof activeChat !== 'undefined' && activeChat && !_isIntegrationSessionId(activeChat.id)) {
      activeChat = null;
      try { window.activeChat = null; } catch {}
    }
    if (typeof saveChats === 'function') saveChats();
    if (typeof renderSidebar === 'function') renderSidebar();
    if (typeof renderMessages === 'function') renderMessages();
  } catch (e) { console.warn('[sidebar-clear-chats] failed', e); }
}

// Manifest-generator detects edits under workspace/apps/<name>/ and broadcasts.
// Without this, the pinned-app iframe only refreshed on user click — agents
// editing files in the background were invisible until a manual click/refresh.
function handleAppFilesChanged(msg) {
  try {
    const pinIframe = document.getElementById('pin-iframe');
    if (pinIframe && pinIframe.src) {
      // Match `/apps/<appName>/` anywhere in the iframe URL (post-token, post-cache-bust).
      const needle = '/apps/' + msg.appName + '/';
      if (pinIframe.src.indexOf(needle) !== -1) {
        // Bump the cache-bust timestamp so the iframe refetches
        const url = new URL(pinIframe.src, window.location.origin);
        url.searchParams.set('_t', Date.now().toString());
        pinIframe.src = url.toString();
      }
    }
  } catch(e) { console.warn('[app-files-changed] iframe reload failed', e); }
}

function handleAgentFeedEvent(msg) {
  if (msg.type === 'agent-spawn' && msg.agentId) {
    if (typeof addAgentFeed === 'function') addAgentFeed({ id: msg.agentId, name: msg.name, role: msg.role, status: msg.status || 'working', currentTask: msg.task });
  } else if (msg.type === 'agent-update' && msg.agentId) {
    if (typeof updateAgentFeed === 'function') updateAgentFeed(msg.agentId, msg);
  } else if (msg.type === 'agent-output' && msg.agentId) {
    if (typeof updateAgentFeed === 'function') updateAgentFeed(msg.agentId, { output: msg.output });
  } else if (msg.type === 'agent-complete' && msg.agentId) {
    if (typeof updateAgentFeed === 'function') {
      updateAgentFeed(msg.agentId, { status: msg.success ? 'succeeded' : 'failed', output: msg.result ? '[Result] ' + msg.result.slice(0, 500) : '' });
      // Build a concise one-liner for chat — full details on Agents page
      var statusIcon = msg.success ? '✅' : '❌';
      var fullResult = msg.result || '';
      // Show the full agent result, not just a one-liner
      var agentMsg = statusIcon + ' **Agent ' + (msg.name || msg.agentId || '') + ' ' + (msg.success ? 'completed' : 'failed') + ':**\n\n' + (fullResult || (msg.success ? 'Done.' : 'Agent failed.'));
      // Cap at 5000 chars to prevent UI overflow
      if (agentMsg.length > 5000) agentMsg = agentMsg.slice(0, 5000) + '\n\n[truncated — full result saved to session]';
      addMessageEl('assistant', agentMsg);
      if (activeChat) {
        activeChat.messages.push({ role: 'assistant', content: agentMsg });
        activeChat.updatedAt = Date.now();
        saveChats();
      }
      setTimeout(function() { if (typeof removeAgentFeed === 'function') removeAgentFeed(msg.agentId); }, 10000);
    }
  }
}
