// ── Chat WS: top-level (non-event) message handlers ──
// Covers msg.type families that are NOT msg.type === 'event': agent-driven
// settings changes, sidebar pin sync, pinned-app iframe reload, and the
// legacy agent-* feed events.

function handleSettingsChanged(msg) {
  if (msg.settings.theme && typeof applyTheme === 'function') {
    localStorage.setItem('lax_theme', msg.settings.theme);
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
    try { const s = JSON.parse(localStorage.getItem('lax_settings') || '{}');
      if (msg.settings.provider) s.provider = msg.settings.provider;
      if (msg.settings.model) s.model = msg.settings.model;
      localStorage.setItem('lax_settings', JSON.stringify(s)); } catch {}
    _providersCacheTime = 0;
    if (typeof loadProviders === 'function') loadProviders().then(() => updateStatusBar()).catch(() => {});
  }
  // Tool Policy toggles (enableShell / enableHttp / enableBrowser) →
  // re-sync the DOM state so the settings page reflects what the agent
  // (or another tab) just flipped. Without this the toggles stay green
  // even though config.json says off, and the user reasonably asks
  // "is the agent lying?" Live failure 2026-05-19.
  if ('enableShell' in msg.settings || 'enableHttp' in msg.settings || 'enableBrowser' in msg.settings || 'enableComputerControl' in msg.settings || 'enableRemoteControl' in msg.settings) {
    if (typeof setToolPolicyToggle === 'function') {
      if ('enableShell' in msg.settings)   setToolPolicyToggle('tp-toggle-shell',   msg.settings.enableShell   !== false);
      if ('enableHttp' in msg.settings)    setToolPolicyToggle('tp-toggle-http',    msg.settings.enableHttp    !== false);
      if ('enableBrowser' in msg.settings) setToolPolicyToggle('tp-toggle-browser', msg.settings.enableBrowser !== false);
      // Panic hotkey broadcasts both kill-switches false on disarm — flip the UI toggles off too.
      if ('enableComputerControl' in msg.settings) setToolPolicyToggle('tp-toggle-computer', msg.settings.enableComputerControl === true);
      if ('enableRemoteControl' in msg.settings) setToolPolicyToggle('tp-toggle-remote', msg.settings.enableRemoteControl === true);
    }
  }
  if ('browserMode' in msg.settings && typeof renderBrowserMode === 'function') {
    renderBrowserMode(msg.settings.browserMode);
  }
  if ('learningMode' in msg.settings && typeof renderLearningMode === 'function') {
    renderLearningMode(msg.settings.learningMode);
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
      const t = JSON.parse(localStorage.getItem('lax_deleted_sessions') || '{}');
      let mutated = false;
      for (const k of Object.keys(t)) {
        if (_isIntegrationSessionId(k)) { delete t[k]; mutated = true; }
      }
      if (mutated) localStorage.setItem('lax_deleted_sessions', JSON.stringify(t));
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
    // parentAgentId rides the agent-spawn event (invoke.ts → handler-events.ts).
    // Stamp it as the card's parentOpId so a child spawned by another card (e.g.
    // an auto-build chunk runner under its orchestrator, whose card id === that
    // parent op id) nests under it. null (a chat-spawned agent with no worker
    // parent) → parentOpId undefined → the card renders as a root, unchanged.
    if (typeof addAgentFeed === 'function') addAgentFeed({ id: msg.agentId, name: msg.name, role: msg.role, status: msg.status || 'working', currentTask: msg.task, parentOpId: msg.parentAgentId || undefined });
  } else if (msg.type === 'agent-update' && msg.agentId) {
    if (typeof updateAgentFeed === 'function') updateAgentFeed(msg.agentId, msg);
  } else if (msg.type === 'agent-output' && msg.agentId) {
    if (typeof updateAgentFeed === 'function') updateAgentFeed(msg.agentId, { output: msg.output });
  } else if (msg.type === 'agent-complete' && msg.agentId) {
    if (typeof updateAgentFeed === 'function') {
      updateAgentFeed(msg.agentId, { status: msg.success ? 'succeeded' : 'failed', output: msg.result ? '[Result] ' + msg.result.slice(0, 500) : '' });
      setTimeout(function() { if (typeof removeAgentFeed === 'function') removeAgentFeed(msg.agentId); }, 10000);
    }
    routeAgentCompleteToChat(msg);
  }
}

