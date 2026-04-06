// ── Chat Panel ──
let streamingSessionId = null; // Track WHICH session is streaming, not global boolean
let pendingUploads = [];
let userScrolledUp = false;

// ── WebSocket Chat Connection ──
let chatWs = null;
let activeChatsSet = new Set();

function connectChatWs() {
  if (chatWs && chatWs.readyState === WebSocket.OPEN) return;
  const wsUrl = `ws://${location.host}/ws/chat`;
  chatWs = new WebSocket(wsUrl, ['sax-auth', AUTH_TOKEN]);

  chatWs.onopen = () => {
    console.log('[ws] Chat WebSocket connected');
    // Subscribe to active chat if we have one
    if (activeChat) chatWs.send(JSON.stringify({ type: 'subscribe', sessionId: activeChat.id }));
  };

  chatWs.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    if (msg.type === 'active_chats') {
      activeChatsSet = new Set(msg.sessionIds || []);
      renderSidebar(); // Update indicators
    }

    if (msg.type === 'event' && msg.sessionId && msg.event) {
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

    // ── Desktop notifications for important events ──
    if (msg.type === 'issue:created' && msg.issue?.needsApproval) {
      if (window.desktop) window.desktop.showNotification('Approval Needed', msg.issue.title);
      else if (Notification.permission === 'granted') new Notification('Approval Needed', { body: msg.issue.title });
    }
    if (msg.type === 'inbox:approved') {
      if (window.desktop) window.desktop.showNotification('Approved', msg.issue?.title || 'Request approved');
    }
    if (msg.type === 'agent-complete' && msg.agentId) {
      if (window.desktop) window.desktop.showNotification('Agent Finished', msg.result?.slice(0, 100) || 'Task complete');
    }

    // ── Agent feed events (inline — no monkey-patching needed) ──
    if (msg.type === 'agent-spawn' && msg.agentId) {
      if (typeof addAgentFeed === 'function') addAgentFeed({ id: msg.agentId, name: msg.name, role: msg.role, status: msg.status || 'working', currentTask: msg.task });
    } else if (msg.type === 'agent-update' && msg.agentId) {
      if (typeof updateAgentFeed === 'function') updateAgentFeed(msg.agentId, msg);
    } else if (msg.type === 'agent-output' && msg.agentId) {
      if (typeof updateAgentFeed === 'function') updateAgentFeed(msg.agentId, { output: msg.output });
    } else if (msg.type === 'agent-complete' && msg.agentId) {
      if (typeof updateAgentFeed === 'function') {
        updateAgentFeed(msg.agentId, { status: msg.success ? 'done' : 'error', output: msg.result ? '[Result] ' + msg.result.slice(0, 500) : '' });
        // Build a concise one-liner for chat — full details on Agents page
        var statusIcon = msg.success ? '\u2705' : '\u274C';
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
  };

  chatWs.onclose = () => {
    console.log('[ws] Chat WebSocket closed, reconnecting in 3s...');
    setTimeout(connectChatWs, 3000);
  };

  chatWs.onerror = () => {}; // onclose handles reconnect
}

// Connect on load
setTimeout(connectChatWs, 1000);

function stopChat() {
  if (!activeChat) return;
  // Send stop via WS
  if (chatWs && chatWs.readyState === WebSocket.OPEN) {
    chatWs.send(JSON.stringify({ type: 'stop', sessionId: activeChat.id }));
  }
  // Also try HTTP fallback
  fetch(`${API}/api/chats/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
    body: JSON.stringify({ sessionId: activeChat.id }),
  }).catch(() => {});
  // Force stop local rendering immediately
  streamingSessionId = null;
  // Close and reconnect WS to kill any in-flight stream
  if (chatWs) {
    chatWs.close();
    setTimeout(connectChatWs, 500);
  }
  // Append "stopped" indicator to last message
  const msgs = document.querySelectorAll('.msg.assistant');
  const last = msgs[msgs.length - 1];
  if (last) {
    const body = last.querySelector('.msg-body');
    if (body && !body.textContent.includes('[stopped]')) {
      body.innerHTML += '<div style="color:var(--muted);font-size:.72rem;margin-top:8px;font-style:italic">[stopped by user]</div>';
    }
  }
  const stopBtn = document.getElementById('stop-btn');
  const sendBtn = document.getElementById('send-btn');
  if (stopBtn) stopBtn.style.display = 'none';
  if (sendBtn) sendBtn.disabled = false;
  // Stop TTS if speaking
  stopSpeaking();
}

function isChatActive(sessionId) {
  return activeChatsSet.has(sessionId);
}

// Detect when user scrolls away from bottom — pause auto-scroll
(function initScrollPause() {
  const el = document.getElementById('messages');
  if (!el) { document.addEventListener('DOMContentLoaded', initScrollPause); return; }
  el.addEventListener('wheel', () => {
    if (!streamingSessionId) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    userScrolledUp = !atBottom;
  });
  el.addEventListener('scroll', () => {
    if (!streamingSessionId) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (atBottom) userScrolledUp = false;
  });
})();

function autoScroll() {
  if (userScrolledUp) return;
  const el = document.getElementById('messages');
  if (el) el.scrollTop = el.scrollHeight;
}

// Voice state
let voiceEnabled = false, isListening = false, isSpeaking = false;
let mediaRecorder = null, audioChunks = [], audioContext = null;
let ttsQueue = [], ttsSentenceBuffer = '', currentAudioSource = null;

function renderMessages() {
  const el = document.getElementById('messages');
  if (!el) return;
  if (!activeChat || activeChat.messages.length === 0) {
    el.innerHTML = `<div id="empty"><img src="/hero.jpg" alt="Open Agent X" class="hero-img" /><h2>OPEN AGENT X</h2><p>${activeChat ? 'Start your conversation below.' : 'Select a chat or start a new one.'}</p></div>`;
    return;
  }
  el.innerHTML = '';
  for (let i = 0; i < activeChat.messages.length; i++) {
    const msg = activeChat.messages[i];
    if (msg.role === 'user') {
      const displayText = msg.attachments ? msg.content.replace(/^Attached files:\n[\s\S]*?\n\n/, '') : msg.content;
      addMessageEl('user', displayText, msg.attachments, msg.timestamp);
    } else if (msg.role === 'assistant' && (msg.content || msg._tools)) {
      // Clean up stale streaming state on render
      if (msg._streaming) {
        delete msg._streaming;
        // If tools have no matching end events, mark them as interrupted
        if (msg._tools) {
          for (const te of msg._tools) {
            if (te.type === 'start' && !msg._tools.find(t => t.type === 'end' && t.name === te.name)) {
              msg._tools.push({ type: 'end', name: te.name, allowed: true, result: '(interrupted)' });
            }
          }
        }
      }
      addMessageEl('assistant', msg.content || '', null, msg.timestamp);
      // Render saved tool cards
      if (msg._tools && msg._tools.length > 0) {
        const lastBubble = el.querySelector('.msg-row:last-child .bubble');
        if (lastBubble) {
          try {
            for (const te of msg._tools) {
              if (te.type === 'start') {
                const card = makeToolCard(te.name, te.args || '', te.riskLevel);
                const endEvt = msg._tools.find(t => t.type === 'end' && t.name === te.name);
                if (endEvt) {
                  card.querySelector('.indicator').className = 'indicator ' + (endEvt.allowed ? 'allowed' : 'blocked');
                  card.querySelector('.tool-detail').textContent = (endEvt.result || '').slice(0, 200) || '✓ Done';
                }
                lastBubble.appendChild(card);
              }
            }
          } catch (toolRenderErr) { console.error('[chat] tool card render error:', toolRenderErr); }
        }
      }
    }
  }
  el.scrollTop = el.scrollHeight;
}

async function sendMessage() {
  if (streamingSessionId) return;
  userScrolledUp = false; // Reset scroll lock when user sends
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text && pendingUploads.length === 0) return;
  // Capture attachments before clearing
  const msgAttachments = pendingUploads.length ? pendingUploads.map(f => ({
    name: f.name, size: f.size, type: f.type, isImage: f.isImage,
    url: f.url || null, dataUrl: f.dataUrl || null
  })) : null;
  const hasImages = msgAttachments && msgAttachments.some(a => a.isImage);
  const nonImageFiles = msgAttachments ? msgAttachments.filter(a => !a.isImage) : [];
  const uploadPrefix = nonImageFiles.length
    ? `Attached files:\n${nonImageFiles.map(f => `- ${f.name} (${f.size} bytes)`).join('\n')}\n\n`
    : (hasImages && !text ? '' : '');
  const finalText = uploadPrefix + text;
  const displayText = text || '';
  input.value = ''; input.style.height = 'auto';
  pendingUploads = []; renderUploadPreviews();
  if (!activeChat) newChat();
  if (activeChat.messages.length === 0) {
    const titleSrc = text || (msgAttachments ? msgAttachments[0].name : 'New Chat');
    activeChat.title = titleSrc.slice(0, 50) + (titleSrc.length > 50 ? '...' : '');
    saveChats(); renderSidebar();
  }
  const empty = document.getElementById('empty'); if (empty) empty.remove();
  const msgTime = Date.now();
  addMessageEl('user', displayText, msgAttachments, msgTime);
  activeChat.messages.push({ role: 'user', content: finalText, attachments: msgAttachments, timestamp: msgTime });
  const msgEl = addMessageEl('assistant', '');
  const bodyEl = msgEl.querySelector('.msg-body');
  bodyEl.innerHTML = '<div class="thinking"><span>.</span><span>.</span><span>.</span></div>';
  const streamSessionId = activeChat.id; // Capture which session THIS stream belongs to
  const streamChat = activeChat; // Reference to the chat object (survives navigation)
  streamingSessionId = streamSessionId; stopSpeaking(); ttsSentenceBuffer = '';
  // Track task start for browser notifications (feature 96)
  if (window.taskStartTime !== undefined) window.taskStartTime = Date.now();
  const stopBtn = document.getElementById('stop-btn');
  if (stopBtn) stopBtn.style.display = 'flex';
  document.getElementById('send-btn').disabled = true;

  // Helper: is the user still viewing this chat?
  function isViewingThis() { return activeChat && activeChat.id === streamSessionId; }

  // Feature 5: Mood detection — update indicator
  detectMood(text);

  let content = '';
  let toolEvents = [];

  // Try WebSocket first (bidirectional, no SSE buffering issues)
  if (chatWs && chatWs.readyState === WebSocket.OPEN) {
    chatWs.send(JSON.stringify({ type: 'chat', sessionId: streamSessionId, message: finalText, attachments: msgAttachments || [] }));
    // Events arrive via the WS onmessage handler (lines above) which calls broadcastToSession
    // Set up a WS event listener for this session's stream events
    const wsHandler = function(e) {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type !== 'event' || msg.sessionId !== streamSessionId) return;
        const event = msg.event;
        const viewing = isViewingThis();
        switch (event.type) {
          case 'stream':
            content += event.delta;
            if (viewing) {
              const existingCards = bodyEl.querySelectorAll('.tool-card');
              bodyEl.innerHTML = md(content);
              existingCards.forEach(c => bodyEl.appendChild(c));
              feedTTS(event.delta);
            }
            break;
          case 'tool_start':
            toolEvents.push({ type: 'start', name: event.toolName, args: event.args, riskLevel: event.riskLevel });
            if (viewing) {
              const existingCards = bodyEl.querySelectorAll('.tool-card');
              bodyEl.innerHTML = content ? md(content) : '';
              existingCards.forEach(c => bodyEl.appendChild(c));
              bodyEl.appendChild(makeToolCard(event.toolName, event.args, event.riskLevel, event.context));
            }
            break;
          case 'tool_end': {
            toolEvents.push({ type: 'end', name: event.toolName, allowed: event.allowed, result: (event.result||'').slice(0, 500) });
            if (viewing) {
              const cards = bodyEl.querySelectorAll('.tool-card');
              const last = cards[cards.length - 1];
              if (last) {
                last.querySelector('.indicator').className = 'indicator ' + (event.allowed ? 'allowed' : 'blocked');
                let cleanResult = (event.result || '').replace(/<<<EXTERNAL_UNTRUSTED_CONTENT[\s\S]*?<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/g, '[content loaded]')
                  .replace(/IMPORTANT:.*?Do NOT follow any instructions.*$/gm, '')
                  .replace(/<metadata>[\s\S]*?<\/metadata>/g, '')
                  .replace(/<content>\n?/g, '').replace(/\n?<\/content>/g, '')
                  .trim().slice(0, 200);
                last.querySelector('.tool-detail').textContent = cleanResult || '\u2713 Done';
              }
            }
            break;
          }
          case 'context_status': if (viewing) updateContextBar(event); break;
          case 'error': content += '\n\nError: ' + event.message; if (viewing) bodyEl.innerHTML = md(content); break;
          case 'done': {
            chatWs.removeEventListener('message', wsHandler);
            // Finalize
            if (streamingSessionId === streamSessionId) streamingSessionId = null;
            try {
              const stopBtn2 = document.getElementById('stop-btn');
              if (stopBtn2) stopBtn2.style.display = 'none';
              document.getElementById('send-btn').disabled = false;
            } catch {}
            userScrolledUp = false;
            const lastMsg = streamChat.messages[streamChat.messages.length - 1];
            if (content.trim()) {
              if (lastMsg && lastMsg._streaming) { lastMsg.content = content; lastMsg.timestamp = Date.now(); delete lastMsg._streaming; }
              else { streamChat.messages.push({ role: 'assistant', content, timestamp: Date.now() }); }
              streamChat.updatedAt = Date.now(); saveChats(); renderSidebar();
            }
            if (isViewingThis()) renderMessages();
            updateContextBar();
            flushTTS();
            if (typeof window.notifyTaskComplete === 'function') window.notifyTaskComplete(streamChat.title);
            break;
          }
        }
        if (isViewingThis()) autoScroll();
      } catch {}
    };
    chatWs.addEventListener('message', wsHandler);
    // Save partial periodically
    const saveInterval = setInterval(function() {
      if (!content.trim() && toolEvents.length === 0) return;
      const lastMsg = streamChat.messages[streamChat.messages.length - 1];
      if (lastMsg && lastMsg.role === 'assistant' && lastMsg._streaming) { lastMsg.content = content; lastMsg._tools = toolEvents.length > 0 ? [...toolEvents] : undefined; }
      else { streamChat.messages.push({ role: 'assistant', content, _streaming: true, _tools: toolEvents.length > 0 ? [...toolEvents] : undefined }); }
      streamChat.updatedAt = Date.now(); saveChats();
    }, 3000);
    // Clean up save interval when done
    const origHandler = wsHandler;
    // We rely on the 'done' event above to clean up
    return; // Don't fall through to HTTP
  }

  // Fallback: HTTP SSE (if WebSocket not connected)
  try {
    const res = await fetch(`${API}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ message: finalText, sessionId: streamSessionId, attachments: msgAttachments || [] }),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lastSaveTime = 0;

    // Always save to the ORIGINAL chat object, not whatever activeChat is now
    function savePartial() {
      if ((!content.trim() && toolEvents.length === 0)) return;
      const lastMsg = streamChat.messages[streamChat.messages.length - 1];
      if (lastMsg && lastMsg.role === 'assistant' && lastMsg._streaming) {
        lastMsg.content = content;
        lastMsg._tools = toolEvents.length > 0 ? [...toolEvents] : undefined;
      } else {
        streamChat.messages.push({ role: 'assistant', content, _streaming: true, _tools: toolEvents.length > 0 ? [...toolEvents] : undefined });
      }
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
          const viewing = isViewingThis();
          switch (event.type) {
            case 'stream':
              content += event.delta;
              if (viewing) {
                // Preserve tool cards while updating text content
                const existingCards = bodyEl.querySelectorAll('.tool-card');
                bodyEl.innerHTML = md(content);
                existingCards.forEach(c => bodyEl.appendChild(c));
                feedTTS(event.delta);
              }
              if (Date.now() - lastSaveTime > 2000) { savePartial(); lastSaveTime = Date.now(); }
              break;
            case 'tool_start':
              toolEvents.push({ type: 'start', name: event.toolName, args: event.args, riskLevel: event.riskLevel });
              if (viewing) {
                const existingCards = bodyEl.querySelectorAll('.tool-card');
                bodyEl.innerHTML = content ? md(content) : '';
                existingCards.forEach(c => bodyEl.appendChild(c));
                bodyEl.appendChild(makeToolCard(event.toolName, event.args, event.riskLevel, event.context));
              }
              break;
            case 'tool_end': {
              toolEvents.push({ type: 'end', name: event.toolName, allowed: event.allowed, result: (event.result||'').slice(0, 500) });
              if (viewing) {
                const cards = bodyEl.querySelectorAll('.tool-card');
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
            case 'secret_request': if (viewing) showSecretModal(event.name, event.service, event.reason); break;
            case 'context_status': if (viewing) updateContextBar(event); break;
            case 'error': content += '\n\nError: ' + event.message; if (viewing) bodyEl.innerHTML = md(content); break;
            case 'agent_spawn':
              if (event.agent) addAgentFeed(event.agent);
              if (viewing) { var _ac = document.createElement('div'); _ac.innerHTML = renderAgentCard_inline(event.agent); bodyEl.appendChild(_ac.firstChild); }
              break;
            case 'agent_status':
              if (event.agentId) updateAgentFeed(event.agentId, event);
              if (viewing && event.agent) { var _as = document.createElement('div'); _as.innerHTML = renderAgentCard_inline(event.agent); bodyEl.appendChild(_as.firstChild); }
              break;
          }
        } catch {}
      }
      if (isViewingThis()) autoScroll();
    }
    userScrolledUp = false;
    // Finalize the ORIGINAL chat
    const lastMsg = streamChat.messages[streamChat.messages.length - 1];
    if (content.trim()) {
      if (lastMsg && lastMsg._streaming) {
        lastMsg.content = content;
        lastMsg.timestamp = Date.now();
        delete lastMsg._streaming;
      } else {
        streamChat.messages.push({ role: 'assistant', content, timestamp: Date.now() });
      }
      streamChat.updatedAt = Date.now(); saveChats(); renderSidebar();
    }
    // If user navigated back, re-render to show completed response
    if (isViewingThis()) renderMessages();
  } catch (e) {
    // Silent auto-retry up to 3 times on network errors before showing error to user
    if (!content && e.message && (e.message.includes('network') || e.message.includes('Failed to fetch') || e.message.includes('CONNECTION'))) {
      let retrySuccess = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          if (isViewingThis()) bodyEl.innerHTML = '<div class="thinking"><span>.</span><span>.</span><span>.</span></div>';
          await new Promise(r => setTimeout(r, attempt * 2000)); // 2s, 4s, 6s backoff
          const res2 = await fetch(`${API}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
            body: JSON.stringify({ message: finalText, sessionId: streamSessionId, attachments: msgAttachments || [] }),
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
                if (event.type === 'stream') { content += event.delta; if (isViewingThis()) bodyEl.innerHTML = md(content); }
                if (event.type === 'tool_start' && isViewingThis()) { bodyEl.innerHTML = content ? md(content) : ''; bodyEl.appendChild(makeToolCard(event.toolName, event.args, event.riskLevel, event.context)); }
                if (event.type === 'tool_end' && isViewingThis()) { const cards = bodyEl.querySelectorAll('.tool-card'); const last = cards[cards.length-1]; if(last){last.querySelector('.indicator').className='indicator '+(event.allowed?'allowed':'blocked');} }
                if (event.type === 'done') { savePartial(); }
              } catch {}
            }
          }
          retrySuccess = true;
          break;
        } catch { /* retry */ }
      }
      if (!retrySuccess && isViewingThis()) showRetryError(bodyEl, finalText, e.message);
    } else {
      if (isViewingThis()) showRetryError(bodyEl, finalText, e.message);
    }
  }
  flushTTS();
  // Browser notification for completed long tasks (feature 96)
  if (typeof window.notifyTaskComplete === 'function') window.notifyTaskComplete(streamChat.title);
  // ALWAYS clear streaming state — must happen before anything that could throw
  if (streamingSessionId === streamSessionId) streamingSessionId = null;
  // Always hide stop button and re-enable send when stream ends
  try {
    const stopBtn2 = document.getElementById('stop-btn');
    if (stopBtn2) stopBtn2.style.display = 'none';
    document.getElementById('send-btn').disabled = false;
    if (isViewingThis()) renderMessages();
    updateContextBar();
  } catch (renderErr) { console.error('[chat] finalize render error:', renderErr); }
}

// ── Context health indicator ──
function updateContextBar() {
  const bar = document.getElementById('context-bar');
  if (!bar || !activeChat) { if (bar) bar.classList.remove('visible'); return; }

  const msgCount = activeChat.messages.length;
  const compacted = activeChat.compactedAt || 0; // messages compacted so far
  const effective = msgCount - compacted;

  if (effective < 20) {
    bar.classList.remove('visible');
    return;
  }

  bar.classList.add('visible');
  let dot, text, showCompact = false;

  const compactLabel = compacted ? ` (AI sees ${effective})` : '';
  if (effective < 40) {
    dot = 'green';
    text = `${msgCount} messages${compactLabel} — context healthy`;
  } else if (effective < 60) {
    dot = 'yellow';
    text = `${msgCount} messages${compactLabel} — context getting long`;
    showCompact = true;
  } else {
    dot = 'red';
    text = `${msgCount} messages${compactLabel} — context heavy, consider compacting`;
    showCompact = true;
  }

  bar.innerHTML = `
    <span class="ctx-dot ${dot}"></span>
    <span class="ctx-text">${text}</span>
    ${showCompact ? `<button class="ctx-action" onclick="compactChat()">Compact context</button>` : ''}
  `;
}

// ── Context compaction (like Claude Code) ──
// Keeps full chat visible in UI, but tells the server to summarize old messages
// for the AI. The chat record on disk stays complete.
async function compactChat() {
  if (!activeChat) return;
  console.log('[compact] Starting compact for', activeChat.id, 'with', activeChat.messages.length, 'frontend messages');

  const bar = document.getElementById('context-bar');
  if (bar) bar.innerHTML = '<span class="ctx-dot yellow"></span><span class="ctx-text">Compacting context...</span>';

  try {
    const res = await apiFetch('/api/compact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: activeChat.id }),
    });
    const data = await res.json();
    console.log('[compact] Response:', data);
    if (data.ok) {
      activeChat.compactedAt = data.compactedAt || activeChat.messages.length - 20;
      saveChats();

      // Show compaction marker in chat
      const el = document.getElementById('messages');
      const marker = document.createElement('div');
      marker.style.cssText = 'text-align:center;padding:12px;font-family:var(--mono);font-size:.7rem;color:var(--accent);border-top:1px dashed var(--border);border-bottom:1px dashed var(--border);margin:12px 0';
      marker.textContent = `— context compacted — ${data.oldCount} old messages summarized, ${data.recentCount} kept in full —`;
      el.appendChild(marker);
      autoScroll();
    } else {
      console.warn('[compact] Not compacted:', data.reason);
      if (bar) bar.innerHTML = `<span class="ctx-dot yellow"></span><span class="ctx-text">${esc(data.reason || 'Compact failed')}</span>`;
    }
  } catch (e) {
    console.warn('Compact failed:', e);
    if (bar) bar.innerHTML = `<span class="ctx-dot red"></span><span class="ctx-text">Compact error: ${esc(e.message)}</span>`;
  }
  updateContextBar();
}

// Markdown preview toggle state (feature 90)
let mdPreviewMode = true; // true = rendered, false = raw

function toggleMdPreview() {
  mdPreviewMode = !mdPreviewMode;
  const btn = document.getElementById('md-toggle-btn');
  if (btn) { btn.textContent = mdPreviewMode ? 'Raw' : 'Preview'; btn.title = mdPreviewMode ? 'Show raw markdown' : 'Show rendered markdown'; }
  renderMessages();
}

function formatMsgTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;
  const mins = Math.floor(diff / 60000);
  const hrs = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (days === 0) return time;
  if (days === 1) return 'Yesterday ' + time;
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + time;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time;
}

function addMessageEl(role, text, attachments) {
  const el = document.getElementById('messages');
  const div = document.createElement('div'); div.className = 'msg ' + role;
  div.setAttribute('role', 'article');
  div.setAttribute('aria-label', role === 'user' ? 'Your message' : 'Assistant message');
  let attachHtml = '';
  if (attachments && attachments.length) {
    attachHtml = '<div class="msg-attachments">' + attachments.map(a => {
      if (a.isImage && a.dataUrl) {
        return `<img src="${esc(a.dataUrl)}" alt="${esc(a.name)}" onclick="openLightbox(this.src)" title="${esc(a.name)}" loading="lazy" />`;
      } else if (a.isImage && a.url) {
        const authedUrl = a.url + (a.url.includes('?') ? '&' : '?') + 'token=' + AUTH_TOKEN;
        return `<img src="${esc(authedUrl)}" alt="${esc(a.name)}" onclick="openLightbox(this.src)" title="${esc(a.name)}" loading="lazy" />`;
      } else if (a.isImage) {
        return `<div class="att-badge"><span>&#128444;</span> ${esc(a.name)}</div>`;
      } else {
        return `<div class="att-badge"><span>&#128196;</span> ${esc(a.name)} (${(a.size / 1024).toFixed(1)}KB)</div>`;
      }
    }).join('') + '</div>';
  }
  const bodyContent = role === 'assistant' ? (mdPreviewMode ? md(text) : `<pre class="raw-md">${esc(text)}</pre>`) : esc(text);
  // Timestamp
  const ts = arguments[3]; // optional 4th arg: timestamp
  const timeStr = ts ? formatMsgTime(ts) : '';
  const timeHtml = timeStr ? `<span class="msg-time">${timeStr}</span>` : '';
  div.innerHTML = `<div class="msg-label">${role === 'user' ? 'You' : 'Assistant'}</div><div class="msg-body">${attachHtml}${bodyContent}</div><div class="msg-footer">${timeHtml}</div>`;
  el.appendChild(div);
  // Spring entrance for new messages
  if (typeof Spring !== 'undefined') {
    Spring.fadeIn(div, { preset: 'stiff', slide: true, slideFrom: 8 });
  }
  // Scroll after images load (they change height)
  const imgs = div.querySelectorAll('.msg-attachments img');
  if (imgs.length) {
    imgs.forEach(img => img.onload = () => autoScroll());
  }
  autoScroll();
  return div;
}

