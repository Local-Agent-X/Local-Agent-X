// ── Chat: WebSocket streaming dispatch ──
// Called by sendMessage when chatWs is open and pong-healthy. Fires the
// chat message, attaches a message-event listener that handles the per-
// session stream until the server sends `done`. The handler owns its own
// finalization — sendMessage does NOT await this; it returns immediately.

function _sendMessageWs(ctx) {
  const { streamSessionId, streamChat, finalText, msgAttachments } = ctx;
  chatWs.send(JSON.stringify({
    type: 'chat',
    sessionId: streamSessionId,
    message: finalText,
    attachments: msgAttachments || [],
    projectId: streamChat.projectId || null,
  }));

  const wsHandler = function(e) {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type !== 'event' || msg.sessionId !== streamSessionId) return;
      const event = msg.event;
      const viewing = ctx.isViewingThis();
      // [stream-debug] TEMP — diagnosing bug C (events arrive but DOM
      // doesn't update until reload, or massive lag). Logs every event
      // arrival with timing + viewing/bodyEl state so we can tell whether
      // events are arriving slowly (server/upstream cadence) or being
      // dropped at the renderer. Filter the console with `[stream-debug]`
      // to see only these lines. Remove after diagnosis.
      if (event.type === 'stream' || event.type === 'tool_start' || event.type === 'tool_end' || event.type === 'done') {
        const bodyConnected = ctx.bodyEl ? document.contains(ctx.bodyEl) : 'no-bodyEl';
        const deltaLen = event.type === 'stream' ? (event.delta || '').length : '';
        console.log(`[stream-debug] t=${Date.now()} evt=${event.type} viewing=${viewing} bodyConnected=${bodyConnected} deltaLen=${deltaLen} sess=${streamSessionId.slice(-8)}`);
      }
      // After a chat-switch-and-back the originally-captured bodyEl is
      // detached and renderMessages has rendered a fresh one — refresh.
      if (viewing) ctx.getBodyEl();
      switch (event.type) {
        case 'stream':
          // stream_redact: adapter post-processed (extracted a tool call
          // from text the model emitted as JSON). Replace bubble content
          // with the cleaned text instead of appending — server already
          // computed what the bubble SHOULD have said.
          if (event.replace === true) {
            ctx.content = event.text || '';
            if (viewing) renderStreamContent(ctx.bodyEl, ctx.content);
            break;
          }
          ctx.content += event.delta;
          if (viewing) {
            renderStreamContent(ctx.bodyEl, ctx.content);
            feedTTS(event.delta);
          }
          break;
        case 'tool_start':
          ctx.toolEvents.push({ type: 'start', name: event.toolName, args: event.args, riskLevel: event.riskLevel });
          if (viewing) {
            // Preserve activity-groups (which contain tool cards) across
            // the markdown re-render — without this, every text delta wipes
            // the group container and orphaned tool cards float in body.
            const existingGroups = ctx.bodyEl.querySelectorAll('.activity-group');
            const orphanCards = ctx.bodyEl.querySelectorAll(':scope > .tool-card');
            const mediaPreviews = ctx.bodyEl.querySelectorAll(':scope > .tool-media-preview');
            ctx.bodyEl.innerHTML = ctx.content ? md(ctx.content) : '';
            mediaPreviews.forEach(m => ctx.bodyEl.appendChild(m));
            existingGroups.forEach(g => ctx.bodyEl.appendChild(g));
            orphanCards.forEach(c => ctx.bodyEl.appendChild(c));
            appendToolCardGrouped(ctx.bodyEl, event.toolName, event.args, event.riskLevel, event.context);
          }
          break;
        case 'tool_end': {
          ctx.toolEvents.push({ type: 'end', name: event.toolName, allowed: event.allowed, result: (event.result||'').slice(0, 500) });
          if (viewing) {
            const cards = ctx.bodyEl.querySelectorAll('.tool-card');
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
        }
        case 'tool_chip':
          if (viewing && event.chip) appendToolChip(ctx.bodyEl, event.chip);
          break;
        case 'tool_progress':
          if (viewing) updateToolProgress(ctx.bodyEl, event.toolName, event.message);
          break;
        case 'visual':
          // voice_visual tool fired during a chat turn. Mirror the
          // voice-WS handler so the sphere morphs whether the user is in
          // chat or voice mode.
          if (window.VoiceSphere && typeof VoiceSphere.handleDirective === 'function') {
            VoiceSphere.handleDirective({ kind: event.kind, value: event.value, durationMs: event.durationMs });
          }
          break;
        case 'secret_request': showSecretModal(event.name, event.service, event.reason); break;
        case 'secrets_request': showMultiSecretModal(event.secrets); break;
        case 'approval_requested':
          if (viewing) ctx.bodyEl.appendChild(makeApprovalCard(event.approvalId, event.toolName, event.context, event.argsPreview));
          break;
        case 'approval_timeout': {
          const card = document.querySelector('.approval-card[data-id="' + event.approvalId + '"]');
          if (card) { card.classList.add('timeout'); card.querySelector('.approval-status').textContent = 'Timed out — denied.'; card.querySelectorAll('button').forEach(b => b.disabled = true); }
          break;
        }
        case 'context_status': if (viewing) updateContextBar(event); break;
        case 'stopped':
          // Render a small italic stop-notice below the message body.
          // NOT appended to `ctx.content` — keeps the message clean and
          // prevents the technical reason from being persisted into chat
          // history. The technical `debug` text is logged to console for
          // diagnostics but never shown in the UI.
          if (event.debug) console.info('[stopped]', event.firedBy || '?', event.debug);
          if (viewing) {
            const note = document.createElement('div');
            note.className = 'stop-notice';
            note.textContent = event.reason || 'Stopped.';
            note.title = event.debug || event.firedBy || '';
            ctx.bodyEl.appendChild(note);
          }
          break;
        case 'error':
          if (saveInterval) clearInterval(saveInterval);
          ctx.content += '\n\nError: ' + event.message;
          if (viewing) ctx.bodyEl.innerHTML = md(ctx.content);
          break;
        case 'done': {
          chatWs.removeEventListener('message', wsHandler);
          if (saveInterval) clearInterval(saveInterval);
          _finalizeWsTurn(ctx, streamSessionId, streamChat);
          break;
        }
      }
      // No post-event auto-scroll. The user message was pinned to the top of
      // the viewport at send time, the assistant bubble reserves room below,
      // and the reader stays in control of scroll throughout (and after).
    } catch {}
  };
  chatWs.addEventListener('message', wsHandler);

  // Save partial periodically. Use the shared upsert helper so a mid-turn
  // inject (which pushes a user row AFTER the streaming assistant) doesn't
  // trick this branch into appending a SECOND streaming-assistant entry —
  // the bug that made the user's bubble appear sandwiched between two
  // copies of the assistant's growing reply.
  const saveInterval = setInterval(function() {
    if (!ctx.content.trim() && ctx.toolEvents.length === 0) return;
    _upsertStreamingAssistant(streamChat, ctx.content, ctx.toolEvents);
    streamChat.updatedAt = Date.now(); saveChats();
  }, 3000);
}