// Where an agent-complete report belongs. Pure (no globals) so the decision
// is unit-testable without a DOM — test/chat-ws-agent-complete-routing.test.ts.
// The server broadcast (handler-events-agent-result.ts) carries `sessionId`
// (string, "" when the spawn had no parent session) and `parentAgentId`
// (string | null).
//   parentAgentId set → an orchestrator child (auto-build chunk runner, worker
//                       sub-spawn). Its parent folds the result into its own
//                       report; the sidebar card is the only surface. Never
//                       chat, never a desktop notification. (Every chunk
//                       runner's STATUS/DONE_WHEN block used to land in the
//                       open chat this way.)
//   sessionId === active → render live into the open view + store on it.
//   sessionId names another chat → store on that chat only, no render.
//   sessionId "" → the spawn had no parent session (auto-fix workers,
//                       agent-wakeup, issue-update, escalation, the
//                       agents/templates route — all parentAgentId null). The
//                       server persists no chat row for these, so neither do
//                       we: card update only, no notification. Product
//                       consequence: the templates route loses its transient
//                       chat echo — which vanished on the next server-wins
//                       hydrate anyway.
//   sessionId key absent → a server that predates the field: legacy append
//                       to the open chat, whatever it is.
function agentCompleteRouting(msg, activeChatId) {
  if (msg.parentAgentId) return { render: false, store: null, notify: false };
  if (!('sessionId' in msg)) return { render: true, store: activeChatId || null, notify: true };
  var sid = typeof msg.sessionId === 'string' ? msg.sessionId : '';
  if (!sid) return { render: false, store: null, notify: false };
  if (sid === activeChatId) return { render: true, store: sid, notify: true };
  return { render: false, store: sid, notify: true };
}

function routeAgentCompleteToChat(msg) {
  var active = (typeof activeChat !== 'undefined' && activeChat) ? activeChat : null;
  var route = agentCompleteRouting(msg, active ? active.id : null);
  if (!route.render && !route.store) return;
  var fullResult = msg.result || '';
  // Exactly the row the server persists into this session
  // (handler-events-agent-result.ts: `**Agent <name> completed|failed:**\n\n<result>`,
  // "failed" iff success === false). Byte-identical content is what lets the
  // next hydrate classify the server copy as 'skip' (_hydrateRepaintMode
  // compares role + content) instead of a full repaint that silently swapped
  // the row — so no ✅/❌ prefix. Full result, no cap: normal assistant
  // replies render full-length (addMessageEl applies no limit), and the old
  // 5000-char cap clipped long research/planning outputs AND persisted the
  // clipped copy, so a reload lost the tail permanently.
  var failed = msg.success === false;
  var label = 'Agent ' + (msg.name || msg.agentId || '') + (failed ? ' failed' : ' completed');
  var agentMsg = '**' + label + ':**\n\n' + (fullResult || (failed ? 'Agent failed.' : 'Done.'));
  if (route.render && typeof addMessageEl === 'function') addMessageEl('assistant', agentMsg);
  var chat = null;
  if (route.store) {
    if (active && active.id === route.store) chat = active;
    else if (typeof chats !== 'undefined' && Array.isArray(chats)) chat = chats.find(function(c) { return c && c.id === route.store; }) || null;
  }
  if (!chat || !Array.isArray(chat.messages)) return;
  // The server persists this same row into the session. There is no message
  // id, so hydrateChat can't dedupe by id — it replaces chat.messages
  // wholesale unless the local copy is newer/longer (keptLocal). Identical
  // content makes the later hydrate a no-op for this row: no duplicate, no swap.
  chat.messages.push({ role: 'assistant', content: agentMsg });
  if (route.render) {
    // Active chat: bump updatedAt (status quo) — local stays authoritative on
    // the next hydrate, and the active chat holds the full history.
    chat.updatedAt = Date.now();
  } else {
    // Another chat: do NOT bump updatedAt. A non-active chat is often a
    // metadata stub (messages: []), and hydrateChat keeps the LOCAL copy
    // whenever chat.updatedAt is newer than the server's — a bumped stub
    // would replace the full server history with this one row. Flag it so
    // the next select re-fetches server truth (which already has the row).
    chat._needsHydrate = true;
  }
  if (typeof saveChats === 'function') saveChats();
}