function openLightbox(src) {
  let lb = document.getElementById('img-preview-overlay');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'img-preview-overlay';
    lb.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;z-index:10000;cursor:zoom-out;backdrop-filter:blur(4px)';
    lb.onclick = () => lb.style.display = 'none';
    document.body.appendChild(lb);
  }
  lb.textContent = '';
  const img = document.createElement('img');
  img.src = src;
  img.style.cssText = 'max-width:90vw;max-height:90vh;border-radius:8px;box-shadow:0 0 40px rgba(0,0,0,.5)';
  lb.appendChild(img);
  lb.style.display = 'flex';
}

function toolSummary(name, args) {
  switch (name) {
    case 'browser': {
      const a = args.action || '';
      if (a === 'navigate') return `Opening ${args.url || 'page'}...`;
      if (a === 'snapshot') return 'Scanning page elements...';
      if (a === 'click') return args.ref ? `Clicking [${args.ref}]...` : `Clicking ${args.selector || 'element'}...`;
      if (a === 'click_text') return `Clicking "${args.text || ''}"...`;
      if (a === 'fill') return args.ref ? `Typing into [${args.ref}]...` : `Typing into ${args.selector || 'field'}...`;
      if (a === 'screenshot') return 'Taking screenshot...';
      if (a === 'extract') return 'Reading page content...';
      return `Browser: ${a}`;
    }
    case 'read': return `Reading ${(args.path || '').split(/[/\\]/).pop() || 'file'}`;
    case 'write': return `Writing ${(args.path || '').split(/[/\\]/).pop() || 'file'}`;
    case 'edit': return `Editing ${(args.path || '').split(/[/\\]/).pop() || 'file'}`;
    case 'bash': return `Running: ${(args.command || '').slice(0, 50)}`;
    case 'http_request': return `${args.method || 'GET'} ${(args.url || '').slice(0, 50)}`;
    case 'memory_search': return `Searching memory: "${(args.query || '').slice(0, 40)}"`;
    case 'memory_save': return `Saving to ${args.target || 'daily'} memory`;
    case 'generate_image': return `Generating: ${(args.prompt || '').slice(0, 40)}...`;
    default: return `${name} ${JSON.stringify(args).slice(0, 60)}`;
  }
}

