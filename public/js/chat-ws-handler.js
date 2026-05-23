// ── Chat: WebSocket message dispatch ──
//
// Top-level chatWs.onmessage handler, lifted out of connectChatWs to keep
// chat-ws.js under 400 LOC. Pure dispatch — every event is either handled
// inline here (small, dispatcher-local concerns: heartbeat, opId tracking,
// inject lifecycle, active-chat sidebar nudges) or routed to a per-feature
// module:
//   chat-ws-handler-bg-ops.js   → bg_op_* / worker_* / av_blocked_warning
//   chat-ws-handler-misc.js     → settings_changed, sidebar_pins_changed,
//                                 app-files-changed, agent-* feeds
//   chat-ws-handler-build-summary.js → renderBuildRunSummary (used by bg-ops)
// Closures from chat-ws.js (chatWs, activeChatsSet, inflightChatOps) and
// chat.js (streamingSessionId, _liveStreams, addMessageEl, …) resolve at
// call time via the classic-script global lexical environment.

function handleChatWsMessage(e) {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    // Heartbeat pong — server echoed our JSON ping. Bump the
    // lastPong timestamp so the heartbeat loop in chat-ws.js doesn't
    // misclassify the connection as stale and force-reconnect.
    if (msg.type === 'pong') {
      window.chatWsLastPong = Date.now();
      return;
    }

    if (msg.type === 'active_chats') {
      activeChatsSet = new Set(msg.sessionIds || []);
      renderSidebar(); // Update indicators
    }

    if (msg.type === 'event' && msg.sessionId && msg.event) {
      // Track canonical chat opId + seq so we can reconnect-resume after
      // a WS drop. The opId arrives once per turn via `chat_op_started`;
      // every subsequent canonical-tagged event carries `_opId` + `_seq`
      // on the envelope so we know how far we've consumed. Terminal
      // events (done / error) clear the entry.
      //
      // lastActivityMs gets bumped on every per-op event — the
      // stuck-stream watchdog in chat-ws.js reads this to detect when
      // a stream has gone silent for > threshold and force a replay.
      if (msg._opId && inflightChatOps.has(msg._opId)) {
        var inflight = inflightChatOps.get(msg._opId);
        if (typeof msg._seq === 'number') inflight.lastSeenSeq = msg._seq;
        inflight.lastActivityMs = Date.now();
      }
      if (msg.event.type === 'chat_op_started' && msg.event.opId) {
        inflightChatOps.set(msg.event.opId, {
          sessionId: msg.sessionId,
          lastSeenSeq: -1,
          lastActivityMs: Date.now(),
        });
        return;
      }
      if (msg.event.type === 'done' || msg.event.type === 'error') {
        if (msg._opId) inflightChatOps.delete(msg._opId);
      }
      // Mid-turn inject lifecycle (Step 4 JARVIS). `inject_queued` is
      // informational — the local echo already exists tagged _queueState:'queued',
      // so nothing to do client-side. `inject_consumed` drops the queued
      // styling once the server actually drained it (or re-routed it as a
      // fresh turn when no op was running — the orphan-inject race fix).
      if (msg.event.type === 'inject_queued') {
        return;
      }
      if (msg.event.type === 'inject_consumed') {
        try {
          const sid = msg.sessionId;
          const chat = (typeof chats !== 'undefined' && Array.isArray(chats)) ? chats.find(c => c.id === sid) : null;
          if (chat && Array.isArray(chat.messages)) {
            const m = chat.messages.find(x => x && x._injectId === msg.event.injectId && x._queueState === 'queued');
            if (m) {
              delete m._queueState;
              if (typeof activeChat !== 'undefined' && activeChat && activeChat.id === sid && typeof renderMessages === 'function') {
                renderMessages();
              }
              try { if (typeof saveChats === 'function') saveChats(); } catch {}
            }
          }
        } catch(e) { console.warn('[inject_consumed] failed to clear queue state', e); }
        return;
      }

      // Worker-pool ops surface in the AGENTS sidebar (not the chat thread)
      // so background work doesn't pollute the conversation. See
      // chat-ws-handler-bg-ops.js for the per-event handlers + the full
      // queued → working → completed lifecycle.
      if (dispatchBgOpEvent(msg)) return;

      // If we're viewing this chat AND it's the one streaming via SSE, skip WS events (avoid duplicates)
      if (activeChat && activeChat.id === msg.sessionId && streamingSessionId === msg.sessionId) {
        return;
      }
      // If we're NOT viewing this chat but it's active, update sidebar indicator
      if (!activeChat || activeChat.id !== msg.sessionId) {
        if (msg.event.type === 'done') {
          activeChatsSet.delete(msg.sessionId);
          renderSidebar();
        }
      }
    }

    // ── Agent-triggered settings changes (theme, provider, etc.) ──
    if (msg.type === 'settings_changed' && msg.settings) {
      handleSettingsChanged(msg);
    }

    // ── Sidebar pins changed (agent pinned/unpinned a page) ──
    if (msg.type === 'sidebar_pins_changed' && msg.pins) {
      handleSidebarPinsChanged(msg);
    }

    // ── App files changed: auto-reload any pinned iframe pointing at that app ──
    if (msg.type === 'app-files-changed' && msg.appName) {
      handleAppFilesChanged(msg);
    }

    // ── Desktop notifications for important events ──
    if (msg.type === 'agent-complete' && msg.agentId) {
      if (window.desktop) window.desktop.showNotification('Agent Finished', msg.result?.slice(0, 100) || 'Task complete');
    }

    // ── Agent feed events (inline — no monkey-patching needed) ──
    handleAgentFeedEvent(msg);
}
