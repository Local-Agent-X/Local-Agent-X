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

    // ── Agent-triggered settings changes (theme, provider, etc.) ──
    if (msg.type === 'settings_changed' && msg.settings) {
      if (msg.settings.theme && typeof applyTheme === 'function') {
        localStorage.setItem('sax_theme', msg.settings.theme);
        applyTheme(msg.settings.theme);
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
    }

    // ── Sidebar pins changed (agent pinned/unpinned a page) ──
    if (msg.type === 'sidebar_pins_changed' && msg.pins) {
      try {
        _sidebarPins = msg.pins;
        renderSidebarPins();
      } catch(e) { /* app.js not loaded yet — will pick up on next page load */ }
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
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    userScrolledUp = !atBottom;
  });
  el.addEventListener('scroll', () => {
    if (!streamingSessionId) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (atBottom) userScrolledUp = false;
  });
})();

function autoScroll() {
  if (userScrolledUp) return;
  const el = document.getElementById('messages');
  if (el) el.scrollTop = el.scrollHeight;
}

// Throttled stream renderer — batches many deltas into one DOM write per ~50ms.
// Previously every stream token triggered `bodyEl.innerHTML = md(content)` which
// rebuilt the whole message DOM dozens of times per second, causing flicker,
// layout thrash, and scroll jumpiness. With rAF batching, the final DOM state
// is applied at most ~16ms after the latest delta, which feels instant but
// doesn't thrash.
const _streamRenderers = new WeakMap();
function renderStreamContent(bodyEl, content) {
  if (!bodyEl) return;
  let pending = _streamRenderers.get(bodyEl);
  if (!pending) {
    pending = { raf: 0, latest: content };
    _streamRenderers.set(bodyEl, pending);
  }
  pending.latest = content;
  if (pending.raf) return;
  pending.raf = requestAnimationFrame(() => {
    pending.raf = 0;
    const existingCards = bodyEl.querySelectorAll('.tool-card,.approval-card');
    // Strip inline plans — the agent's "Plan: 1) X, 2) Y" bullet is for
    // its own reasoning, not for the user's eyes. We remove it before render
    // so the visible bubble just shows the final answer, not the scratchwork.
    const stripped = stripAgentScratchwork(pending.latest);
    bodyEl.innerHTML = stripped ? md(stripped) : '';
    existingCards.forEach(c => bodyEl.appendChild(c));
  });
}