function makeToolCard(name, args, riskLevel, context) {
  const card = document.createElement('div'); card.className = 'tool-card';
  card.innerHTML = `<div class="tool-header" onclick="this.parentElement.classList.toggle('open')"><span class="indicator"></span><span class="tool-name">${esc(name)}</span><span style="color:var(--muted);font-size:.72rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${esc(toolSummary(name, args))}</span><span style="color:var(--muted);font-size:.65rem">&#9654;</span></div>`
    + `<div class="tool-detail">executing...</div>`;
  return card;
}

// ── Secret modal ──
let pendingSecretName = '';
function showSecretModal(name, service, reason) {
  pendingSecretName = name;
  let overlay = document.getElementById('secret-modal-overlay');
  if (!overlay) {
    overlay = document.createElement('div'); overlay.id = 'secret-modal-overlay';
    overlay.innerHTML = `<div id="secret-modal"><h3 style="font-family:var(--mono);color:var(--accent);font-size:.95rem;margin-bottom:6px">Secret Requested</h3><div id="sm-service" style="color:var(--muted);font-size:.72rem;font-family:var(--mono);margin-bottom:12px"></div><div id="sm-name" style="display:inline-block;background:#1a1a30;border:1px solid var(--border);border-radius:6px;padding:3px 10px;font-family:var(--mono);font-size:.78rem;color:var(--accent);margin-bottom:12px"></div><div id="sm-reason" style="color:var(--muted);font-size:.82rem;margin-bottom:16px;line-height:1.5"></div><input type="password" id="secret-input" class="field-input" placeholder="Paste your secret here..." autocomplete="off" onkeydown="if(event.key==='Enter')submitSecret()"/><div style="font-size:.7rem;color:var(--muted);margin-top:8px">Encrypted and stored locally. Never appears in chat.</div><div style="display:flex;gap:10px;margin-top:16px;justify-content:flex-end"><button class="action-btn secondary" onclick="cancelSecret()">Cancel</button><button class="action-btn primary" onclick="submitSecret()">Save Secret</button></div></div>`;
    overlay.onclick = e => { if (e.target === overlay) cancelSecret(); };
    document.body.appendChild(overlay);
  }
  document.getElementById('sm-name').textContent = name;
  document.getElementById('sm-service').textContent = service ? `Service: ${service}` : '';
  document.getElementById('sm-reason').textContent = reason;
  document.getElementById('secret-input').value = '';
  overlay.classList.add('visible');
  setTimeout(() => document.getElementById('secret-input').focus(), 100);
}
async function submitSecret() {
  const v = document.getElementById('secret-input').value.trim(); if (!v) return;
  await apiPost('/api/secrets', { name: pendingSecretName, value: v });
  cancelSecret();
}
function cancelSecret() {
  const o = document.getElementById('secret-modal-overlay'); if (o) o.classList.remove('visible');
  pendingSecretName = '';
}

