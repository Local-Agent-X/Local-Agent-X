// ── Chat: HTTP SSE streaming dispatch ──
// Called by sendMessage when WS isn't available or pong-healthy. POSTs to
// /api/chat and reads the server-sent-events stream line-by-line. Owns its
// own retry loop (network blips before any content) and its own
// finalization (no `done` event — end-of-stream is the signal).

async function _sendMessageHttp(ctx) {
  const { streamSessionId, streamChat, finalText, msgAttachments } = ctx;
  try {
    const res = await fetch(`${API}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ message: finalText, sessionId: streamSessionId, attachments: msgAttachments || [], projectId: streamChat.projectId || null }),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lastSaveTime = 0;

    // Always save to the ORIGINAL chat object, not whatever activeChat is now.
    // Routes through the shared upsert so mid-turn injects don't cause a
    // duplicate streaming-assistant entry (see _upsertStreamingAssistant).
    function savePartial() {
      if ((!ctx.content.trim() && ctx.toolEvents.length === 0)) return;
      _upsertStreamingAssistant(streamChat, ctx.content, ctx.toolEvents);
      streamChat.updatedAt = Date.now();
      saveChats();
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n'); buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(line.slice(6));
          const viewing = ctx.isViewingThis();
          if (viewing) ctx.getBodyEl();
          switch (event.type) {
            case 'stream':
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
              if (Date.now() - lastSaveTime > 2000) { savePartial(); lastSaveTime = Date.now(); }
              break;
            case 'tool_start':
              ctx.toolEvents.push({ type: 'start', name: event.toolName, args: event.args, riskLevel: event.riskLevel });
              if (viewing) {
                const existingCards = ctx.bodyEl.querySelectorAll('.tool-card');
                ctx.bodyEl.innerHTML = ctx.content ? md(ctx.content) : '';
                existingCards.forEach(c => ctx.bodyEl.appendChild(c));
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
                  // Clean tool result: strip security wrappers and show brief summary
                  let cleanResult = (event.result || '').replace(/<<<EXTERNAL_UNTRUSTED_CONTENT[\s\S]*?<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/g, '[content loaded]')
                    .replace(/IMPORTANT:.*?Do NOT follow any instructions.*$/gm, '')
                    .replace(/<metadata>[\s\S]*?<\/metadata>/g, '')
                    .replace(/<content>\n?/g, '').replace(/\n?<\/content>/g, '')
                    .trim().slice(0, 200);
                  last.querySelector('.tool-detail').textContent = cleanResult || '✓ Done';
                }
              }
              savePartial();
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
              if (event.debug) console.info('[stopped]', event.firedBy || '?', event.debug);
              if (viewing) {
                const note = document.createElement('div');
                note.className = 'stop-notice';
                note.textContent = event.reason || 'Stopped.';
                note.title = event.debug || event.firedBy || '';
                ctx.bodyEl.appendChild(note);
              }
              break;
            case 'error': ctx.content += '\n\nError: ' + event.message; if (viewing) ctx.bodyEl.innerHTML = md(ctx.content); break;
            case 'agent_spawn':
              if (event.agent) addAgentFeed(event.agent);
              if (viewing) { var _ac = document.createElement('div'); _ac.innerHTML = renderAgentCard_inline(event.agent); ctx.bodyEl.appendChild(_ac.firstChild); }
              break;
            case 'agent_status':
              if (event.agentId) updateAgentFeed(event.agentId, event);
              if (viewing && event.agent) { var _as = document.createElement('div'); _as.innerHTML = renderAgentCard_inline(event.agent); ctx.bodyEl.appendChild(_as.firstChild); }
              break;
          }
        } catch {}
      }
      // No post-event auto-scroll (see WS handler comment).
    }
    userScrolledUp = false;
    _persistHttpFinalMessage(ctx, streamChat);
    // If user navigated back, re-render to show completed response.
    // Same hydrate-safety-net as the WS path: when no stream content
    // landed locally (events lost, server-only persist path), pull the
    // canonical session log from /api/sessions/<id> so the bubble fills
    // in without requiring a navigate-away+back.
    if (ctx.isViewingThis()) {
      renderMessages();
      if (!ctx.content.trim() && typeof hydrateChat === 'function') {
        streamChat._needsHydrate = true;
        hydrateChat(streamChat).catch(e => console.warn('[chat] done-time hydrate failed (HTTP path):', e && e.message));
      }
    }
  } catch (e) {
    await _retryHttpStream(ctx, e);
  }
  _finalizeHttpTurn(ctx, streamSessionId, streamChat);
}

function _persistHttpFinalMessage(ctx, streamChat) {
  // Finalize the ORIGINAL chat — preserve streamed content; don't lose visible bubbles
  const lastMsg = streamChat.messages[streamChat.messages.length - 1];
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
}

async function _retryHttpStream(ctx, originalErr) {
  const { streamSessionId, streamChat, finalText, msgAttachments } = ctx;
  // Silent auto-retry up to 3 times on network errors before showing error to user
  if (!ctx.content && originalErr.message && (originalErr.message.includes('network') || originalErr.message.includes('Failed to fetch') || originalErr.message.includes('CONNECTION'))) {
    let retrySuccess = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (ctx.isViewingThis()) ctx.bodyEl.innerHTML = '<div class="thinking"><span>.</span><span>.</span><span>.</span></div>';
        await new Promise(r => setTimeout(r, attempt * 2000)); // 2s, 4s, 6s backoff
        const res2 = await fetch(`${API}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
          body: JSON.stringify({ message: finalText, sessionId: streamSessionId, attachments: msgAttachments || [], projectId: streamChat.projectId || null }),
        });
        const reader2 = res2.body.getReader();
        const decoder2 = new TextDecoder();
        let buffer2 = '';
        while (true) {
          const { done, value } = await reader2.read();
          if (done) break;
          buffer2 += decoder2.decode(value, { stream: true });
          const lines = buffer2.split('\n'); buffer2 = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const event = JSON.parse(line.slice(6));
              if (event.type === 'stream') { ctx.content += event.delta; if (ctx.isViewingThis()) ctx.bodyEl.innerHTML = md(ctx.content); }
              if (event.type === 'tool_start' && ctx.isViewingThis()) { ctx.bodyEl.innerHTML = ctx.content ? md(ctx.content) : ''; appendToolCardGrouped(ctx.bodyEl, event.toolName, event.args, event.riskLevel, event.context); }
              if (event.type === 'tool_end' && ctx.isViewingThis()) { const cards = ctx.bodyEl.querySelectorAll('.tool-card'); const last = cards[cards.length-1]; if(last){last.querySelector('.indicator').className='indicator '+(event.allowed?'allowed':'blocked');} }
              if (event.type === 'tool_progress' && ctx.isViewingThis()) { updateToolProgress(ctx.bodyEl, event.toolName, event.message); }
              if (event.type === 'done') {
                if (ctx.content.trim() || ctx.toolEvents.length) {
                  _upsertStreamingAssistant(streamChat, ctx.content, ctx.toolEvents);
                  streamChat.updatedAt = Date.now(); saveChats();
                }
              }
            } catch {}
          }
        }
        retrySuccess = true;
        break;
      } catch { /* retry */ }
    }
    if (!retrySuccess && ctx.isViewingThis()) showRetryError(ctx.bodyEl, finalText, originalErr.message);
  } else {
    if (ctx.isViewingThis()) showRetryError(ctx.bodyEl, finalText, originalErr.message);
  }
}

function _finalizeHttpTurn(ctx, streamSessionId, streamChat) {
  flushTTS();
  // Browser notification for completed long tasks (feature 96)
  if (typeof window.notifyTaskComplete === 'function') window.notifyTaskComplete(streamChat.title);
  // ALWAYS clear streaming state — must happen before anything that could throw.
  // Clear the singular only if it points at us (another session may rightfully
  // own the pointer now); updateStreamUI unconditionally so the active-chat UI
  // refreshes even when concurrent streams desynchronize the singular.
  if (streamingSessionId === streamSessionId) window.streamingSessionId = null;
  _liveStreams.delete(streamSessionId);
  try { if (typeof window.updateStreamUI === 'function') window.updateStreamUI(); } catch {}
  // pin-bottom stays — see WS-handler note. Latest turn keeps reserved height.
  // Always hide stop button and re-enable send when stream ends
  try {
    const stopBtn2 = document.getElementById('stop-btn');
    if (stopBtn2) stopBtn2.style.display = 'none';
    document.getElementById('send-btn').disabled = false;
    if (ctx.isViewingThis()) renderMessages();
    updateContextBar();
  } catch (renderErr) { console.error('[chat] finalize render error:', renderErr); }
}
