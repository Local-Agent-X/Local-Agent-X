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
// Two responsibilities per event:
//   1. Push it through ChatStreamStore.applyEvent so per-session state
//      (content / toolEvents / opId / status) stays in sync.
//   2. If the user is viewing this session, render the side effects
//      (paint tool card, show modal, append approval card, etc.).
//
// External deps (auto-window from sibling scripts):
//   activeChat                                          (app-state.js)
//   _findStreamingBodyEl                                (chat-ws.js)
//   renderStreamContent, md                             (chat-render.js, shared.js)
//   appendToolCardGrouped, appendToolChip, updateToolProgress
//                                                       (chat-tool-cards.js)
//   attachMediaPreview, makeApprovalCard                (chat-tool-cards.js)
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

  // chat_op_started has no DOM side-effects. Done is finalized by the
  // per-turn subscriber in chat-send-ws.js / -http.js (DOM cleanup, persist).
  if (event.type === 'chat_op_started') return true;

  // Resolve the live bubble for the viewing session. _findStreamingBodyEl
  // returns the .msg-body of the most recent assistant message — same
  // element the per-turn renderer used to hold in its closure.
  const bodyEl = viewing ? _findStreamingBodyEl(sessionId) : null;
  const store = ChatStreamStore.get(sessionId);

  switch (event.type) {
    case 'stream':
      if (viewing && bodyEl) {
        renderStreamContent(bodyEl, store.content);
        if (typeof event.delta === 'string') feedTTS(event.delta);
      }
      break;

    case 'tool_start':
      if (viewing && bodyEl) {
        // Preserve activity-groups (tool cards) across the markdown re-render
        // — without this, every text delta wipes the group container and
        // orphaned tool cards float in body.
        const existingGroups = bodyEl.querySelectorAll('.activity-group');
        const orphanCards = bodyEl.querySelectorAll(':scope > .tool-card');
        const mediaPreviews = bodyEl.querySelectorAll(':scope > .tool-media-preview');
        bodyEl.innerHTML = store.content ? md(store.content) : '';
        mediaPreviews.forEach(m => bodyEl.appendChild(m));
        existingGroups.forEach(g => bodyEl.appendChild(g));
        orphanCards.forEach(c => bodyEl.appendChild(c));
        appendToolCardGrouped(bodyEl, event.toolName, event.args, event.riskLevel, event.context);
      }
      break;

    case 'tool_end':
      if (viewing && bodyEl) {
        const cards = bodyEl.querySelectorAll('.tool-card');
        const last = cards[cards.length - 1];
        if (last) {
          last.querySelector('.indicator').className = 'indicator ' + (event.allowed ? 'allowed' : 'blocked');
          let cleanResult = (event.result || '').replace(/<<<EXTERNAL_UNTRUSTED_CONTENT[\s\S]*?<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/g, '[content loaded]')
            .replace(/IMPORTANT:.*?Do NOT follow any instructions.*$/gm, '')
            .replace(/<metadata>[\s\S]*?<\/metadata>/g, '')
            .replace(/<content>\n?/g, '').replace(/\n?<\/content>/g, '')
            .trim().slice(0, 200);
          last.querySelector('.tool-detail').textContent = cleanResult || '✓ Done';
          attachMediaPreview(last, event.toolName, event.result || '');
        }
      }
      break;

    case 'tool_chip':
      if (viewing && bodyEl && event.chip) appendToolChip(bodyEl, event.chip);
      break;

    case 'tool_progress':
      if (viewing && bodyEl) updateToolProgress(bodyEl, event.toolName, event.message);
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

    case 'approval_requested':
      if (viewing && bodyEl) bodyEl.appendChild(makeApprovalCard(event.approvalId, event.toolName, event.context, event.argsPreview));
      break;

    case 'approval_timeout': {
      const card = document.querySelector('.approval-card[data-id="' + event.approvalId + '"]');
      if (card) {
        card.classList.add('timeout');
        card.querySelector('.approval-status').textContent = 'Timed out — denied.';
        card.querySelectorAll('button').forEach(b => b.disabled = true);
      }
      break;
    }

    case 'context_status':
      if (viewing) updateContextBar(event);
      break;

    case 'stopped':
      // Small italic stop-notice below the message body. Not appended to
      // store content — keeps the persisted message clean and prevents the
      // technical reason from being saved into chat history.
      if (event.debug) console.info('[stopped]', event.firedBy || '?', event.debug);
      if (viewing && bodyEl) {
        const note = document.createElement('div');
        note.className = 'stop-notice';
        note.textContent = event.reason || 'Stopped.';
        note.title = event.debug || event.firedBy || '';
        bodyEl.appendChild(note);
      }
      break;

    case 'error':
      // applyEvent already appended the deduped "Error: ..." text into
      // store.content — just repaint.
      if (viewing && bodyEl) bodyEl.innerHTML = md(store.content);
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