// ── Upload ──
// ── Retry with error hints ──
function showRetryError(el, originalMessage, errorMsg) {
  let hint = 'Check your internet connection and try again.';
  if (errorMsg.includes('timeout') || errorMsg.includes('Timeout')) hint = 'The server took too long to respond. It may be processing a heavy task — try again in a moment.';
  else if (errorMsg.includes('Failed to fetch') || errorMsg.includes('network')) hint = 'Could not reach the server. Make sure Open Agent X is running.';
  else if (errorMsg.includes('401') || errorMsg.includes('Unauthorized')) hint = 'Authentication failed. Try refreshing the page.';
  else if (errorMsg.includes('429')) hint = 'Too many requests. Wait a moment and try again.';
  else if (errorMsg.includes('500') || errorMsg.includes('Internal')) hint = 'Server error. Check the server logs for details.';

  el.innerHTML = `<div class="error-retry">
    <div style="color:var(--danger);font-size:.82rem;margin-bottom:6px">Something went wrong</div>
    <div style="color:var(--muted);font-size:.75rem;margin-bottom:12px">${esc(hint)}</div>
    <button class="action-btn primary" style="font-size:.75rem;padding:6px 16px" onclick="retryMessage('${esc(originalMessage.replace(/'/g, "\\'"))}')">Retry</button>
  </div>`;
}

function retryMessage(text) {
  const input = document.getElementById('msg-input');
  if (input) { input.value = text; }
  sendMessage();
}

function triggerUpload() { document.getElementById('file-input')?.click(); }
function handleFileUpload(event) {
  addFilesToUpload(Array.from(event.target.files || []));
}

function renderUploadPreviews() {
  const bar = document.getElementById('upload-previews');
  if (!bar) return;
  if (pendingUploads.length === 0) { bar.classList.remove('has-items'); bar.innerHTML = ''; return; }
  bar.classList.add('has-items');
  bar.innerHTML = pendingUploads.map((f, i) => {
    if (f.dataUrl) {
      return `<div style="position:relative;width:140px;height:110px;border-radius:10px;overflow:hidden;background:#111;border:1px solid var(--border);cursor:pointer;flex-shrink:0" onclick="previewImage('${i}')">
        <img src="${f.dataUrl}" style="width:100%;height:100%;object-fit:cover"/>
        <button onclick="event.stopPropagation();removeUpload(${i})" style="position:absolute;top:5px;right:5px;width:22px;height:22px;border-radius:50%;background:rgba(0,0,0,.65);border:none;color:#fff;font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px)">&times;</button>
      </div>`;
    }
    return `<div style="position:relative;display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--surface);border:1px solid var(--border);border-radius:10px;flex-shrink:0;min-width:180px">
      <div style="width:36px;height:36px;border-radius:8px;background:#1a1a30;display:flex;align-items:center;justify-content:center;font-size:1.1rem;flex-shrink:0">&#128196;</div>
      <div style="min-width:0"><div style="font-size:.78rem;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px">${esc(f.name)}</div><div style="font-size:.65rem;color:var(--muted)">${f.type || 'File'}</div></div>
      <button onclick="removeUpload(${i})" style="position:absolute;top:5px;right:5px;width:20px;height:20px;border-radius:50%;background:rgba(0,0,0,.65);border:none;color:#fff;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center">&times;</button>
    </div>`;
  }).join('');
}

// ── Voice v2: Always-On with simple VAD (no external libs) ──
// Uses Web Audio API volume detection — no ONNX, no worklets, just works.
let voiceMode = false;
let vadStream = null;
let vadAnalyser = null;
let vadContext = null;
let vadRecorder = null;
let vadChunks = [];
let silenceStart = 0;
let speechDetected = false;
const SPEECH_THRESHOLD = 15;   // Volume level to detect speech (0-255)
const SILENCE_DURATION = 1200; // ms of silence before ending recording
const MIN_SPEECH_MS = 500;     // Minimum speech duration to process

async function toggleMic() {
  if (voiceMode) { stopVoiceMode(); } else { await startVoiceMode(); }
}

async function startVoiceMode() {
  stopSpeaking();
  try {
    // Try to use a saved mic device, or find a real hardware mic (skip virtual devices like Steam)
    let audioConstraints = { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 };
    const savedMic = localStorage.getItem('sax_mic_device');
    if (savedMic) {
      audioConstraints.deviceId = { exact: savedMic };
    } else {
      // Auto-detect: skip virtual audio devices
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const mics = devices.filter(d => d.kind === 'audioinput');
        const realMic = mics.find(d => !d.label.toLowerCase().includes('steam') && !d.label.toLowerCase().includes('virtual') && !d.label.toLowerCase().includes('cable'));
        if (realMic) audioConstraints.deviceId = { exact: realMic.deviceId };
        console.log('[voice] Available mics:', mics.map(d => d.label));
        console.log('[voice] Selected:', realMic?.label || 'default');
      } catch {}
    }
    vadStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });

    // Debug: check track state
    const tracks = vadStream.getAudioTracks();
    console.log('[voice] Audio tracks:', tracks.length, tracks.map(t => ({ label: t.label, enabled: t.enabled, muted: t.muted, readyState: t.readyState })));
    if (tracks.length > 0 && tracks[0].muted) {
      console.warn('[voice] Track is muted — Electron may be blocking audio capture');
    }

    vadContext = new AudioContext({ sampleRate: 16000 });
    const source = vadContext.createMediaStreamSource(vadStream);
    vadAnalyser = vadContext.createAnalyser();
    vadAnalyser.fftSize = 512;
    vadAnalyser.smoothingTimeConstant = 0.3;
    source.connect(vadAnalyser);

    voiceMode = true;
    voiceEnabled = true;
    const ttsBtn = document.getElementById('tts-toggle');
    if (ttsBtn) { ttsBtn.textContent = 'VOICE ON'; ttsBtn.className = 'active'; }
    updateVoiceUI();
    console.log('[voice] Always-on voice mode started');

    // Start monitoring loop
    monitorVoice();
  } catch (e) {
    console.error('[voice] Mic failed:', e);
    alert('Voice mode failed. Check microphone permissions.\nError: ' + e.message);
  }
}

function stopVoiceMode() {
  voiceMode = false; isListening = false; speechDetected = false;
  if (vadRecorder && vadRecorder.state !== 'inactive') vadRecorder.stop();
  if (vadStream) { vadStream.getTracks().forEach(t => t.stop()); vadStream = null; }
  if (vadContext) { vadContext.close(); vadContext = null; }
  vadAnalyser = null; vadRecorder = null; vadChunks = [];
  stopSpeaking(); updateVoiceUI();
  console.log('[voice] Voice mode stopped');
}

