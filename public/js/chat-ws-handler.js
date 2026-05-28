// ── Chat WS: top-level message dispatch ──
//
// Sole `chatWs.onmessage` handler. Per-session in-turn events are routed to
// dispatchChatStreamEvent (chat-ws-handler-chat-events.js) which drives the
// ChatStreamStore and renders DOM for the active chat. bg_op_* / worker_*
// events go to dispatchBgOpEvent. Everything else (settings_changed,
// sidebar_pins_changed, app-files-changed, agent-* legacy feed events) is
// handled inline below.
//
// Previously there were two listeners — this one plus a per-turn
// addEventListener attached by _sendMessageWs — coordinated via the
// invisible invariant `if (_liveStreams.has(sessionId)) return`. That gate
// is gone; the store + single dispatcher subsume it.

function handleChatWsMessage(e) {
  let msg;
  try { msg = JSON.parse(e.data); } catch { return; }

  if (msg.type === 'pong') {
    window.chatWsLastPong = Date.now();
    return;
  }

  if (msg.type === 'active_chats') {
    ChatStreamStore.setActiveSidebarSet(msg.sessionIds || []);
    renderSidebar();
    return;
  }

  if (msg.type === 'session_snapshot' && msg.sessionId) {
    reconcileSessionSnapshot(msg);
    return;
  }

  if (msg.type === 'event' && msg.sessionId && msg.event) {
    // Bump per-op activity from the envelope's _opId/_seq so the watchdog
    // stays honest for any event carrying canonical tags — not just the
    // ones applyEvent mutates state for.
    if (msg._opId && typeof msg._seq === 'number') {
      ChatStreamStore.bumpActivity(msg.sessionId, msg._seq);
    }

    // Mid-turn inject lifecycle (Step 4 JARVIS). inject_queued is purely
    // informational — the local echo already exists tagged
    // _queueState:'queued', so nothing to do client-side. inject_consumed
    // drops the queued styling once the server actually drained it.
    if (msg.event.type === 'inject_queued') return;
    if (msg.event.type === 'inject_consumed') { handleInjectConsumed(msg); return; }

    // Worker-pool / background-op events surface in the AGENTS sidebar
    // (not the chat thread). See chat-ws-handler-bg-ops.js.
    if (dispatchBgOpEvent(msg)) return;

    // In-turn chat events — store + DOM side effects for the active chat.
    dispatchChatStreamEvent(msg);

    // If the stream just terminated for a session the user ISN'T viewing,
    // clear its sidebar marker. The server eventually re-broadcasts
    // active_chats, but the local cleanup keeps the dot honest in the
    // intervening seconds.
    if (msg.event.type === 'done' && (!activeChat || activeChat.id !== msg.sessionId)) {
      ChatStreamStore.setSidebarActive(msg.sessionId, false);
      renderSidebar();
    }
    return;
  }

  if (msg.type === 'settings_changed' && msg.settings) handleSettingsChanged(msg);
  if (msg.type === 'sidebar_pins_changed' && msg.pins) handleSidebarPinsChanged(msg);
  if (msg.type === 'sidebar_clear_chats') handleSidebarClearChats(msg);

  // Projects list changed (agent created/added via project_* tools).
  // Mirror createProject(): loadProjects() refreshes the Agents-page
  // dropdown; syncProjectsFromServer() refreshes the chat sidebar.
  if (msg.type === 'projects_changed') {
    try { if (typeof window.loadProjects === 'function') window.loadProjects(); } catch {}
    try { if (typeof window.syncProjectsFromServer === 'function') window.syncProjectsFromServer(); } catch {}
  }

  if (msg.type === 'app-files-changed' && msg.appName) handleAppFilesChanged(msg);

  if (msg.type === 'agent-complete' && msg.agentId) {
    if (window.desktop) window.desktop.showNotification('Agent Finished', msg.result?.slice(0, 100) || 'Task complete');
  }

  handleAgentFeedEvent(msg);
}

function handleInjectConsumed(msg) {
  try {
    const sid = msg.sessionId;
    const chat = (typeof chats !== 'undefined' && Array.isArray(chats)) ? chats.find(c => c.id === sid) : null;
    if (!chat || !Array.isArray(chat.messages)) return;
    const m = chat.messages.find(x => x && x._injectId === msg.event.injectId && x._queueState === 'queued');
    if (!m) return;
    delete m._queueState;
    if (typeof activeChat !== 'undefined' && activeChat && activeChat.id === sid && typeof renderMessages === 'function') {
      renderMessages();
    }
    try { if (typeof saveChats === 'function') saveChats(); } catch {}
  } catch (e) { console.warn('[inject_consumed] failed to clear queue state', e); }
}

// Reconcile renderer-side state against the server's truth on every WS
// subscribe. Two things to fix:
//   1. Worker chips stuck on "working" — the bg_op completion / failure event
//      went out while this client wasn't subscribed (page reload, server
//      restart, leave-and-back). Any chip keyed to this session whose opId
//      isn't in liveOpIds is server-confirmed terminal — flip it to done.
//   2. Chat messages missing — selectChat lazy-hydrates on click, but a user
//      sitting on the chat at WS-(re)connect time never triggers selectChat
//      and stays on the stale localStorage copy. Force a hydrate when
//      server's count exceeds local.
function reconcileSessionSnapshot(msg) {
  try {
    const sessionId = msg.sessionId;
    const liveSet = new Set(msg.liveOpIds || []);

    if (typeof agentFeedsData !== 'undefined') {
      for (const opId of Object.keys(agentFeedsData)) {
        const data = agentFeedsData[opId];
        if (!data || data.sessionId !== sessionId) continue;
        if (liveSet.has(opId)) continue;
        if (data.status === 'done' || data.status === 'failed' || data.status === 'cancelled') continue;
        if (typeof updateAgentFeed === 'function') updateAgentFeed(opId, { status: 'done' });
      }
    }

    if (typeof chats !== 'undefined' && Array.isArray(chats) && typeof msg.messageCount === 'number') {
      const chat = chats.find(c => c.id === sessionId);
      if (chat) {
        const localCount = (chat.messages || []).length;
        if (msg.messageCount > localCount) {
          chat._needsHydrate = true;
          if (typeof hydrateChat === 'function') hydrateChat(chat).catch(() => {});
        }
      }
    }
  } catch (err) {
    console.warn('[session_snapshot] reconcile failed', err);
  }
}