function _finalizeWsTurn(ctx, streamSessionId, streamChat) {
  if (streamingSessionId === streamSessionId) window.streamingSessionId = null;
  _liveStreams.delete(streamSessionId);
  // Keep `pin-bottom` — it's the latest turn and should retain the
  // viewport-height reserved space below until the user sends again.
  try {
    const stopBtn2 = document.getElementById('stop-btn');
    if (stopBtn2) stopBtn2.style.display = 'none';
    document.getElementById('send-btn').disabled = false;
  } catch {}
  userScrolledUp = false;
  const lastMsg = streamChat.messages[streamChat.messages.length - 1];
  // Persist final message — preserve any content streamed/saved during the turn.
  // Don't overwrite existing content with empty string (race with savePartial interval).
  if (lastMsg && lastMsg._streaming) {
    if (ctx.content && ctx.content.length >= (lastMsg.content || '').length) {
      lastMsg.content = ctx.content;
    }
    lastMsg.timestamp = Date.now();
    delete lastMsg._streaming;
    streamChat.updatedAt = Date.now(); saveChats(); renderSidebar();
  } else if (ctx.content.trim()) {
    streamChat.messages.push({ role: 'assistant', content: ctx.content, timestamp: Date.now() });
    streamChat.updatedAt = Date.now(); saveChats(); renderSidebar();
  }
  // Final DOM sync — flush any pending rAF render so the last chunk of
  // content is visible. Re-resolve the bubble FRESH: closure-captured
  // ctx.bodyEl can be detached after a DOM rebuild (chat-switch+back, or
  // a layout re-render mid-stream). The per-event refresh keeps ctx.bodyEl
  // current during the stream, but if the user reads a different chat and
  // comes back right before 'done', ctx.bodyEl may point at a now-orphaned
  // node; both paint branches below would then silently no-op and the
  // user sees a blank bubble until they navigate away+back (which
  // triggers renderMessages from session storage — the message was always
  // persisted above, just never painted).
  // Live failure 2026-05-18: assistant replies completed cleanly (Stop
  // button hidden) but bubble stayed empty until leave+return.
  if (ctx.isViewingThis()) {
    const liveBubble = ctx.getBodyEl();
    const pending = liveBubble ? _streamRenderers.get(liveBubble) : null;
    if (pending && pending.raf) { cancelAnimationFrame(pending.raf); pending.raf = 0; }
    // Prefer pending.latest (post-stream dedup/replace state) when present,
    // else the accumulated ctx.content buffer.
    const finalText = (pending && pending.latest) || ctx.content;
    if (liveBubble && finalText) {
      const existingGroups = liveBubble.querySelectorAll('.activity-group');
      const orphanCards = liveBubble.querySelectorAll(':scope > .tool-card, :scope > .approval-card');
      const mediaPreviews = liveBubble.querySelectorAll(':scope > .tool-media-preview');
      const currentMd = md(finalText);
      if (liveBubble.innerHTML !== currentMd || existingGroups.length > 0 || orphanCards.length > 0 || mediaPreviews.length > 0) {
        liveBubble.innerHTML = currentMd;
        mediaPreviews.forEach(m => liveBubble.appendChild(m));
        existingGroups.forEach(g => liveBubble.appendChild(g));
        orphanCards.forEach(c => liveBubble.appendChild(c));
      }
    } else {
      // Fallback path: no live content to paint. Two sub-cases:
      //   (a) `activeChat.messages` already has the final text
      //       (saveInterval flushed it, or the persist branch above
      //       wrote it). renderMessages() is enough.
      //   (b) `activeChat.messages` is ALSO empty — stream events
      //       never reached the local wsHandler (WS reconnect race,
      //       half-open connection, server-only-persist provider
      //       path). The canonical text lives in the server-side
      //       session log; pull it via hydrateChat. Without this,
      //       bubble stays blank until user manually navigates
      //       away+back.
      // We can't cheaply tell (a) vs (b), so hydrate unconditionally —
      // it's idempotent and hydrateChat() already calls renderMessages
      // on success. renderMessages first for immediate paint, hydrate
      // for safety-net catch-up.
      if (typeof renderMessages === 'function') renderMessages();
      if (typeof hydrateChat === 'function') {
        streamChat._needsHydrate = true;
        hydrateChat(streamChat).catch(e => console.warn('[chat] done-time hydrate failed:', e && e.message));
      }
    }
  }
  updateContextBar();
  flushTTS();
  if (typeof window.notifyTaskComplete === 'function') window.notifyTaskComplete(streamChat.title);
}