function monitorVoice() {
  if (!voiceMode || !vadAnalyser) return;

  const data = new Uint8Array(vadAnalyser.frequencyBinCount);
  vadAnalyser.getByteFrequencyData(data);
  const volume = data.reduce((a, b) => a + b, 0) / data.length;

  if (volume > SPEECH_THRESHOLD) {
    // Speech detected
    if (!speechDetected && !isSpeaking) {
      speechDetected = true;
      isListening = true;
      stopSpeaking(); // Interrupt TTS
      startRecording();
      updateVoiceUI();
    }
    silenceStart = 0;
  } else if (speechDetected) {
    // Silence after speech
    if (!silenceStart) silenceStart = Date.now();
    if (Date.now() - silenceStart > SILENCE_DURATION) {
      // Enough silence — stop recording and transcribe
      speechDetected = false;
      isListening = false;
      stopRecording();
      updateVoiceUI();
    }
  }

  requestAnimationFrame(monitorVoice);
}

function startRecording() {
  if (!vadStream || vadRecorder) return;
  vadChunks = [];
  vadRecorder = new MediaRecorder(vadStream, {
    mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
  });
  vadRecorder.ondataavailable = e => { if (e.data.size > 0) vadChunks.push(e.data); };
  vadRecorder.onstop = async () => {
    vadRecorder = null;
    if (vadChunks.length === 0) return;
    const blob = new Blob(vadChunks, { type: 'audio/webm' });
    vadChunks = [];

    // Skip very short recordings (noise, not speech)
    if (blob.size < 5000) return;

    updateVoiceUI('transcribing');
    try {
      const wavBlob = await webmToWav16k(blob);
      const r = await fetch(`${API}/api/voice/transcribe`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
        body: new Uint8Array(await wavBlob.arrayBuffer()),
      });
      const d = await r.json();
      if (d.text?.trim() && d.text.trim().length > 1) {
        document.getElementById('msg-input').value = d.text.trim();
        sendMessage();
      }
    } catch (e) { console.error('[voice] STT failed:', e); }
    updateVoiceUI();
  };
  vadRecorder.start(100);
  console.log('[voice] Recording started');
}

function stopRecording() {
  if (vadRecorder && vadRecorder.state !== 'inactive') {
    vadRecorder.stop();
    console.log('[voice] Recording stopped');
  }
}

// Convert WebM → WAV 16kHz mono for Whisper
async function webmToWav16k(blob) {
  const ctx = new OfflineAudioContext(1, 1, 16000);
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  // Resample to 16kHz mono
  const offline = new OfflineAudioContext(1, Math.ceil(buf.duration * 16000), 16000);
  const src = offline.createBufferSource();
  src.buffer = buf;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  const samples = rendered.getChannelData(0);

  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
  const ds = pcm.length * 2, hdr = new ArrayBuffer(44), v = new DataView(hdr);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0,'RIFF'); v.setUint32(4, 36+ds, true); w(8,'WAVE'); w(12,'fmt ');
  v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,1,true);
  v.setUint32(24,16000,true); v.setUint32(28,32000,true); v.setUint16(32,2,true); v.setUint16(34,16,true);
  w(36,'data'); v.setUint32(40,ds,true);
  return new Blob([hdr, pcm.buffer], { type: 'audio/wav' });
}
function toggleTTS() {
  voiceEnabled = !voiceEnabled;
  const btn = document.getElementById('tts-toggle');
  if (btn) { btn.textContent = voiceEnabled ? 'VOICE ON' : 'VOICE OFF'; btn.className = voiceEnabled ? 'active' : ''; }
  if (!voiceEnabled) stopSpeaking();
}
// Pre-fetch: start fetching next audio while current plays
let prefetchedAudio = null;