function stripAgentScratchwork(text) {
  if (!text) return text;
  // Kill lines that look like the model's internal plan or step log.
  // Matches: "Plan: 1) X, 2) Y..." / "I'll: 1) X..." / "Let me: 1) X..."
  // Plus preambles like "Let me first check the local..." when followed by a tool card.
  return text
    .replace(/^Plan\s*:\s*.+?(?=\n\n|$)/gmis, '')
    .replace(/^(I['’]ll|Let me|I will|I'll|I am going to|I'm going to)\s+.+?(?=\n\n|$)/gmi, (match) => {
      // only strip if it reads like a step list (contains "1)" or "first" or "then")
      return /\b(1\)|first|then|next,|step)/i.test(match) ? '' : match;
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
              renderStreamContent(bodyEl, content);
              feedTTS(event.delta);
            }
            break;
          case 'tool_start':
            toolEvents.push({ type: 'start', name: event.toolName, args: event.args, riskLevel: event.riskLevel });
            if (viewing) {
              const existingCards = bodyEl.querySelectorAll('.tool-card');
              bodyEl.innerHTML = content ? md(content) : '';
              existingCards.forEach(c => bodyEl.appendChild(c));
              appendToolCardGrouped(bodyEl, event.toolName, event.args, event.riskLevel, event.context);
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
          case 'tool_progress':
            if (viewing) updateToolProgress(bodyEl, event.toolName, event.message);
            break;
          case 'approval_requested':
            if (viewing) bodyEl.appendChild(makeApprovalCard(event.approvalId, event.toolName, event.context, event.argsPreview));
            break;
          case 'approval_timeout': {
            const card = document.querySelector('.approval-card[data-id="' + event.approvalId + '"]');
            if (card) { card.classList.add('timeout'); card.querySelector('.approval-status').textContent = 'Timed out \u2014 denied.'; card.querySelectorAll('button').forEach(b => b.disabled = true); }
            break;
          }
          case 'context_status': if (viewing) updateContextBar(event); break;
          case 'error':
            if (saveInterval) clearInterval(saveInterval);
            content += '\n\nError: ' + event.message;
            if (viewing) bodyEl.innerHTML = md(content);
            break;
          case 'done': {
            chatWs.removeEventListener('message', wsHandler);
            if (saveInterval) clearInterval(saveInterval);
            // Finalize
            if (streamingSessionId === streamSessionId) streamingSessionId = null;
            try {
              const stopBtn2 = document.getElementById('stop-btn');
              if (stopBtn2) stopBtn2.style.display = 'none';
              document.getElementById('send-btn').disabled = false;
            } catch {}
            userScrolledUp = false;
            const lastMsg = streamChat.messages[streamChat.messages.length - 1];
            // Persist final message — preserve any content that was streamed/saved during the turn.
            // Don't overwrite existing content with empty string (race with savePartial interval).
            if (lastMsg && lastMsg._streaming) {
              if (content && content.length >= (lastMsg.content || '').length) {
                lastMsg.content = content;
              }
              lastMsg.timestamp = Date.now();
              delete lastMsg._streaming;
              streamChat.updatedAt = Date.now(); saveChats(); renderSidebar();
            } else if (content.trim()) {
              streamChat.messages.push({ role: 'assistant', content, timestamp: Date.now() });
              streamChat.updatedAt = Date.now(); saveChats(); renderSidebar();
            }
            // Final DOM sync — flush any pending rAF render so the last chunk
            // of content is visible, but DO NOT call renderMessages() which
            // blows away the entire message list and causes a visible blink.
            // The streaming bodyEl already has the full content from
            // renderStreamContent; we only need to ensure the final frame landed.
            if (isViewingThis()) {
              const pending = _streamRenderers.get(bodyEl);
              if (pending && pending.raf) {
                // rAF is pending — force it to flush now synchronously
                cancelAnimationFrame(pending.raf);
                pending.raf = 0;
                const existingCards = bodyEl.querySelectorAll('.tool-card,.approval-card');
                bodyEl.innerHTML = pending.latest ? md(pending.latest) : '';
                existingCards.forEach(c => bodyEl.appendChild(c));
              } else if (content && bodyEl) {
                // No pending rAF — ensure DOM has latest content (in case last
                // delta arrived on the same tick as 'done')
                const existingCards = bodyEl.querySelectorAll('.tool-card,.approval-card');
                const currentMd = md(content);
                if (bodyEl.innerHTML !== currentMd || existingCards.length > 0) {
                  bodyEl.innerHTML = currentMd;
                  existingCards.forEach(c => bodyEl.appendChild(c));
                }
              }
            }
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
                renderStreamContent(bodyEl, content);
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
                appendToolCardGrouped(bodyEl, event.toolName, event.args, event.riskLevel, event.context);
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
            case 'tool_progress':
              if (viewing) updateToolProgress(bodyEl, event.toolName, event.message);
              break;
            case 'secret_request': if (viewing) showSecretModal(event.name, event.service, event.reason); break;
            case 'approval_requested':
              if (viewing) bodyEl.appendChild(makeApprovalCard(event.approvalId, event.toolName, event.context, event.argsPreview));
              break;
            case 'approval_timeout': {
              const card = document.querySelector('.approval-card[data-id="' + event.approvalId + '"]');
              if (card) { card.classList.add('timeout'); card.querySelector('.approval-status').textContent = 'Timed out — denied.'; card.querySelectorAll('button').forEach(b => b.disabled = true); }
              break;
            }
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
    // Finalize the ORIGINAL chat — preserve streamed content; don't lose visible bubbles
    const lastMsg = streamChat.messages[streamChat.messages.length - 1];
    if (lastMsg && lastMsg._streaming) {
      if (content && content.length >= (lastMsg.content || '').length) {
        lastMsg.content = content;
      }
      lastMsg.timestamp = Date.now();
      delete lastMsg._streaming;
      streamChat.updatedAt = Date.now(); saveChats(); renderSidebar();
    } else if (content.trim()) {
      streamChat.messages.push({ role: 'assistant', content, timestamp: Date.now() });
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
                if (event.type === 'tool_start' && isViewingThis()) { bodyEl.innerHTML = content ? md(content) : ''; appendToolCardGrouped(bodyEl, event.toolName, event.args, event.riskLevel, event.context); }
                if (event.type === 'tool_end' && isViewingThis()) { const cards = bodyEl.querySelectorAll('.tool-card'); const last = cards[cards.length-1]; if(last){last.querySelector('.indicator').className='indicator '+(event.allowed?'allowed':'blocked');} }
                if (event.type === 'tool_progress' && isViewingThis()) { updateToolProgress(bodyEl, event.toolName, event.message); }
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

function makeApprovalCard(approvalId, toolName, context, argsPreview) {
  const card = document.createElement('div');
  card.className = 'approval-card';
  card.setAttribute('data-id', approvalId);
  card.innerHTML =
    '<div class="approval-header"><span class="approval-icon">&#9888;</span>'
    + '<div class="approval-title">Approval needed: <b>' + esc(toolName) + '</b></div></div>'
    + '<div class="approval-context">' + esc(context || '') + '</div>'
    + (argsPreview ? '<details class="approval-args"><summary>args</summary><pre>' + esc(argsPreview) + '</pre></details>' : '')
    + '<div class="approval-actions">'
    +   '<button class="btn-approve">Approve</button>'
    +   '<button class="btn-deny">Deny</button>'
    +   '<label class="approval-always"><input type="checkbox" class="always-cb"> Always for this session</label>'
    + '</div>'
    + '<div class="approval-status"></div>';

  const send = (approved) => {
    const always = card.querySelector('.always-cb').checked;
    try {
      if (chatWs && chatWs.readyState === 1) {
        chatWs.send(JSON.stringify({ type: 'approval_response', approvalId, approved, rememberForSession: approved && always }));
      }
    } catch {}
    card.querySelector('.approval-status').textContent = approved ? (always ? 'Approved (remembered for session)' : 'Approved') : 'Denied';
    card.classList.add(approved ? 'approved' : 'denied');
    card.querySelectorAll('button').forEach(b => b.disabled = true);
  };
  card.querySelector('.btn-approve').addEventListener('click', () => send(true));
  card.querySelector('.btn-deny').addEventListener('click', () => send(false));
  return card;
}

function makeToolCard(name, args, riskLevel, context) {
  const card = document.createElement('div'); card.className = 'tool-card'; card.setAttribute('data-tool-name', name);
  card.setAttribute('data-call-count', '1');
  card.innerHTML = `<div class="tool-header" onclick="this.parentElement.classList.toggle('open')"><span class="indicator"></span><span class="tool-name">${esc(name)}</span><span class="tool-count" style="color:var(--muted);font-size:.7rem;margin-right:.3rem"></span><span class="tool-summary" style="color:var(--muted);font-size:.72rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${esc(toolSummary(name, args))}</span><span style="color:var(--muted);font-size:.65rem">&#9654;</span></div>`
    + `<div class="tool-detail">executing...</div>`;
  return card;
}

/**
 * Append a tool card — but if the most-recent tool-card in the container has
 * the same tool name, roll this call into that card as another sub-entry
 * instead of creating a new top-level block. Consecutive same-tool calls
 * within one assistant response always group; the UI for each container
 * starts fresh when a new assistant response begins.
 */
function appendToolCardGrouped(container, name, args, riskLevel, context) {
  const cards = container.querySelectorAll('.tool-card');
  const last = cards[cards.length - 1];
  if (last && last.getAttribute('data-tool-name') === name) {
    const count = parseInt(last.getAttribute('data-call-count') || '1', 10) + 1;
    last.setAttribute('data-call-count', String(count));
    const countEl = last.querySelector('.tool-count');
    if (countEl) countEl.textContent = '×' + count;
    const summary = last.querySelector('.tool-summary');
    if (summary) summary.textContent = toolSummary(name, args);
    const detail = last.querySelector('.tool-detail');
    if (detail) {
      const sub = document.createElement('div');
      sub.style.cssText = 'font-size:.72rem;color:var(--muted);padding:.2rem 0;border-top:1px solid var(--border,#333);margin-top:.2rem';
      sub.textContent = '#' + count + ' ' + toolSummary(name, args);
      detail.appendChild(sub);
    }
    return last;
  }
  const card = makeToolCard(name, args, riskLevel, context);
  container.appendChild(card);
  return card;
}

function updateToolProgress(container, toolName, message) {
  // Find the last tool card matching this tool name
  const cards = container.querySelectorAll('.tool-card[data-tool-name="' + toolName + '"]');
  let card = cards.length > 0 ? cards[cards.length - 1] : null;
  // Fallback: last tool card regardless of name
  if (!card) { const all = container.querySelectorAll('.tool-card'); card = all.length > 0 ? all[all.length - 1] : null; }
  if (!card) return;

  // Parse message format: "45%|237/1102 conversations, 500 chunks|conversations-003.json"
  const parts = message.split('|');
  const pctStr = parts[0] || '';
  const detail = parts[1] || message;
  const file = parts[2] || '';
  const pct = parseInt(pctStr) || 0;

  // Update summary text in header
  const summary = card.querySelector('.tool-summary');
  if (summary) summary.textContent = detail;

  // Create or update progress bar in detail area
  let bar = card.querySelector('.tool-progress-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'tool-progress-bar';
    bar.innerHTML = '<div class="tool-progress-fill"></div><span class="tool-progress-label"></span>';
    const detailEl = card.querySelector('.tool-detail');
    if (detailEl) { detailEl.textContent = ''; detailEl.appendChild(bar); }
    // Auto-open the card to show progress
    card.classList.add('open');
  }
  const fill = bar.querySelector('.tool-progress-fill');
  const label = bar.querySelector('.tool-progress-label');
  if (fill) fill.style.width = pct + '%';
  if (label) label.textContent = pct + '% — ' + detail + (file ? ' (' + file + ')' : '');
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

// ── Voice v3: streaming WS to local /ws/voice ──
// Mic frames stream in to the server-side voice session (Python GPU sidecar
// when LAX_VOICE_GPU=1, else in-process Sherpa fallback). Server-side VAD,
// STT, LLM (via voice-llm.ts), and TTS — browser is just transport + UI.
// Replaces the old MediaRecorder + /api/voice/transcribe + /api/voice/synthesize
// REST flow which was slow, blocky, and left the user waiting through full
// utterance buffering before any result.

let voiceMode = false;
let voiceWS = null;
let voiceCtx = null;          // AudioContext (default native rate)
let voiceMicNode = null;
let voicePlaybackNode = null;
let voiceMicStream = null;
let voiceCurrentMsgEl = null;  // assistant chat bubble being built
let voiceCurrentMsgBody = null;
let voiceCurrentMsgText = '';

async function toggleMic() {
  if (voiceMode) { stopVoiceMode(); }
  else { await startVoiceMode(); }
}

async function startVoiceMode() {
  if (voiceMode) return;
  try {
    // 1) Connect to /ws/voice with auth token
    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/voice?token=${encodeURIComponent(AUTH_TOKEN)}`;
    voiceWS = new WebSocket(wsUrl);
    voiceWS.binaryType = 'arraybuffer';

    await new Promise((resolve, reject) => {
      voiceWS.onopen = () => resolve();
      voiceWS.onerror = () => reject(new Error('voice ws error'));
      voiceWS.onclose = (e) => {
        if (voiceWS.readyState !== WebSocket.OPEN) reject(new Error(`voice ws closed before open (code ${e.code})`));
      };
    });

    // Attach handlers BEFORE hello so server-side ready/init events aren't lost
    voiceWS.onmessage = handleVoiceWsMessage;
    voiceWS.onclose = () => { console.log('[voice] ws closed'); cleanupVoiceResources(); };

    // 2) Send hello + saved voice/speed settings
    const sid = (typeof activeChat !== 'undefined' && activeChat?.id) ? activeChat.id : 'default';
    voiceWS.send(JSON.stringify({ type: 'hello', sessionId: 'chat-' + sid + '-' + Date.now() }));
    const savedVoice = localStorage.getItem('lax_voice') || 'am_michael';
    const savedSpeed = parseFloat(localStorage.getItem('lax_speed') || '1.15');
    voiceWS.send(JSON.stringify({ type: 'voice_settings', voice: savedVoice, speed: savedSpeed }));

    // 3) AudioContext + worklets
    voiceCtx = new AudioContext();
    await voiceCtx.audioWorklet.addModule('/js/voice/mic-capture-worklet.js');
    await voiceCtx.audioWorklet.addModule('/js/voice/playback-worklet.js');

    // 4) Mic capture
    voiceMicStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    const source = voiceCtx.createMediaStreamSource(voiceMicStream);
    voiceMicNode = new AudioWorkletNode(voiceCtx, 'mic-capture');
    voiceMicNode.port.onmessage = (e) => {
      if (!e.data || e.data.type !== 'pcm') return;
      if (voiceWS && voiceWS.readyState === WebSocket.OPEN) voiceWS.send(e.data.pcm);
    };
    source.connect(voiceMicNode);
    voiceMicNode.port.postMessage({ cmd: 'start' });

    // 5) Playback
    voicePlaybackNode = new AudioWorkletNode(voiceCtx, 'pcm-playback');
    voicePlaybackNode.connect(voiceCtx.destination);

    voiceMode = true;
    voiceEnabled = true;
    const ttsBtn = document.getElementById('tts-toggle');
    if (ttsBtn) { ttsBtn.textContent = 'VOICE ON'; ttsBtn.className = 'active'; }
    updateVoiceUI();
    console.log('[voice] session started');
  } catch (e) {
    console.error('[voice] start failed:', e);
    cleanupVoiceResources();
    alert('Voice mode failed. Check microphone permissions.\n' + e.message);
  }
}

function stopVoiceMode() {
  if (!voiceMode) return;
  try { voiceWS && voiceWS.send(JSON.stringify({ type: 'bye' })); } catch {}
  try { voiceWS && voiceWS.close(); } catch {}
  cleanupVoiceResources();
  console.log('[voice] session stopped');
}

function cleanupVoiceResources() {
  voiceMode = false; voiceEnabled = false; isListening = false; isSpeaking = false;
  try { voiceMicStream && voiceMicStream.getTracks().forEach(t => t.stop()); } catch {}
  try { voiceCtx && voiceCtx.close(); } catch {}
  voiceWS = null; voiceCtx = null; voiceMicNode = null; voicePlaybackNode = null; voiceMicStream = null;
  voiceCurrentMsgEl = null; voiceCurrentMsgBody = null; voiceCurrentMsgText = '';
  const ttsBtn = document.getElementById('tts-toggle');
  if (ttsBtn) { ttsBtn.textContent = 'VOICE OFF'; ttsBtn.className = ''; }
  updateVoiceUI();
}

function handleVoiceWsMessage(e) {
  // Binary frames are TTS PCM — pipe to playback worklet
  if (typeof e.data !== 'string') {
    if (voicePlaybackNode) voicePlaybackNode.port.postMessage({ cmd: 'pcm', pcm: e.data });
    return;
  }
  let msg;
  try { msg = JSON.parse(e.data); } catch { return; }

  switch (msg.type) {
    case 'voice_ready':
      if (voicePlaybackNode && msg.ttsSampleRate) {
        voicePlaybackNode.port.postMessage({ cmd: 'setRate', rate: msg.ttsSampleRate });
      }
      break;
    case 'vad_speech_start': isListening = true; updateVoiceUI(); break;
    case 'vad_speech_end':   isListening = false; updateVoiceUI(); break;
    case 'final': {
      if (!msg.text) break;
      const empty = document.getElementById('empty');
      if (empty) empty.remove();
      if (typeof addMessageEl === 'function') addMessageEl('user', msg.text);
      if (typeof activeChat !== 'undefined' && activeChat) {
        activeChat.messages.push({ role: 'user', content: msg.text });
        activeChat.updatedAt = Date.now();
      }
      break;
    }
    case 'agent_start': {
      if (typeof addMessageEl === 'function') {
        voiceCurrentMsgEl = addMessageEl('assistant', '');
        voiceCurrentMsgBody = voiceCurrentMsgEl?.querySelector('.msg-body');
        if (voiceCurrentMsgBody) voiceCurrentMsgBody.innerHTML = '<div class="thinking"><span>.</span><span>.</span><span>.</span></div>';
      }
      voiceCurrentMsgText = '';
      isSpeaking = true; updateVoiceUI();
      break;
    }
    case 'assistant_delta':
      if (!voiceCurrentMsgBody) break;
      voiceCurrentMsgText += msg.text || '';
      voiceCurrentMsgBody.innerHTML = (typeof md === 'function' ? md(voiceCurrentMsgText) : voiceCurrentMsgText);
      const msgs = document.getElementById('messages');
      if (msgs) msgs.scrollTop = msgs.scrollHeight;
      break;
    case 'assistant_done':
    case 'assistant_interrupted':
      if (voiceCurrentMsgText.trim() && typeof activeChat !== 'undefined' && activeChat) {
        activeChat.messages.push({ role: 'assistant', content: voiceCurrentMsgText });
        activeChat.updatedAt = Date.now();
        if (typeof saveChats === 'function') saveChats();
        if (typeof renderSidebar === 'function') renderSidebar();
      }
      voiceCurrentMsgEl = null; voiceCurrentMsgBody = null; voiceCurrentMsgText = '';
      break;
    case 'tts_interrupt':
      if (voicePlaybackNode) voicePlaybackNode.port.postMessage({ cmd: 'flush' });
      break;
    case 'playback_complete':
    case 'tts_idle':
      isSpeaking = false; updateVoiceUI();
      break;
    case 'voice_error':
    case 'agent_error':
    case 'stt_error':
    case 'tts_error':
      console.warn('[voice]', msg.type, msg.message);
      break;
  }
}

// Vestigial helpers preserved so the text-chat send path still compiles —
// the OLD voice system spoke chat replies sentence-by-sentence; that path
// is replaced by /ws/voice. These shims keep typed-chat sends harmless.
function feedTTS(_delta) { /* no-op */ }
function flushTTS() { /* no-op */ }
function stopSpeaking() {
  if (voicePlaybackNode) voicePlaybackNode.port.postMessage({ cmd: 'flush' });
  isSpeaking = false; updateVoiceUI();
}
function toggleTTS() { toggleMic(); }
function fetchTTSAudio() { return null; } // shim

function updateVoiceUI(state) {
  const mic = document.getElementById('mic-btn'), ind = document.getElementById('voice-indicator');
  if (!mic) return;
  if (state === 'transcribing') {
    mic.className = 'input-btn listening';
    if (ind) { ind.className = 'listening'; ind.textContent = '⚡ TRANSCRIBING...'; }
    return;
  }
  if (voiceMode) {
    mic.className = 'input-btn' + (isListening ? ' listening' : (isSpeaking ? ' speaking' : ' listening'));
    mic.title = 'Voice mode ON — click to stop';
    if (ind) {
      if (isListening) { ind.className = 'listening'; ind.textContent = '🎙 LISTENING'; }
      else if (isSpeaking) { ind.className = 'speaking'; ind.textContent = '🔊 SPEAKING'; }
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
  // Pro tier detection: only fetch the cloned-voice library if the RVC
  // sidecar is up. Re-renders the picker once we know.
  refreshClonedVoices();
}

async function refreshClonedVoices() {
  try {
    const tierRes = await apiFetch('/api/voices/tier');
    const tier = await tierRes.json();
    window._proTierReady = tier.tier === 'pro' && !!tier.ready;
    if (!window._proTierReady) {
      window._cloneVoices = [];
      return;
    }
    const r = await apiFetch('/api/voices/clones');
    if (!r.ok) return;
    const data = await r.json();
    window._cloneVoices = Array.isArray(data?.clones) ? data.clones : [];
    if (typeof updateStatusBar === 'function') updateStatusBar();
  } catch (e) {
    console.warn('[voice] tier/clones probe failed:', e.message);
  }
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

// Mirrors server-side classifyModel() in src/model-tiers.ts. Keep in sync.
function classifyModelTier(model) {
  const m = String(model || '').toLowerCase();
  if (/:([1-9]b|1[0-3]b)(\b|-|$)/.test(m)) return 'weak';
  if (/\bqwen2?:7b\b/.test(m)) return 'weak';
  if (/^grok-3-mini$/.test(m)) return 'weak';
  if (/gpt-4o-mini|gpt-3\.5/.test(m)) return 'weak';
  if (/gemini-(1|2\.0)-flash/.test(m)) return 'weak';
  if (/haiku(?!-4-5)/.test(m)) return 'weak';
  if (/gpt-5(\.\d+)?($|-(?!mini))/.test(m)) return 'strong';
  if (/claude-opus-4|claude-sonnet-4-[6-9]|claude-haiku-4-5/.test(m)) return 'strong';
  if (/^o[34]($|-|\.)/.test(m)) return 'strong';
  if (/gemini-(2\.5|3)/.test(m)) return 'strong';
  // grok-4 intentionally medium — thinner tool-use RLHF than OpenAI/Anthropic
  return 'medium';
}

function updateStatusBar() {
  const bar = document.getElementById('status-bar-dynamic');
  if (!bar) return;
  const tokenInfo = window.lastContextStatus ? `${(window.lastContextStatus.usedTokens / 1000).toFixed(0)}K tokens` : '';
  const data = _providersCache;
  const currentProvider = data?.current?.provider || '—';
  const currentModel = data?.current?.model || '—';
  const providers = data?.providers || [];
  const activeP = providers.find(p => p.active) || providers[0];

  // Build provider dropdown options
  const providerOpts = providers.map(p =>
    `<option value="${esc(p.id)}" ${p.active ? 'selected' : ''}>${esc(p.name)}</option>`
  ).join('');

  // Build model dropdown for active provider. Flag each option's tier so
  // weak models are obvious at selection time ("qwen2:7b · weak").
  const modelOpts = activeP ? activeP.models.map(m => {
    const tier = classifyModelTier(m);
    const tag = tier === 'weak' ? ' · weak' : tier === 'medium' ? ' · medium' : '';
    return `<option value="${esc(m)}" ${m === currentModel ? 'selected' : ''}>${esc(m)}${tag}</option>`;
  }).join('') : `<option value="${esc(currentModel)}">${esc(currentModel)}</option>`;

  // Active-model badge: warn when selection is weak.
  const tier = classifyModelTier(currentModel);
  const tierBadge = tier === 'weak'
    ? `<span class="status-item" style="background:#fef3c7;color:#92400e;border:1px solid #fbbf24;padding:2px 8px;border-radius:10px" title="This model may fail on agent tasks (tool calling, multi-step workflows). Switch to a stronger model for complex work.">&#9888; weak model — chat-only recommended</span>`
    : tier === 'medium'
    ? `<span class="status-item" style="opacity:.7" title="Medium-tier model. Agent tasks work but may be less reliable than flagship models.">&#9888; medium</span>`
    : '';

  // Voice picker + speed slider. Selection persists to localStorage and
  // is pushed to the server-side voice session over /ws/voice the moment
  // it changes (or on next session start). Lite tier: built-in Kokoro
  // voices only. Custom voice cloning is the Pro tier (RVC) — not in
  // this build.
  const savedVoice = localStorage.getItem('lax_voice') || 'am_michael';
  const savedSpeed = parseFloat(localStorage.getItem('lax_speed') || '1.15');
  const voiceGroups = [
    ['American Male', ['am_michael','am_adam','am_echo','am_eric','am_fenrir','am_liam','am_onyx','am_puck']],
    ['American Female', ['af_nicole','af_bella','af_sarah','af_sky','af_heart','af_nova','af_river','af_alloy']],
    ['British Male', ['bm_george','bm_daniel','bm_fable','bm_lewis']],
    ['British Female', ['bf_emma','bf_alice','bf_isabella','bf_lily']],
  ];
  const voiceLabel = (id) => id.split('_')[1].replace(/\b\w/g, c => c.toUpperCase());
  // Cloned voices are only available if the Pro tier RVC sidecar is up.
  // refreshClonedVoices() populates window._cloneVoices async on init; we
  // re-render the bar once they land.
  const clones = Array.isArray(window._cloneVoices) ? window._cloneVoices : [];
  const cloneIds = clones.map(c => 'clone:' + c.id);
  // If the saved voice references a clone that no longer exists, fall back.
  const effectiveVoice = (savedVoice.startsWith('clone:') && !cloneIds.includes(savedVoice))
    ? 'am_michael'
    : savedVoice;
  if (effectiveVoice !== savedVoice) localStorage.setItem('lax_voice', effectiveVoice);
  let voiceOpts = voiceGroups.map(([group, ids]) =>
    `<optgroup label="${esc(group)}">` +
    ids.map(id => `<option value="${esc(id)}" ${id === effectiveVoice ? 'selected' : ''}>${esc(voiceLabel(id))}</option>`).join('') +
    `</optgroup>`
  ).join('');
  if (clones.length > 0) {
    voiceOpts += `<optgroup label="My Cloned Voices (RVC)">` +
      clones.map(c => `<option value="clone:${esc(c.id)}" ${('clone:' + c.id) === effectiveVoice ? 'selected' : ''}>${esc(c.name)}</option>`).join('') +
      `</optgroup>`;
  }
  // Pro tier management: only show if /api/voices/tier returned ready.
  if (window._proTierReady) {
    voiceOpts += `<optgroup label=" "><option value="__add_clone__">+ Add a cloned voice…</option>`;
    if (clones.length > 0) {
      voiceOpts += `<option value="__manage_clones__">&#9881; Manage cloned voices…</option>`;
    }
    voiceOpts += `</optgroup>`;
  }

  bar.innerHTML = `
    <select id="provider-quick-select" class="status-select" onchange="quickSwitchProvider(this.value)" title="Switch provider">${providerOpts}</select>
    <span style="color:var(--border)">&#9654;</span>
    <select id="model-quick-select" class="status-select" onchange="quickSwitchModel(this.value)" title="Switch model">${modelOpts}</select>
    <span style="color:var(--border)">|</span>
    <select id="voice-quick-select" class="status-select" onchange="quickSwitchVoice(this.value)" title="Voice for spoken replies">${voiceOpts}</select>
    <input id="voice-speed-slider" type="range" min="0.7" max="1.5" step="0.05" value="${savedSpeed}" onchange="quickSwitchSpeed(this.value)" oninput="document.getElementById('voice-speed-label').textContent = parseFloat(this.value).toFixed(2)+'x'" title="Speech speed" style="width:80px;vertical-align:middle"/>
    <span id="voice-speed-label" class="status-item" style="font-family:var(--mono);min-width:42px">${savedSpeed.toFixed(2)}x</span>
    ${tierBadge}
    ${tokenInfo ? `<span class="status-item"><span class="status-icon">&#9998;</span> ${tokenInfo}</span>` : ''}
    <span class="status-item" title="All data stays on your machine. API calls go to your selected provider." style="cursor:help"><span class="status-icon">&#128274;</span> Local</span>
  `;
}

function quickSwitchVoice(voice) {
  if (voice === '__add_clone__' || voice === '__manage_clones__') {
    if (voice === '__add_clone__') openAddCloneModal();
    else openManageClonesModal();
    // Reset picker visual to whatever was actually selected before
    const sel = document.getElementById('voice-quick-select');
    if (sel) sel.value = localStorage.getItem('lax_voice') || 'am_michael';
    return;
  }
  localStorage.setItem('lax_voice', voice);
  const wsState = (typeof voiceWS !== 'undefined' && voiceWS) ? voiceWS.readyState : 'no-ws';
  console.log('[voice] picker → ' + voice + ' (ws=' + wsState + ')');
  if (typeof voiceWS !== 'undefined' && voiceWS && voiceWS.readyState === WebSocket.OPEN) {
    const speed = parseFloat(localStorage.getItem('lax_speed') || '1.15');
    voiceWS.send(JSON.stringify({ type: 'voice_settings', voice, speed }));
    showVoiceToast('Voice → ' + voice + ' (next reply)');
  } else {
    showVoiceToast('Voice → ' + voice + ' (saved; takes effect when mic is on)');
  }
}

function openAddCloneModal() {
  const existing = document.getElementById('add-clone-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'add-clone-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:center;justify-content:center';
  modal.innerHTML = `
    <div style="background:var(--bg, #fff);color:var(--text, #000);border:1px solid var(--border, #ccc);border-radius:10px;padding:24px;max-width:520px;width:92%">
      <h3 style="margin:0 0 6px;font-size:1.1rem">Add a cloned voice (RVC)</h3>
      <p style="margin:0 0 16px;color:var(--muted, #666);font-size:.83rem">Two ways to add a voice. Both go to the local RVC sidecar — nothing leaves this machine.</p>

      <div style="border:1px solid var(--border, #ddd);border-radius:8px;padding:14px;margin-bottom:14px">
        <h4 style="margin:0 0 6px;font-size:.92rem">From a HuggingFace URL</h4>
        <p style="margin:0 0 10px;color:var(--muted, #666);font-size:.78rem">Paste a direct .zip download URL (e.g. <code>https://huggingface.co/&lt;user&gt;/&lt;repo&gt;/resolve/main/Voice.zip</code>).</p>
        <div style="display:flex;gap:8px;margin-bottom:8px">
          <input id="ac-url-name" type="text" placeholder="Voice name" style="width:140px;padding:7px 9px;border:1px solid var(--border, #ccc);border-radius:6px;font-size:.85rem"/>
          <input id="ac-url" type="text" placeholder="HF .zip URL" style="flex:1;padding:7px 9px;border:1px solid var(--border, #ccc);border-radius:6px;font-size:.85rem"/>
        </div>
        <button id="ac-url-go" type="button" style="padding:7px 14px;border:none;background:#3498db;color:#fff;border-radius:6px;cursor:pointer;font-size:.83rem">Download &amp; install</button>
      </div>

      <div style="border:1px solid var(--border, #ddd);border-radius:8px;padding:14px;margin-bottom:14px">
        <h4 style="margin:0 0 6px;font-size:.92rem">Upload a .zip / .pth file</h4>
        <p style="margin:0 0 10px;color:var(--muted, #666);font-size:.78rem">Zip should contain a <code>.pth</code> (model) and optional <code>.index</code> (better quality). Or upload a single <code>.pth</code> directly.</p>
        <div style="display:flex;gap:8px;margin-bottom:8px;align-items:center">
          <input id="ac-file-name" type="text" placeholder="Voice name" style="width:140px;padding:7px 9px;border:1px solid var(--border, #ccc);border-radius:6px;font-size:.85rem"/>
          <input id="ac-file" type="file" accept=".zip,.pth" style="flex:1;font-size:.8rem"/>
        </div>
        <button id="ac-file-go" type="button" style="padding:7px 14px;border:none;background:#3498db;color:#fff;border-radius:6px;cursor:pointer;font-size:.83rem">Upload &amp; install</button>
      </div>

      <div id="ac-status" style="font-size:.8rem;color:var(--muted, #666);margin-bottom:12px;min-height:1em"></div>
      <div style="display:flex;justify-content:flex-end">
        <button id="ac-close" type="button" style="padding:8px 14px;border:1px solid var(--border, #ccc);background:transparent;color:var(--text, #000);border-radius:6px;cursor:pointer">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  document.getElementById('ac-close').onclick = () => modal.remove();

  const status = document.getElementById('ac-status');
  const setStatus = (msg, isError) => {
    status.textContent = msg;
    status.style.color = isError ? '#c0392b' : 'var(--muted, #666)';
  };

  document.getElementById('ac-url-go').onclick = async () => {
    const name = (document.getElementById('ac-url-name').value || '').trim();
    const url = (document.getElementById('ac-url').value || '').trim();
    if (!name || !url) { setStatus('Name and URL required.', true); return; }
    setStatus('Downloading + installing… (~10-60s)', false);
    try {
      const r = await apiFetch('/api/voices/clones/from-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, url }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { setStatus('Failed: ' + (data.error || data.detail || ('HTTP ' + r.status)), true); return; }
      setStatus(`Installed "${data.name}".`, false);
      await refreshClonedVoices();
      setTimeout(() => modal.remove(), 800);
    } catch (e) { setStatus('Failed: ' + e.message, true); }
  };

  document.getElementById('ac-file-go').onclick = async () => {
    const name = (document.getElementById('ac-file-name').value || '').trim();
    const file = document.getElementById('ac-file').files[0];
    if (!name || !file) { setStatus('Name and file required.', true); return; }
    if (file.size > 200 * 1024 * 1024) { setStatus('File too big (>200MB).', true); return; }
    setStatus('Reading file…', false);
    try {
      const buf = await file.arrayBuffer();
      // If the user picked a single .pth, wrap it into a zip on the fly so
      // the sidecar's upload handler (which expects a zip) is the only
      // server-side code path.
      let zipBuf;
      if (file.name.toLowerCase().endsWith('.pth')) {
        zipBuf = await pthToZip(file.name, buf);
      } else {
        zipBuf = buf;
      }
      const bytes = new Uint8Array(zipBuf);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
      }
      const b64 = btoa(binary);
      setStatus('Installing…', false);
      const r = await apiFetch('/api/voices/clones', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, files_b64: b64 }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { setStatus('Failed: ' + (data.error || data.detail || ('HTTP ' + r.status)), true); return; }
      setStatus(`Installed "${data.name}".`, false);
      await refreshClonedVoices();
      setTimeout(() => modal.remove(), 800);
    } catch (e) { setStatus('Failed: ' + e.message, true); }
  };
}

// Minimal in-browser zip writer for the single-.pth upload case. Only
// handles one stored (uncompressed) entry — fine for an RVC .pth which
// is already compressed binary; deflating it again wins almost nothing.
async function pthToZip(filename, fileBuf) {
  const data = new Uint8Array(fileBuf);
  // CRC-32 (slow per-byte, but only runs once on a ~50MB file)
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ data[i]) & 0xFF];
  crc = (crc ^ 0xFFFFFFFF) >>> 0;

  const nameBytes = new TextEncoder().encode(filename);
  const localHeader = new ArrayBuffer(30 + nameBytes.length);
  const lh = new DataView(localHeader);
  lh.setUint32(0, 0x04034b50, true);  // local file header sig
  lh.setUint16(4, 20, true);          // version needed
  lh.setUint16(6, 0, true);           // flags
  lh.setUint16(8, 0, true);           // method: stored
  lh.setUint16(10, 0, true); lh.setUint16(12, 0, true);  // mod time/date (0)
  lh.setUint32(14, crc, true);
  lh.setUint32(18, data.length, true);
  lh.setUint32(22, data.length, true);
  lh.setUint16(26, nameBytes.length, true);
  lh.setUint16(28, 0, true);          // extra
  new Uint8Array(localHeader, 30).set(nameBytes);

  const centralDir = new ArrayBuffer(46 + nameBytes.length);
  const cd = new DataView(centralDir);
  cd.setUint32(0, 0x02014b50, true);
  cd.setUint16(4, 20, true); cd.setUint16(6, 20, true);
  cd.setUint16(8, 0, true); cd.setUint16(10, 0, true);
  cd.setUint16(12, 0, true); cd.setUint16(14, 0, true);
  cd.setUint32(16, crc, true);
  cd.setUint32(20, data.length, true);
  cd.setUint32(24, data.length, true);
  cd.setUint16(28, nameBytes.length, true);
  cd.setUint16(30, 0, true); cd.setUint16(32, 0, true);
  cd.setUint16(34, 0, true); cd.setUint16(36, 0, true);
  cd.setUint32(38, 0, true); cd.setUint32(42, 0, true);  // local header offset = 0
  new Uint8Array(centralDir, 46).set(nameBytes);

  const eocd = new ArrayBuffer(22);
  const ed = new DataView(eocd);
  ed.setUint32(0, 0x06054b50, true);
  ed.setUint16(4, 0, true); ed.setUint16(6, 0, true);
  ed.setUint16(8, 1, true); ed.setUint16(10, 1, true);
  ed.setUint32(12, centralDir.byteLength, true);
  ed.setUint32(16, localHeader.byteLength + data.length, true);
  ed.setUint16(20, 0, true);

  const total = localHeader.byteLength + data.length + centralDir.byteLength + eocd.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  out.set(new Uint8Array(localHeader), off); off += localHeader.byteLength;
  out.set(data, off); off += data.length;
  out.set(new Uint8Array(centralDir), off); off += centralDir.byteLength;
  out.set(new Uint8Array(eocd), off);
  return out.buffer;
}

function openManageClonesModal() {
  const existing = document.getElementById('manage-clones-modal');
  if (existing) existing.remove();

  const clones = Array.isArray(window._cloneVoices) ? window._cloneVoices : [];
  const rows = clones.length === 0
    ? `<div style="padding:16px;color:var(--muted, #666);font-size:.85rem;text-align:center">No cloned voices installed.</div>`
    : clones.map(c => `
        <div class="mc-row" data-id="${esc(c.id)}" style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid var(--border, #eee)">
          <span style="flex:1;font-family:var(--mono);font-size:.85rem">${esc(c.name)}</span>
          <button class="mc-delete" type="button" style="padding:6px 12px;border:none;background:#e74c3c;color:#fff;border-radius:6px;cursor:pointer;font-size:.8rem">Delete</button>
        </div>`).join('');

  const modal = document.createElement('div');
  modal.id = 'manage-clones-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:center;justify-content:center';
  modal.innerHTML = `
    <div style="background:var(--bg, #fff);color:var(--text, #000);border:1px solid var(--border, #ccc);border-radius:10px;padding:0;max-width:480px;width:92%;max-height:80vh;display:flex;flex-direction:column">
      <div style="padding:14px 18px;border-bottom:1px solid var(--border, #eee)">
        <h3 style="margin:0;font-size:1.05rem">Manage cloned voices</h3>
        <p style="margin:4px 0 0;color:var(--muted, #666);font-size:.78rem">Removes the voice's model files from disk.</p>
      </div>
      <div id="mc-rows" style="overflow:auto;flex:1">${rows}</div>
      <div id="mc-status" style="padding:0 18px;font-size:.78rem;color:var(--muted, #666);min-height:1em"></div>
      <div style="padding:12px 18px;border-top:1px solid var(--border, #eee);display:flex;justify-content:flex-end">
        <button id="mc-close" type="button" style="padding:8px 14px;border:1px solid var(--border, #ccc);background:transparent;color:var(--text, #000);border-radius:6px;cursor:pointer">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  document.getElementById('mc-close').onclick = () => modal.remove();
  const statusEl = document.getElementById('mc-status');

  modal.querySelectorAll('.mc-delete').forEach(btn => {
    btn.onclick = async () => {
      const row = btn.closest('.mc-row');
      const id = row.dataset.id;
      if (!confirm(`Delete "${id}"? Removes the .pth + .index from disk.`)) return;
      btn.disabled = true; statusEl.textContent = 'Deleting…'; statusEl.style.color = 'var(--muted, #666)';
      try {
        const r = await apiFetch('/api/voices/clones/' + encodeURIComponent(id), { method: 'DELETE' });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) { statusEl.textContent = 'Failed: ' + (data.error || ('HTTP ' + r.status)); statusEl.style.color = '#c0392b'; btn.disabled = false; return; }
        row.remove();
        if (localStorage.getItem('lax_voice') === ('clone:' + id)) {
          localStorage.setItem('lax_voice', 'am_michael');
        }
        await refreshClonedVoices();
        statusEl.textContent = `Deleted "${id}".`;
      } catch (e) {
        statusEl.textContent = 'Failed: ' + e.message; statusEl.style.color = '#c0392b';
        btn.disabled = false;
      }
    };
  });
}

function showVoiceToast(msg) {
  let el = document.getElementById('voice-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'voice-toast';
    el.style.cssText = 'position:fixed;bottom:80px;right:20px;padding:8px 14px;background:#2c3e50;color:#fff;font-size:.82rem;border-radius:6px;z-index:9998;box-shadow:0 4px 12px rgba(0,0,0,.2);transition:opacity .25s';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(window._voiceToastT);
  window._voiceToastT = setTimeout(() => { el.style.opacity = '0'; }, 2200);
}


function quickSwitchSpeed(speed) {
  const s = parseFloat(speed);
  localStorage.setItem('lax_speed', String(s));
  if (typeof voiceWS !== 'undefined' && voiceWS && voiceWS.readyState === WebSocket.OPEN) {
    const voice = localStorage.getItem('lax_voice') || 'am_michael';
    voiceWS.send(JSON.stringify({ type: 'voice_settings', voice, speed: s }));
  }
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
  renderMessages(); initStatusBar(); _renderAgentFeedsList();
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
