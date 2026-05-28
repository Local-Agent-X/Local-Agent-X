// ── Chat WS: per-session in-turn event dispatch ──
//
// Single home for stream / tool_* / secret_* / approval_* / visual /
// context_status / stopped / error event handling. Lifted out of the
// per-turn wsHandler in chat-send-ws.js: that handler used to re-attach
// `chatWs.addEventListener('message', …)` on every send, which meant TWO
// listeners ran on every event (this module's parent dispatcher + the
// per-turn handler) coordinated through the invisible invariant
// `if (_liveStreams.has(sessionId)) return`. Now there's one listener —
// the dispatcher — and it routes per-session events through here.
//
// Per event:
//   1. ChatStreamStore.applyEvent absorbs the event into per-session state
//      (content / toolEvents / chips / progressByTool / approvals /
//      stopNote / opId / status).
//   2. rerenderLiveMessage swaps the live bubble from that state.
//   3. The case bodies below ONLY handle side effects that aren't bubble
//      DOM — feedTTS, voice sphere, secret modals, context bar, console
//      debug, and the legacy agent_spawn/_status HTTP-fallback inline
//      cards. Bubble DOM for stream / tool_* / approval_* / stopped /
//      error is fully owned by the store + swap; the surgical paints that
//      used to live here were deleted in Phase 3.
//
// External deps (auto-window from sibling scripts):
//   activeChat                                          (app-state.js)
//   _findStreamingBodyEl                                (chat-ws.js)
//   showSecretModal, showMultiSecretModal               (secret-modal.js)
//   updateContextBar                                    (chat-status-bar.js)
//   feedTTS                                             (chat-voice-tts.js)
//   VoiceSphere                                         (chat-voice-ui.js)
//   addAgentFeed, updateAgentFeed, renderAgentCard_inline (chat-agent-feeds.js)

function dispatchChatStreamEvent(msg) {
  const sessionId = msg.sessionId;
  const event = msg.event;
  if (!sessionId || !event) return false;

  // chat_op_started, inject_queued, inject_consumed land here too — store
  // applyEvent handles chat_op_started; injects bypass the store (no per-
  // session state to mutate) and are handled by the parent dispatcher.
  // bg_op_* / worker_* events are routed to dispatchBgOpEvent BEFORE this
  // function is called, so we don't see them here.
  if (event.type === 'inject_queued' || event.type === 'inject_consumed') return false;

  // Always update the store first — off-screen sessions need their state
  // captured even if we don't paint DOM for them. _opId/_seq tracking is
  // bumped here too via the store's lastSeenSeq mutation in applyEvent
  // (chat_op_started) and the parent-dispatcher bumpActivity for envelope
  // _opId/_seq.
  ChatStreamStore.applyEvent(sessionId, event);

  const viewing = !!(activeChat && activeChat.id === sessionId);

  // Store-driven swap of the live bubble. rerenderLiveMessage is
  // rAF-coalesced and bails for off-screen/post-done sessions. This is
  // now the ONLY path that paints stream text / tool cards / chips /
  // progress / approvals / stop notes into the live bubble — Phase 3
  // removed the surgical case bodies that used to run after this.
  if (viewing && typeof rerenderLiveMessage === 'function') {
    rerenderLiveMessage(sessionId);
  }

  // chat_op_started has no DOM side-effects. Done is finalized by the
  // per-turn subscriber in chat-send-ws.js / -http.js (DOM cleanup, persist).
  if (event.type === 'chat_op_started') return true;

  // Resolve the live bubble for the viewing session. _findStreamingBodyEl
  // returns the .msg-body of the most recent assistant message — same
  // element the per-turn renderer used to hold in its closure. Only the
  // legacy agent_spawn / agent_status HTTP-fallback branches still write
  // into this directly; bubble DOM for stream / tool_* / approval_* /
  // stopped / error is owned by the store + swap path now.
  const bodyEl = viewing ? _findStreamingBodyEl(sessionId) : null;

  switch (event.type) {
    case 'stream':
      // Side-effect-only: text painting is owned by the store + swap.
      if (viewing && typeof event.delta === 'string') feedTTS(event.delta);
      break;

    case 'visual':
      // voice_visual tool fired during a chat turn. Mirror the voice-WS
      // handler so the sphere morphs whether the user is in chat or voice mode.
      if (window.VoiceSphere && typeof VoiceSphere.handleDirective === 'function') {
        VoiceSphere.handleDirective({ kind: event.kind, value: event.value, durationMs: event.durationMs });
      }
      break;

    case 'secret_request':
      showSecretModal(event.name, event.service, event.reason);
      break;

    case 'secrets_request':
      showMultiSecretModal(event.secrets);
      break;

    case 'context_status':
      if (viewing) updateContextBar(event);
      break;

    case 'stopped':
      // The notice itself is rendered from store.stopNote by the swap path.
      // The console log is the only side effect we still own here.
      if (event.debug) console.info('[stopped]', event.firedBy || '?', event.debug);
      break;

    case 'agent_spawn':
      // Legacy SSE event — kept for HTTP-fallback parity. WS path doesn't
      // emit these; the agent-feeds sidebar uses bg_op_* instead.
      if (event.agent && typeof addAgentFeed === 'function') addAgentFeed(event.agent);
      if (viewing && bodyEl && event.agent && typeof renderAgentCard_inline === 'function') {
        const wrap = document.createElement('div');
        wrap.innerHTML = renderAgentCard_inline(event.agent);
        bodyEl.appendChild(wrap.firstChild);
      }
      break;

    case 'agent_status':
      if (event.agentId && typeof updateAgentFeed === 'function') updateAgentFeed(event.agentId, event);
      if (viewing && bodyEl && event.agent && typeof renderAgentCard_inline === 'function') {
        const wrap = document.createElement('div');
        wrap.innerHTML = renderAgentCard_inline(event.agent);
        bodyEl.appendChild(wrap.firstChild);
      }
      break;
  }

  return true;
}