async function fetchTTSAudio(text) {
  // Check if XTTS is selected
  let ttsEngine = 'kokoro';
  try { const s = JSON.parse(localStorage.getItem('sax_settings') || '{}'); ttsEngine = s.ttsEngine || 'kokoro'; } catch {}

  let r;
  if (ttsEngine === 'xtts') {
    let voiceId = '';
    try { const s = JSON.parse(localStorage.getItem('sax_settings') || '{}'); voiceId = s.xttsVoice || ''; } catch {}
    r = await fetch('http://127.0.0.1:7862/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.trim(), voice_id: voiceId, language: 'en' })
    });
  } else {
    r = await fetch(`${API}/api/voice/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ text: text.trim(), speed: 1.15 })
    });
  }
  if (!r.ok) return null;
  if (!audioContext) audioContext = new AudioContext();
  return await audioContext.decodeAudioData(await r.arrayBuffer());
}

async function speakSentence(text) {
  if (!voiceEnabled || !text.trim()) return;
  // Client-side cleanup — strip URLs, code, paths before sending
  let clean = text.replace(/https?:\/\/\S+/g, '').replace(/`[^`]+`/g, '')
    .replace(/[\w/\\.-]+\.(?:html|js|ts|css|json|md)\b/g, '').replace(/\([^)]{15,}\)/g, '').trim();
  if (clean.length < 4) { if (ttsQueue.length > 0) await speakSentence(ttsQueue.shift()); return; }

  isSpeaking = true; updateVoiceUI();
  try {
    // Use pre-fetched audio if available, otherwise fetch now
    let buf = prefetchedAudio; prefetchedAudio = null;
    if (!buf) buf = await fetchTTSAudio(clean);
    if (!buf) throw new Error('TTS empty');

    // Pre-fetch NEXT audio while this one plays (eliminates gap)
    if (ttsQueue.length > 0) {
      const nextText = ttsQueue[0].replace(/https?:\/\/\S+/g, '').replace(/`[^`]+`/g, '').trim();
      if (nextText.length > 3) fetchTTSAudio(nextText).then(a => { prefetchedAudio = a; });
    }

    const src = audioContext.createBufferSource(); src.buffer = buf; src.connect(audioContext.destination);
    currentAudioSource = src;
    await new Promise(res => { src.onended = res; src.start(); });
    currentAudioSource = null;
  } catch (e) { console.warn('[voice] TTS error:', e); }
  if (ttsQueue.length > 0) await speakSentence(ttsQueue.shift());
  else { isSpeaking = false; updateVoiceUI(); }
}
let ttsBatchBuffer = '';
function feedTTS(delta) {
  if (!voiceEnabled) return;
  ttsSentenceBuffer += delta;

  // Look for sentence boundaries
  const re = /[.!?]\s+|[.!?]$/;
  while (re.test(ttsSentenceBuffer)) {
    const m = ttsSentenceBuffer.match(re), idx = m.index + m[0].length;
    const s = ttsSentenceBuffer.slice(0, idx).trim();
    ttsSentenceBuffer = ttsSentenceBuffer.slice(idx);
    if (s.length > 3) ttsBatchBuffer += (ttsBatchBuffer ? ' ' : '') + s;
  }

  // Send batch when we have enough text (80+ chars = ~2 sentences)
  // This reduces pauses between sentences dramatically
  if (ttsBatchBuffer.length > 80) {
    const batch = ttsBatchBuffer; ttsBatchBuffer = '';
    isSpeaking ? ttsQueue.push(batch) : speakSentence(batch);
  }
}
function flushTTS() {
  // Flush any remaining batched text + sentence buffer
  const remaining = (ttsBatchBuffer + ' ' + ttsSentenceBuffer).trim();
  ttsBatchBuffer = '';
  if (voiceEnabled && remaining.length > 3) { isSpeaking ? ttsQueue.push(remaining) : speakSentence(remaining); }
  ttsSentenceBuffer = '';
}
function stopSpeaking() {
  try { currentAudioSource?.stop(); } catch {} currentAudioSource = null;
  ttsQueue = []; ttsSentenceBuffer = ''; isSpeaking = false; updateVoiceUI();
}
function updateVoiceUI(state) {
  const mic = document.getElementById('mic-btn'), ind = document.getElementById('voice-indicator');
  if (!mic) return;
  if (state === 'transcribing') { mic.className = 'input-btn listening'; if (ind) { ind.className = 'listening'; ind.textContent = '⚡ TRANSCRIBING...'; } return; }
  if (voiceMode) {
    mic.className = 'input-btn' + (isListening ? ' listening' : isSpeaking ? ' speaking' : ' listening');
    mic.title = 'Voice mode ON — click to stop';
    if (ind) {
      if (isListening) { ind.className = 'listening'; ind.textContent = '🎙 LISTENING...'; }
      else if (isSpeaking) { ind.className = 'speaking'; ind.textContent = '🔊 SPEAKING...'; }
      else { ind.className = 'listening'; ind.textContent = '🎙 VOICE MODE'; }
    }
  } else {
    mic.className = 'input-btn';
    mic.title = 'Click for voice mode (hands-free)';
    if (ind) { ind.className = ''; ind.textContent = ''; }
  }
}

// ── Keyboard shortcuts ──
document.addEventListener('keydown', e => {
  if (e.code === 'Escape') { if (voiceMode) stopVoiceMode(); else stopSpeaking(); }
});

// Auto-resize textarea
document.getElementById('msg-input')?.addEventListener('input', function () { this.style.height = 'auto'; this.style.height = Math.min(this.scrollHeight, 200) + 'px'; });

// ── Paste handling (images + files from clipboard) ──
document.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  const files = [];
  for (const item of items) {
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (files.length > 0) {
    e.preventDefault();
    addFilesToUpload(files);
  }
});

// ── Drag & drop (feature 93: works anywhere in main area) ──
function initDragDrop() {
  const dropZone = document.getElementById('main') || document.getElementById('page-chat');
  if (!dropZone) return;
  let dragCounter = 0;

  // Create drop overlay
  let dropOverlay = document.getElementById('drop-overlay');
  if (!dropOverlay) {
    dropOverlay = document.createElement('div');
    dropOverlay.id = 'drop-overlay';
    dropOverlay.innerHTML = '<div class="drop-overlay-content"><span class="drop-icon">&#128206;</span><span>Drop files to attach</span></div>';
    dropZone.appendChild(dropOverlay);
  }

  dropZone.addEventListener('dragenter', (e) => {
    // Only show file drop overlay if dragging actual files (not internal drags like org chart)
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    dragCounter++;
    dropOverlay.classList.add('visible');
  });
  dropZone.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  dropZone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) { dragCounter = 0; dropOverlay.classList.remove('visible'); }
  });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    dropOverlay.classList.remove('visible');
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length > 0) {
      // Navigate to chat if not already there
      if (typeof currentRoute === 'function' && currentRoute() !== 'chat') navigate('chat');
      addFilesToUpload(files);
    }
  });
}
initDragDrop();

async function addFilesToUpload(files) {
  for (const f of files) {
    const isImage = f.type.startsWith('image/');
    const entry = { name: f.name, size: f.size, type: f.type, isImage, url: null, dataUrl: null };

    // Local preview for images
    if (isImage) {
      const reader = new FileReader();
      reader.onload = () => { entry.dataUrl = reader.result; renderUploadPreviews(); };
      reader.readAsDataURL(f);
    }

    pendingUploads.push(entry);
    renderUploadPreviews();

    // Upload to server in background
    const form = new FormData();
    form.append('file', f);
    try {
      const res = await apiFetch('/api/upload', { method: 'POST', body: form, headers: {} });
      const data = await res.json();
      if (data.files && data.files[0]) entry.url = data.files[0].url;
    } catch (e) { console.warn('Upload failed:', e); }
  }
}

function removeUpload(index) {
  pendingUploads.splice(index, 1);
  renderUploadPreviews();
}

function previewImage(index) {
  const f = pendingUploads[index];
  if (!f?.dataUrl) return;
  let overlay = document.getElementById('img-preview-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'img-preview-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;z-index:10000;cursor:pointer;backdrop-filter:blur(4px)';
    overlay.onclick = () => overlay.style.display = 'none';
    document.body.appendChild(overlay);
  }
  overlay.textContent = '';
  var prevImg = document.createElement('img');
  prevImg.src = f.dataUrl;
  prevImg.style.cssText = 'max-width:90vw;max-height:90vh;border-radius:8px;box-shadow:0 0 40px rgba(0,0,0,.5)';
  overlay.appendChild(prevImg);
  overlay.style.display = 'flex';
}

// ── Context usage indicator ──
let lastContextStatus = null;

function updateContextBar(event) {
  if (event) lastContextStatus = event;
  let data = lastContextStatus;

  let bar = document.getElementById('context-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'context-bar';
    bar.style.cssText = 'display:none;max-width:800px;margin:0 auto 8px;width:100%;padding:0 14px';
    const inputArea = document.getElementById('input-area');
    if (inputArea) inputArea.insertBefore(bar, inputArea.firstChild);
  }

  if (!data) {
    // Show empty bar at 0% until first status comes in
    data = { percentage: 0, level: 'ok', usedTokens: 0, maxTokens: 128000, compacted: false };
  }

  bar.style.display = 'block';

  // Color based on level
  let color = 'var(--accent)';      // green
  let bgColor = 'rgba(64,240,240,.1)';
  if (data.percentage >= 95) { color = 'var(--danger)'; bgColor = 'rgba(255,51,51,.1)'; }
  else if (data.percentage >= 85) { color = 'var(--warn)'; bgColor = 'rgba(255,170,0,.1)'; }
  else if (data.percentage >= 70) { color = '#88aaff'; bgColor = 'rgba(136,170,255,.08)'; }

  const compactedNote = data.compacted ? ' <span style="color:var(--accent)">(compacted)</span>' : '';
  const tokensK = (data.usedTokens / 1000).toFixed(0);
  const maxK = (data.maxTokens / 1000).toFixed(0);

  bar.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;font-family:var(--mono);font-size:.68rem">
      <div style="flex:1;height:4px;background:var(--border);border-radius:2px;overflow:hidden">
        <div style="height:100%;width:${Math.min(data.percentage, 100)}%;background:${color};border-radius:2px;transition:width .3s"></div>
      </div>
      <span style="color:${color};white-space:nowrap">${data.percentage}% context${compactedNote}</span>
      <span style="color:var(--muted);white-space:nowrap">${tokensK}K / ${maxK}K</span>
    </div>
  `;
}

// Expose for cross-file access
window.streamingSessionId = null;
Object.defineProperty(window, 'streamingSessionId', {
  get() { return streamingSessionId; },
  set(v) { streamingSessionId = v; }
});
Object.defineProperty(window, 'chatWs', {
  get() { return chatWs; }
});

// ── Status bar (feature 97) ──
let serverStartTime = Date.now();

let _providersCache = null;
let _providersCacheTime = 0;

function initStatusBar() {
  const bar = document.getElementById('status-bar');
  if (!bar) return;
  loadProviders().then(() => updateStatusBar());
  setInterval(updateStatusBar, 10000);
  apiFetch('/api/auth/status').then(r => r.json()).then(d => {
    if (d.uptime) serverStartTime = Date.now() - (d.uptime * 1000);
  }).catch(() => {});
}

async function loadProviders() {
  if (_providersCache && Date.now() - _providersCacheTime < 30000) return _providersCache;
  try {
    const res = await apiFetch('/api/providers');
    const data = await res.json();
    _providersCache = data;
    _providersCacheTime = Date.now();
    return data;
  } catch { return null; }
}

function updateStatusBar() {
  const bar = document.getElementById('status-bar');
  if (!bar) return;
  const uptime = formatUptime(Date.now() - serverStartTime);
  const tokenInfo = window.lastContextStatus ? `${(window.lastContextStatus.usedTokens / 1000).toFixed(0)}K tokens` : '—';
  const data = _providersCache;
  const currentProvider = data?.current?.provider || '—';
  const currentModel = data?.current?.model || '—';
  const providers = data?.providers || [];
  const activeP = providers.find(p => p.active) || providers[0];
  const providerName = activeP?.name || currentProvider;

  // Build provider dropdown options
  const providerOpts = providers.map(p =>
    `<option value="${esc(p.id)}" ${p.active ? 'selected' : ''}>${esc(p.name)}</option>`
  ).join('');

  // Build model dropdown for active provider
  const modelOpts = activeP ? activeP.models.map(m =>
    `<option value="${esc(m)}" ${m === currentModel ? 'selected' : ''}>${esc(m)}</option>`
  ).join('') : `<option value="${esc(currentModel)}">${esc(currentModel)}</option>`;

  bar.innerHTML = `
    <span class="status-item status-selector" aria-label="Provider">
      <select id="provider-quick-select" class="status-select" onchange="quickSwitchProvider(this.value)" title="Switch provider">${providerOpts}</select>
    </span>
    <span class="status-item status-selector" aria-label="Model">
      <select id="model-quick-select" class="status-select" onchange="quickSwitchModel(this.value)" title="Switch model">${modelOpts}</select>
    </span>
    <span class="status-item" aria-label="Token usage"><span class="status-icon">&#9998;</span> ${tokenInfo}</span>
    <span class="status-item" aria-label="Server uptime"><span class="status-icon">&#9200;</span> ${uptime}</span>
    <span class="status-item" title="All data stays on your machine. API calls go to your selected provider." style="cursor:help"><span class="status-icon">&#128274;</span> Local</span>
  `;
}

async function quickSwitchProvider(providerId) {
  const data = _providersCache;
  const provider = data?.providers?.find(p => p.id === providerId);
  const model = provider ? provider.models[0] : '';
  try {
    await apiFetch('/api/providers/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: providerId, model }),
    });
    // Update local settings cache too
    try { const s = JSON.parse(localStorage.getItem('sax_settings') || '{}'); s.provider = providerId; s.model = model; localStorage.setItem('sax_settings', JSON.stringify(s)); } catch {}
    _providersCacheTime = 0; // Force refresh
    await loadProviders();
    updateStatusBar();
  } catch (e) { console.warn('[provider] Switch failed:', e); }
}

async function quickSwitchModel(model) {
  const providerSel = document.getElementById('provider-quick-select');
  const provider = providerSel ? providerSel.value : '';
  try {
    await apiFetch('/api/providers/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, model }),
    });
    try { const s = JSON.parse(localStorage.getItem('sax_settings') || '{}'); s.model = model; localStorage.setItem('sax_settings', JSON.stringify(s)); } catch {}
    _providersCacheTime = 0;
    await loadProviders();
    updateStatusBar();
  } catch (e) { console.warn('[model] Switch failed:', e); }
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm';
}

// Store last context status globally for status bar
const _origUpdateContextBar = updateContextBar;
window.lastContextStatus = null;

// ── Agent Feeds (Mission Control) ──
const AGENT_ROLE_ICONS = {
  researcher: '\uD83D\uDD0D', writer: '\u270D\uFE0F', coder: '\uD83D\uDCBB',
  reviewer: '\uD83D\uDD0E', 'social-media': '\uD83D\uDCF1', analyst: '\uD83D\uDCCA',
  monitor: '\uD83D\uDC41\uFE0F', designer: '\uD83C\uDFA8', ops: '\u2699\uFE0F',
  communicator: '\uD83D\uDCE8'
};
let agentFeedsOpen = false;
let agentFeedsData = {};

function toggleAgentFeeds() {
  var panel = document.getElementById('agent-feeds');
  var toggleBtn = document.getElementById('agents-toggle');
  if (!panel) return;
  agentFeedsOpen = !agentFeedsOpen;
  // Disable CSS transition — spring handles it
  panel.style.transition = 'none';
  if (agentFeedsOpen) {
    panel.classList.remove('collapsed');
    panel.classList.add('active');
    panel.querySelector('.agent-feeds-toggle').innerHTML = '&#9654;';
    if (toggleBtn) toggleBtn.style.display = 'none';
    panel.style.overflow = 'hidden';
    Spring.animate(panel, 'width', 320, { from: 0, preset: 'stiff', unit: 'px', onUpdate: function(v) { panel.style.minWidth = v + 'px'; }, onDone: function() { panel.style.overflow = 'visible'; panel.style.transition = ''; } });
  } else {
    panel.querySelector('.agent-feeds-toggle').innerHTML = '&#9664;';
    Spring.animate(panel, 'width', 0, { from: 320, preset: 'stiff', unit: 'px', onUpdate: function(v) { panel.style.minWidth = v + 'px'; }, onDone: function() { panel.classList.remove('active'); panel.classList.add('collapsed'); if (toggleBtn) toggleBtn.style.display = ''; panel.style.transition = ''; } });
  }
}

function updateAgentFeeds(agents) {
  if (!agents || !Array.isArray(agents)) return;
  agentFeedsData = {};
  for (var i = 0; i < agents.length; i++) {
    agentFeedsData[agents[i].id] = agents[i];
  }
  _renderAgentFeedsList();
}

function addAgentFeed(agent) {
  if (!agent || !agent.id) return;
  agentFeedsData[agent.id] = agent;
  if (!agentFeedsOpen) toggleAgentFeeds();
  _renderAgentFeedsList();
}

function updateAgentFeed(agentId, update) {
  var existing = agentFeedsData[agentId];
  if (!existing) {
    agentFeedsData[agentId] = update;
    existing = update;
  } else {
    if (update.status) existing.status = update.status;
    if (update.output) {
      existing.output = (existing.output || '') + update.output;
    }
    if (update.name) existing.name = update.name;
    if (update.role) existing.role = update.role;
  }
  var card = document.getElementById('agent-card-' + agentId);
  if (card) {
    card.className = 'agent-feed-card ' + (existing.status || 'working');
    var outputEl = card.querySelector('.agent-feed-output');
    if (outputEl && existing.output) {
      outputEl.textContent = existing.output;
      outputEl.scrollTop = outputEl.scrollHeight;
    }
    var statusEl = card.querySelector('.agent-feed-status');
    if (statusEl) {
      statusEl.innerHTML = '<span class="agent-status-dot"></span> ' + esc(existing.status || 'working');
    }
  } else {
    _renderAgentFeedsList();
  }
  _updateAgentCount();
}

function removeAgentFeed(agentId) {
  delete agentFeedsData[agentId];
  var card = document.getElementById('agent-card-' + agentId);
  if (card) card.remove();
  _updateAgentCount();
}

function renderAgentCard(agent) {
  var icon = AGENT_ROLE_ICONS[agent.role] || '\uD83E\uDD16';
  var status = agent.status || 'working';
  var output = agent.output || '';
  var isPaused = status === 'paused';
  var safeId = esc(agent.id);
  return '<div id="agent-card-' + safeId + '" class="agent-feed-card ' + status + '">' +
    '<div class="agent-feed-header">' +
      '<span class="agent-feed-icon">' + icon + '</span>' +
      '<span class="agent-feed-name">' + esc(agent.name || agent.id) + '</span>' +
      '<span class="agent-feed-status"><span class="agent-status-dot"></span> ' + esc(status) + '</span>' +
    '</div>' +
    '<div class="agent-feed-output">' + esc(output) + '</div>' +
    '<div class="agent-feed-controls">' +
      (isPaused
        ? '<button class="agent-ctrl-btn" onclick="onAgentResume(\'' + safeId + '\')">Resume</button>'
        : '<button class="agent-ctrl-btn" onclick="onAgentPause(\'' + safeId + '\')">Pause</button>') +
      '<button class="agent-ctrl-btn" onclick="onAgentRedirect(\'' + safeId + '\')">Redirect</button>' +
      '<button class="agent-ctrl-btn cancel" onclick="onAgentCancel(\'' + safeId + '\')">Cancel</button>' +
    '</div>' +
    '<input class="agent-redirect-input" id="agent-redirect-' + safeId + '" placeholder="New instructions..." ' +
      'onkeydown="if(event.key===\'Enter\'){sendAgentRedirect(\'' + safeId + '\',this.value);this.value=\'\';this.classList.remove(\'visible\')}" />' +
  '</div>';
}

function renderAgentCard_inline(agent) {
  var icon = AGENT_ROLE_ICONS[agent.role] || '\uD83E\uDD16';
  var status = agent.status || 'working';
  var progress = agent.progress || '';
  return '<div class="agent-inline-card" onclick="toggleAgentFeeds();var c=document.getElementById(\'agent-card-' + esc(agent.id) + '\');if(c)c.scrollIntoView({behavior:\'smooth\'})">' +
    '<span class="agent-inline-icon">' + icon + '</span>' +
    '<span class="agent-inline-name">' + esc(agent.name || agent.id) + '</span>' +
    '<span class="agent-inline-status">' + esc(status) + '</span>' +
    (progress ? '<span class="agent-inline-progress">' + esc(progress) + '</span>' : '') +
  '</div>';
}

function onAgentRedirect(agentId) {
  var input = document.getElementById('agent-redirect-' + agentId);
  if (!input) return;
  var isVisible = input.classList.contains('visible');
  input.classList.toggle('visible');
  if (!isVisible) input.focus();
}

function sendAgentRedirect(agentId, instruction) {
  if (!instruction || !instruction.trim()) return;
  var payload = { type: 'agent-redirect', agentId: agentId, instruction: instruction.trim() };
  if (chatWs && chatWs.readyState === WebSocket.OPEN) {
    chatWs.send(JSON.stringify(payload));
  } else {
    fetch(API + '/api/agents/' + agentId + '/redirect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AUTH_TOKEN },
      body: JSON.stringify({ instruction: instruction.trim() })
    }).catch(function() {});
  }
}

function onAgentPause(agentId) {
  var payload = { type: 'agent-control', agentId: agentId, action: 'pause' };
  if (chatWs && chatWs.readyState === WebSocket.OPEN) {
    chatWs.send(JSON.stringify(payload));
  }
  updateAgentFeed(agentId, { status: 'waiting' });
}

function onAgentResume(agentId) {
  var payload = { type: 'agent-control', agentId: agentId, action: 'resume' };
  if (chatWs && chatWs.readyState === WebSocket.OPEN) {
    chatWs.send(JSON.stringify(payload));
  }
  updateAgentFeed(agentId, { status: 'working' });
}

function onAgentCancel(agentId) {
  var payload = { type: 'agent-control', agentId: agentId, action: 'cancel' };
  if (chatWs && chatWs.readyState === WebSocket.OPEN) {
    chatWs.send(JSON.stringify(payload));
  }
  updateAgentFeed(agentId, { status: 'done' });
  setTimeout(function() { removeAgentFeed(agentId); }, 1500);
}

function _renderAgentFeedsList() {
  var list = document.getElementById('agent-feeds-list');
  if (!list) return;
  var ids = Object.keys(agentFeedsData);
  if (ids.length === 0) {
    list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted);font-family:var(--mono);font-size:.72rem">No active agents</div>';
  } else {
    list.innerHTML = ids.map(function(id) { return renderAgentCard(agentFeedsData[id]); }).join('');
    // Stagger-animate agent feed cards
    if (typeof Spring !== 'undefined') {
      Spring.staggerIn(Array.from(list.querySelectorAll('.agent-feed-card')), { delay: 50, preset: 'stiff' });
    }
  }
  _updateAgentCount();
}

function _updateAgentCount() {
  var count = Object.keys(agentFeedsData).length;
  var el = document.getElementById('agent-count');
  if (el) el.textContent = count;
  var toggleCount = document.getElementById('agents-toggle-count');
  if (toggleCount) toggleCount.textContent = count;
  // Pulse the button when agents are active
  var toggleBtn = document.getElementById('agents-toggle');
  if (toggleBtn) toggleBtn.style.borderColor = count > 0 ? 'var(--accent)' : 'var(--border)';
}

// Agent feed events are now handled inline in chatWs.onmessage (no monkey-patching)

// Init chat on page load
function init_chat() {
  // Always clear stale streaming state on page load
  streamingSessionId = null;
  const stopBtn = document.getElementById('stop-btn');
  if (stopBtn) stopBtn.style.display = 'none';
  const sendBtn = document.getElementById('send-btn');
  if (sendBtn) sendBtn.disabled = false;
  renderMessages(); initStatusBar(); _renderAgentFeedsList(); loadMissionControl();
}

// ── Mission Control Dashboard (empty chat state) ──
async function loadMissionControl() {
  const mc = document.getElementById('mission-control');
  if (!mc) return;
  try {
    const r = await fetch(`${API}/api/dashboard/stats`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    const s = await r.json();
    const el = id => document.getElementById(id);
    if (el('mc-agents')) el('mc-agents').textContent = s.agents?.hired || 0;
    if (el('mc-tasks')) el('mc-tasks').textContent = (s.issues?.inProgress || 0) + (s.issues?.open || 0);
    if (el('mc-inbox')) el('mc-inbox').textContent = s.inbox || 0;
    if (el('mc-projects')) el('mc-projects').textContent = s.projects || 0;
    // Load hired agents as cards
    const row = document.getElementById('mc-agents-row');
    if (row) {
      const ar = await fetch(`${API}/api/agents/hired`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
      const agents = await ar.json();
      if (Array.isArray(agents) && agents.length > 0) {
        row.innerHTML = agents.map(a => `
          <div class="mc-agent-card" onclick="navigate('agents')">
            <div class="mc-agent-name">${a.icon || ''} ${a.name || a.id}</div>
            <div class="mc-agent-role">${a.role}</div>
            <div class="mc-agent-status">${a.heartbeatEnabled ? 'Heartbeat: ' + (a.heartbeatSchedule || 'on') : 'Manual'}</div>
          </div>
        `).join('');
      } else {
        row.innerHTML = '<div style="color:var(--muted);font-size:.78rem;width:100%;text-align:center">No agents hired yet</div>';
      }
    }
  } catch {}
}

// ═══════════════════════════════════════════════
// Feature 1: Conversation Branching
// ═══════════════════════════════════════════════

async function forkAtMessage(msgIndex) {
  if (!activeChat) return;
  try {
    const res = await apiFetch('/api/sessions/fork', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: activeChat.id, atIndex: msgIndex }),
    });
    const data = await res.json();
    if (data.ok) {
      // Add the forked session to our chat list
      const forkChat = {
        id: data.forkId,
        title: data.title,
        messages: activeChat.messages.slice(0, msgIndex + 1).map(m => ({ role: m.role, content: m.content })),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        forkedFrom: activeChat.id,
        forkAtIndex: msgIndex,
      };
      chats.unshift(forkChat);
      saveChats();
      renderSidebar();
      selectChat(data.forkId);
    }
  } catch (e) {
    console.warn('[fork] Error:', e.message);
  }
}

async function showForkTree() {
  if (!activeChat) return;
  const overlay = document.getElementById('fork-tree-overlay');
  const content = document.getElementById('fork-tree-content');
  if (!overlay || !content) return;
  overlay.style.display = 'flex';
  content.innerHTML = '<div style="color:var(--muted);font-size:.75rem;font-family:var(--mono)">Loading branches...</div>';
  overlay.onclick = (e) => { if (e.target === overlay) closeForkTree(); };

  try {
    const res = await apiFetch(`/api/sessions/forks?sessionId=${encodeURIComponent(activeChat.id)}`);
    const data = await res.json();

    let html = '';
    // Show parent if this is a fork
    if (data.parent) {
      const parentChat = chats.find(c => c.id === data.parent);
      html += `<div class="fork-tree-item" onclick="closeForkTree();selectChat('${esc(data.parent)}')" title="Go to parent">
        <div class="fork-tree-dot" style="background:var(--info)"></div>
        <div class="fork-tree-info">
          <div class="fork-tree-title">${esc(parentChat?.title || data.parent)}</div>
          <div class="fork-tree-meta">PARENT</div>
        </div>
      </div>`;
    }

    // Current session
    html += `<div class="fork-tree-item current">
      <div class="fork-tree-dot"></div>
      <div class="fork-tree-info">
        <div class="fork-tree-title">${esc(activeChat.title)}</div>
        <div class="fork-tree-meta">CURRENT${activeChat.forkedFrom ? ' (branch)' : ''}</div>
      </div>
    </div>`;

    // Child forks
    if (data.forks.length > 0) {
      for (const fork of data.forks) {
        const d = new Date(fork.createdAt).toLocaleDateString();
        html += `<div class="fork-tree-item" onclick="closeForkTree();selectChat('${esc(fork.id)}')" style="margin-left:20px">
          <div class="fork-tree-dot" style="background:var(--warn)"></div>
          <div class="fork-tree-info">
            <div class="fork-tree-title">${esc(fork.title)}</div>
            <div class="fork-tree-meta">Forked at msg #${fork.forkAtIndex} &middot; ${d}</div>
          </div>
        </div>`;
      }
    } else if (!data.parent) {
      html += '<div style="color:var(--muted);font-size:.72rem;font-family:var(--mono);padding:8px 0">No branches yet. Hover a message and click Fork to create one.</div>';
    }

    content.innerHTML = html;
  } catch (e) {
    content.innerHTML = `<div style="color:var(--danger);font-size:.75rem">Error loading branches: ${esc(e.message)}</div>`;
  }
}

// ═══════════════════════════════════════════════
// Feature 2: Auto-Summarize Old Sessions
// ═══════════════════════════════════════════════

async function autoSummarize() {
  const btn = event?.target;
  if (btn) { btn.textContent = 'Working...'; btn.disabled = true; }
  try {
    const res = await apiFetch('/api/sessions/auto-summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const data = await res.json();
    if (btn) {
      btn.textContent = data.summarized > 0 ? `${data.summarized} summarized` : 'Up to date';
      btn.disabled = false;
      setTimeout(() => { btn.textContent = 'Summarize'; }, 3000);
    }
  } catch (e) {
    if (btn) { btn.textContent = 'Error'; btn.disabled = false; setTimeout(() => { btn.textContent = 'Summarize'; }, 2000); }
  }
}

// ═══════════════════════════════════════════════
// Feature 3: Cross-Session Search
// ═══════════════════════════════════════════════

let _gsTimer = null;
function openGlobalSearch() {
  const overlay = document.getElementById('global-search-overlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  // Spring entrance for the search dialog
  var dialog = overlay.querySelector('div');
  if (dialog && typeof Spring !== 'undefined') {
    Spring.fadeIn(dialog, { preset: 'stiff', scale: true, scaleFrom: 0.94 });
  }
  const input = document.getElementById('global-search-input');
  if (input) { input.value = ''; input.focus(); }
  document.getElementById('global-search-results').innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:.78rem">Type to search across all conversations</div>';
  overlay.onclick = (e) => { if (e.target === overlay) closeGlobalSearch(); };
}

function closeGlobalSearch() {
  const overlay = document.getElementById('global-search-overlay');
  if (!overlay) return;
  var dialog = overlay.querySelector('div');
  if (dialog && typeof Spring !== 'undefined') {
    Spring.fadeOut(dialog, { preset: 'stiff', scale: true, scaleTo: 0.94, onDone: function() { overlay.style.display = 'none'; } });
  } else {
    overlay.style.display = 'none';
  }
}

function debounceGlobalSearch(query) {
  if (_gsTimer) clearTimeout(_gsTimer);
  _gsTimer = setTimeout(() => runGlobalSearch(query), 300);
}

async function runGlobalSearch(query) {
  const resultsEl = document.getElementById('global-search-results');
  if (!resultsEl) return;
  if (!query || query.length < 2) {
    resultsEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:.78rem">Type at least 2 characters</div>';
    return;
  }
  resultsEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:.78rem;font-family:var(--mono)">Searching...</div>';

  try {
    const res = await apiFetch(`/api/sessions/search?q=${encodeURIComponent(query)}`);
    const data = await res.json();
    if (!data.results || data.results.length === 0) {
      resultsEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:.78rem">No results found</div>';
      return;
    }

    resultsEl.innerHTML = data.results.map(r => {
      const matchHtml = r.matches.map(m => {
        const highlighted = esc(m.snippet).replace(new RegExp(esc(query), 'gi'), match => `<mark>${match}</mark>`);
        return `<div class="gs-result-match"><span style="color:var(--muted);font-size:.6rem">${m.role}:</span> ${highlighted}</div>`;
      }).join('');
      return `<div class="gs-result" onclick="closeGlobalSearch();selectChat('${esc(r.sessionId)}')">
        <div class="gs-result-title">${esc(r.title)}</div>
        ${matchHtml}
        <div class="gs-result-meta">${r.matches.length} match${r.matches.length > 1 ? 'es' : ''}</div>
      </div>`;
    }).join('');
  } catch (e) {
    resultsEl.innerHTML = `<div style="padding:20px;text-align:center;color:var(--danger);font-size:.78rem">Search error: ${esc(e.message)}</div>`;
  }
}

// Keyboard shortcut: Ctrl+Shift+F for global search
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.key === 'F') {
    e.preventDefault();
    openGlobalSearch();
  }
  if (e.key === 'Escape') {
    closeGlobalSearch();
    closeForkTree();
  }
});

// ═══════════════════════════════════════════════
// Feature 4: Smart Context Indicator
// ═══════════════════════════════════════════════

function updateSmartContextIndicator(contextData) {
  const el = document.getElementById('smart-ctx-indicator');
  if (!el) return;
  if (contextData && contextData.hasSmartContext) {
    el.style.display = 'inline-block';
    el.title = `Smart context: ${contextData.sources || 0} related sessions injected`;
    el.textContent = `CTX +${contextData.sources || 0}`;
  } else {
    el.style.display = 'none';
  }
}

// ═══════════════════════════════════════════════
// Feature 5: Mood/Tone Detection
// ═══════════════════════════════════════════════

async function detectMood(text) {
  const el = document.getElementById('mood-indicator');
  if (!el) return;
  try {
    const res = await apiFetch('/api/mood/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    if (data.mood && data.mood !== 'neutral') {
      el.style.display = 'inline-block';
      el.className = data.mood;
      el.id = 'mood-indicator';
      const icons = { positive: '&#9786;', negative: '&#9785;', urgent: '&#9888;' };
      el.innerHTML = `${icons[data.mood] || ''} ${esc(data.mood)}${data.tone !== 'balanced' ? ' &middot; ' + esc(data.tone) : ''}`;
      el.title = data.styleHint || `Detected mood: ${data.mood}`;
      // Auto-hide after 30 seconds
      setTimeout(() => { el.style.display = 'none'; }, 30000);
    } else {
      el.style.display = 'none';
    }
  } catch {
    el.style.display = 'none';
  }
}
