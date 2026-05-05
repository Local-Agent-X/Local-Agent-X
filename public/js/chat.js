// ── Chat Panel ──
let streamingSessionId = null; // Track WHICH session is streaming, not global boolean
let pendingUploads = [];
let userScrolledUp = false;

// Registry of in-flight streams. Keyed by sessionId. Lets renderMessages
// pull the live content (instead of the savePartial-stale persisted copy)
// when a chat is re-entered mid-stream, and lets the stream handler reattach
// to a freshly-rendered bodyEl after a chat switch.
const _liveStreams = new Map(); // sessionId → { content, toolEvents }

function _findStreamingBodyEl(sessionId) {
  if (!activeChat || activeChat.id !== sessionId) return null;
  const messages = document.getElementById('messages');
  if (!messages) return null;
  // DOM uses class 'msg assistant' (see addMessageEl). Older code here
  // looked for '.msg-row.assistant' which never matched after a UI
  // refactor — this helper silently returned null on every chat-switch
  // re-entry, leaving the streaming bubble frozen at the snapshot it
  // rendered on entry, with no incoming deltas able to update the DOM.
  const rows = messages.querySelectorAll('.msg.assistant');
  const last = rows[rows.length - 1];
  return last ? last.querySelector('.msg-body') : null;
}

// ── WebSocket Chat Connection ──
let chatWs = null;
let activeChatsSet = new Set();

function connectChatWs() {
  if (chatWs && chatWs.readyState === WebSocket.OPEN) return;
  const wsUrl = `ws://${location.host}/ws/chat`;
  chatWs = new WebSocket(wsUrl, ['lax-auth', AUTH_TOKEN]);

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
      // Worker-pool ops surface in the AGENTS sidebar (not the chat thread)
      // so background work doesn't pollute the conversation. The sidebar
      // already handles live status updates, output streaming, and removal,
      // and works regardless of which chat is currently active.
      // Step 6 lifecycle: queued → working → completed.
      // bg_op_queued: op submitted but no worker free yet (creates card with
      //   status "queued #N" so user can see queue depth + position).
      // bg_op_started: a worker picked it up (flips card to "working").
      // bg_op_progress: live tool calls / agent text (appended to card output).
      // bg_op_completed: terminal status (status updated; auto-prune at 30 min).
      if (msg.event.type === 'bg_op_queued') {
        try {
          if (typeof addAgentFeed === 'function') {
            addAgentFeed({
              id: msg.event.opId,
              name: 'Worker: ' + (msg.event.task || '').slice(0, 60),
              role: 'coder',
              status: 'queued #' + (msg.event.queuePosition || '?'),
              currentTask: msg.event.task || '',
              output: '⏸ queued (lane: ' + (msg.event.lane || 'build') + ')\n',
            });
          }
        } catch(e) { console.warn('[bg_op_queued] sidebar update failed', e); }
        return;
      }
      if (msg.event.type === 'bg_op_queue_reordered') {
        try {
          if (typeof updateAgentFeed === 'function') {
            updateAgentFeed(msg.event.opId, { status: 'queued #' + msg.event.queuePosition });
          }
        } catch(e) { console.warn('[bg_op_queue_reordered] sidebar update failed', e); }
        return;
      }
      if (msg.event.type === 'bg_op_started') {
        try {
          // Two cases: op was queued first (card already exists, just flip
          // status), OR op dispatched immediately (no prior card, create one).
          // updateAgentFeed is no-op if the card doesn't exist; addAgentFeed
          // is idempotent on existing IDs. So calling both is safe.
          if (typeof updateAgentFeed === 'function') {
            updateAgentFeed(msg.event.opId, { status: 'working', output: '▶ started\n' });
          }
          if (typeof addAgentFeed === 'function') {
            addAgentFeed({
              id: msg.event.opId,
              name: 'Worker: ' + (msg.event.task || '').slice(0, 60),
              role: 'coder',
              status: 'working',
              currentTask: msg.event.task || '',
              output: '',
            });
          }
        } catch(e) { console.warn('[bg_op_started] sidebar update failed', e); }
        return;
      }
      if (msg.event.type === 'bg_op_progress') {
        try {
          if (typeof updateAgentFeed === 'function') {
            updateAgentFeed(msg.event.opId, { output: (msg.event.line || '') + '\n' });
          }
        } catch(e) { console.warn('[bg_op_progress] sidebar update failed', e); }
        return;
      }
      // worker_stream: worker's own LLM text deltas → main chat thread as a
      // distinct "Worker:" bubble (separate from sidebar progress trace).
      // Step 1 of JARVIS-mode roadmap. Per opId so multiple workers each
      // get their own bubble in the same chat. Only rendered in the DOM
      // when the user is viewing the session that owns the worker;
      // off-screen sessions just accumulate in activeChatsSet for sidebar
      // attention markers.
      if (msg.event.type === 'worker_stream') {
        try {
          if (activeChat && activeChat.id === msg.sessionId) {
            const b = ensureWorkerBubble(msg.event.opId, msg.event.task);
            if (b) {
              b.content += (msg.event.delta || '');
              b.contentEl.textContent = b.content;
            }
          } else {
            activeChatsSet.add(msg.sessionId);
            if (typeof renderSidebar === 'function') renderSidebar();
          }
        } catch(e) { console.warn('[worker_stream] failed', e); }
        return;
      }
      if (msg.event.type === 'worker_done') {
        try {
          const b = _workerBubbles.get(msg.event.opId);
          if (b) {
            b.div.classList.add('done');
            b.div.classList.add('status-' + (msg.event.status || 'completed'));
          }
          _workerBubbles.delete(msg.event.opId);
        } catch(e) { console.warn('[worker_done] failed', e); }
        return;
      }
      if (msg.event.type === 'bg_op_nudge') {
        try {
          if (activeChat && activeChat.id === msg.sessionId) {
            activeChat.messages = activeChat.messages || [];
            activeChat.messages.push({ role: 'assistant', content: msg.event.text });
            if (typeof renderMessages === 'function') renderMessages();
          } else {
            activeChatsSet.add(msg.sessionId);
            if (typeof renderSidebar === 'function') renderSidebar();
          }
          if (window.desktop) window.desktop.showNotification('Worker finished', msg.event.text);
        } catch(e) { console.warn('[bg_op_nudge] failed', e); }
        return;
      }
      if (msg.event.type === 'bg_op_completed') {
        try {
          const statusLabel = msg.event.status === 'completed' ? 'completed'
            : msg.event.status === 'failed' ? 'failed' : 'cancelled';
          const filesLine = (msg.event.filesChanged && msg.event.filesChanged.length > 0)
            ? '\n\nfiles: ' + msg.event.filesChanged.slice(0, 5).join(', ')
            : '';
          const output = (msg.event.summary || '(no summary)') + filesLine;
          if (typeof updateAgentFeed === 'function') {
            updateAgentFeed(msg.event.opId, { status: statusLabel, output });
          }
          if (window.desktop) window.desktop.showNotification('Worker finished', (msg.event.summary || '').slice(0, 100));
          // Keep completed cards visible for 30 min so user has plenty of
          // time to notice them. Previously auto-pruned at 2 min, which
          // meant if user wasn't watching the sidebar in that window they
          // had no signal the work landed. (Followup: add a manual dismiss
          // button + auto-collapse on completion so they don't accumulate
          // visually while still being there for reference.)
          setTimeout(function() { try { if (typeof removeAgentFeed === 'function') removeAgentFeed(msg.event.opId); } catch {} }, 30 * 60 * 1000);

          // Note: no synthetic chat message anymore. The agent narrates the
          // completion naturally on the user's NEXT turn via the pending-
          // notifications queue (workers/pending-notifications.ts). Sidebar
          // shows the live state + full result; chat narration happens
          // organically when the user replies.
        } catch(e) { console.warn('[bg_op_completed] update failed', e); }
        return;
      }

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

    // ── App files changed: auto-reload any pinned iframe pointing at that app ──
    // Manifest-generator detects edits under workspace/apps/<name>/ and broadcasts.
    // Without this, the pinned-app iframe only refreshed on user click — agents
    // editing files in the background were invisible until a manual click/refresh.
    if (msg.type === 'app-files-changed' && msg.appName) {
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
  // Append "stopped" indicator to last message; drop the streaming pin so the
  // message bubble shrinks back to its natural height.
  const msgs = document.querySelectorAll('.msg.assistant');
  const last = msgs[msgs.length - 1];
  if (last) {
    // Keep `pin-bottom` on the stopped turn — it's still the most recent
    // assistant reply, so it should keep the reserved viewport-height below.
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
  // ChatGPT-style: during an active streaming turn we DO NOT auto-scroll.
  // The user message was scrolled to the top of the viewport at send time,
  // and the assistant placeholder reserves viewport-height of room below
  // (see .pin-bottom). The response fills that space; the reader controls
  // scroll afterward.
  if (streamingSessionId) return;
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
    // Preserve activity-groups + top-level tool-cards/approval-cards across
    // the markdown re-render. Without preserving the groups, every stream
    // delta would wipe the consolidated activity container.
    const existingGroups = bodyEl.querySelectorAll('.activity-group');
    const orphanCards = bodyEl.querySelectorAll(':scope > .tool-card, :scope > .approval-card');
    // Strip inline plans — the agent's "Plan: 1) X, 2) Y" bullet is for
    // its own reasoning, not for the user's eyes. We remove it before render
    // so the visible bubble just shows the final answer, not the scratchwork.
    const stripped = stripAgentScratchwork(pending.latest);
    bodyEl.innerHTML = stripped ? md(stripped) : '';
    existingGroups.forEach(g => bodyEl.appendChild(g));
    orphanCards.forEach(c => bodyEl.appendChild(c));
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
    el.innerHTML = `<div id="empty"><img src="/hero.jpg" alt="Local Agent X" class="hero-img" /><h2>LOCAL AGENT X</h2><p>${activeChat ? 'Start your conversation below.' : 'Select a chat or start a new one.'}</p></div>`;
    return;
  }
  el.innerHTML = '';
  for (let i = 0; i < activeChat.messages.length; i++) {
    const msg = activeChat.messages[i];
    if (msg.role === 'user') {
      const displayText = msg.attachments ? msg.content.replace(/^Attached files:\n[\s\S]*?\n\n/, '') : msg.content;
      addMessageEl('user', displayText, msg.attachments, msg.timestamp);
    } else if (msg.role === 'assistant' && (msg.content || msg._tools)) {
      const isLast = i === activeChat.messages.length - 1;
      const live = (isLast && msg._streaming) ? _liveStreams.get(activeChat.id) : null;
      // Clean up stale streaming state ONLY if the stream is genuinely no
      // longer active. If we still have a live entry for this session, the
      // stream is in flight — preserve _streaming so the next event keeps
      // updating the same message slot.
      if (msg._streaming && !live) {
        delete msg._streaming;
        if (msg._tools) {
          for (const te of msg._tools) {
            if (te.type === 'start' && !msg._tools.find(t => t.type === 'end' && t.name === te.name)) {
              msg._tools.push({ type: 'end', name: te.name, allowed: true, result: '(interrupted)' });
            }
          }
        }
      }
      // When a stream is live for this chat, render the live content (which
      // is fresher than savePartial's 3-second snapshot in msg.content).
      const displayContent = live ? live.content : (msg.content || '');
      addMessageEl('assistant', displayContent, null, msg.timestamp);
      if (live) {
        // Same selector fix — DOM uses '.msg' / '.msg-body', not '.msg-row .bubble'.
        const allMsgs = el.querySelectorAll('.msg.assistant');
        const lastMsgEl = allMsgs[allMsgs.length - 1];
        const lastBody = lastMsgEl ? lastMsgEl.querySelector('.msg-body') : null;
        if (lastBody) lastBody.classList.add('streaming');
      }
      // Render tool cards — from live registry when streaming, otherwise from
      // the persisted snapshot. Cards go INSIDE bodyEl (not the bubble) so the
      // streaming handler's `bodyEl.querySelectorAll('.tool-card')` lookups
      // for tool_end indicator updates resolve correctly after a chat switch.
      const toolSrc = live ? live.toolEvents : msg._tools;
      if (toolSrc && toolSrc.length > 0) {
        const allMsgsT = el.querySelectorAll('.msg.assistant');
        const lastMsgElT = allMsgsT[allMsgsT.length - 1];
        const lastBody = lastMsgElT ? lastMsgElT.querySelector('.msg-body') : null;
        const cardHost = lastBody || lastMsgElT;
        if (cardHost) {
          try {
            for (const te of toolSrc) {
              if (te.type === 'start') {
                // Route through appendToolCardGrouped so re-render matches
                // the live-stream path: cards land inside the collapsible
                // "Agent activity" group, and consecutive same-tool calls
                // collapse into a single ×N card. Without this, re-rendering
                // a saved chat produced a flat list of cards (no parent
                // wrapper, no ×N collapse) — the bug visible after a chat
                // tab switch or reload.
                const card = appendToolCardGrouped(cardHost, te.name, te.args || '', te.riskLevel);
                const endEvt = toolSrc.find(t => t.type === 'end' && t.name === te.name);
                if (endEvt) {
                  card.querySelector('.indicator').className = 'indicator ' + (endEvt.allowed ? 'allowed' : 'blocked');
                  card.querySelector('.tool-detail').textContent = (endEvt.result || '').slice(0, 200) || '✓ Done';
                }
              }
            }
          } catch (toolRenderErr) { console.error('[chat] tool card render error:', toolRenderErr); }
        }
      }
    }
  }
  // Pin the latest assistant message so it carries the reserved viewport-
  // height of room below it (ChatGPT-style). When navigating to an existing
  // chat, this gives the most recent reply that breathing room without any
  // active stream.
  const allAssistant = el.querySelectorAll('.msg.assistant');
  if (allAssistant.length > 0) allAssistant[allAssistant.length - 1].classList.add('pin-bottom');
  el.scrollTop = el.scrollHeight;
}

async function sendMessage() {
  // Step 4 — interject during own-turn:
  // If the active chat is currently streaming (main agent mid-tool-loop),
  // the user's new message gets injected into the running turn instead of
  // starting a new one. Backend's interjectDrainMiddleware drains the
  // queue at the start of the next iteration so the agent sees it.
  if (streamingSessionId && activeChat && streamingSessionId === activeChat.id) {
    const input = document.getElementById('msg-input');
    const text = input.value.trim();
    if (!text) return;
    if (chatWs && chatWs.readyState === WebSocket.OPEN) {
      chatWs.send(JSON.stringify({ type: 'inject', sessionId: activeChat.id, message: text }));
    }
    // Echo locally as a user message so the chat reflects the interject
    // immediately without waiting for round-trip confirmation.
    activeChat.messages.push({ role: 'user', content: text, timestamp: Date.now(), _injected: true });
    if (typeof renderMessages === 'function') renderMessages();
    input.value = ''; input.style.height = 'auto';
    saveChats();
    return;
  }
  if (streamingSessionId) return;
  userScrolledUp = false; // Reset scroll lock when user sends
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text && pendingUploads.length === 0) return;
  // Wait for any in-flight uploads to finish before capturing attachments —
  // images need their server URL resolved, otherwise the backend filters them out
  // (see prepare-request.ts: `if (a.isImage && a.url)`).
  // Hard 8s ceiling per upload: a hung server (mid-restart) used to leave the
  // promise pending forever, blocking every subsequent send. The race below
  // either settles when uploads complete OR aborts the wait so we still try
  // to send (image will be url:null and the backend will skip it, but the
  // user's text reaches the agent rather than nothing).
  const inflight = pendingUploads.filter(f => f._uploadPromise).map(f => f._uploadPromise);
  if (inflight.length > 0) {
    await Promise.race([
      Promise.all(inflight),
      new Promise(resolve => setTimeout(resolve, 8000)),
    ]);
  }
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
  const userMsgEl = addMessageEl('user', displayText, msgAttachments, msgTime);
  activeChat.messages.push({ role: 'user', content: finalText, attachments: msgAttachments, timestamp: msgTime });
  const msgEl = addMessageEl('assistant', '');
  let bodyEl = msgEl.querySelector('.msg-body');
  bodyEl.innerHTML = '<div class="thinking"><span>.</span><span>.</span><span>.</span></div>';
  // ChatGPT-style scroll pin: addMessageEl already migrated `pin-bottom` to
  // the new assistant bubble (this one). Anchor the user prompt to the top.
  if (userMsgEl) {
    requestAnimationFrame(() => {
      try { userMsgEl.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch {}
    });
  }
  // Mark as streaming so the CSS adds a pulsing cursor + slight opacity
  // dim. Removed on `done`. Visual cue that text is still in flight so
  // mid-turn questions like "Want me to start?" don't read as final.
  try { bodyEl.classList.add('streaming'); } catch {}
  const streamSessionId = activeChat.id; // Capture which session THIS stream belongs to
  const streamChat = activeChat; // Reference to the chat object (survives navigation)
  streamingSessionId = streamSessionId; stopSpeaking(); ttsSentenceBuffer = '';
  // Track task start for browser notifications (feature 96)
  if (window.taskStartTime !== undefined) window.taskStartTime = Date.now();
  const stopBtn = document.getElementById('stop-btn');
  if (stopBtn) stopBtn.style.display = 'flex';
  // Step 4: keep send-btn ENABLED during streaming so user can type
  // interjects ("actually use blue", "also add Y"). sendMessage routes
  // through the inject path when streamingSessionId === activeChat.id.
  document.getElementById('send-btn').disabled = false;

  // Helper: is the user still viewing this chat?
  function isViewingThis() { return activeChat && activeChat.id === streamSessionId; }

  // Resolve the streaming bodyEl dynamically so chat-switch-and-back reattaches.
  // The originally-captured bodyEl gets detached when renderMessages rebuilds
  // the DOM for the other chat. When we come back, renderMessages creates a
  // fresh bodyEl — this helper finds it.
  function getBodyEl() {
    if (bodyEl && bodyEl.isConnected) return bodyEl;
    const fresh = _findStreamingBodyEl(streamSessionId);
    if (fresh) bodyEl = fresh;
    return bodyEl && bodyEl.isConnected ? bodyEl : null;
  }

  // Feature 5: Mood detection — update indicator
  detectMood(text);

  let content = '';
  let toolEvents = [];

  // Register so renderMessages can pull live state when re-entering this chat
  _liveStreams.set(streamSessionId, { get content() { return content; }, get toolEvents() { return toolEvents; } });

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
        // If we're viewing, make sure bodyEl points to a connected DOM node.
        // After a chat-switch-and-back, the originally-captured bodyEl is
        // detached and renderMessages has rendered a fresh one.
        if (viewing) getBodyEl();
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
              // Preserve activity-groups (which contain tool cards) across
              // the markdown re-render — without this, every text delta wipes
              // the group container and orphaned tool cards float in body.
              const existingGroups = bodyEl.querySelectorAll('.activity-group');
              const orphanCards = bodyEl.querySelectorAll(':scope > .tool-card');
              bodyEl.innerHTML = content ? md(content) : '';
              existingGroups.forEach(g => bodyEl.appendChild(g));
              orphanCards.forEach(c => bodyEl.appendChild(c));
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
          case 'secret_request': showSecretModal(event.name, event.service, event.reason); break;
          case 'secrets_request': showMultiSecretModal(event.secrets); break;
          case 'approval_requested':
            if (viewing) bodyEl.appendChild(makeApprovalCard(event.approvalId, event.toolName, event.context, event.argsPreview));
            break;
          case 'approval_timeout': {
            const card = document.querySelector('.approval-card[data-id="' + event.approvalId + '"]');
            if (card) { card.classList.add('timeout'); card.querySelector('.approval-status').textContent = 'Timed out \u2014 denied.'; card.querySelectorAll('button').forEach(b => b.disabled = true); }
            break;
          }
          case 'context_status': if (viewing) updateContextBar(event); break;
          case 'stopped':
            // Render a small italic stop-notice below the message body.
            // NOT appended to `content` — keeps the message clean and
            // prevents the technical reason from being persisted into chat
            // history. The technical `debug` text is logged to console for
            // diagnostics but never shown in the UI.
            if (event.debug) console.info('[stopped]', event.firedBy || '?', event.debug);
            if (viewing) {
              const note = document.createElement('div');
              note.className = 'stop-notice';
              note.textContent = event.reason || 'Stopped.';
              note.title = event.debug || event.firedBy || '';
              bodyEl.appendChild(note);
            }
            break;
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
                const existingGroups = bodyEl.querySelectorAll('.activity-group');
                const orphanCards = bodyEl.querySelectorAll(':scope > .tool-card, :scope > .approval-card');
                bodyEl.innerHTML = pending.latest ? md(pending.latest) : '';
                existingGroups.forEach(g => bodyEl.appendChild(g));
                orphanCards.forEach(c => bodyEl.appendChild(c));
              } else if (content && bodyEl) {
                // No pending rAF — ensure DOM has latest content (in case last
                // delta arrived on the same tick as 'done')
                const existingGroups = bodyEl.querySelectorAll('.activity-group');
                const orphanCards = bodyEl.querySelectorAll(':scope > .tool-card, :scope > .approval-card');
                const currentMd = md(content);
                if (bodyEl.innerHTML !== currentMd || existingGroups.length > 0 || orphanCards.length > 0) {
                  bodyEl.innerHTML = currentMd;
                  existingGroups.forEach(g => bodyEl.appendChild(g));
                  orphanCards.forEach(c => bodyEl.appendChild(c));
                }
              }
            }
            updateContextBar();
            flushTTS();
            if (typeof window.notifyTaskComplete === 'function') window.notifyTaskComplete(streamChat.title);
            break;
          }
        }
        // No post-event auto-scroll. The user message was pinned to the top of
        // the viewport at send time, the assistant bubble reserves room below,
        // and the reader stays in control of scroll throughout (and after).
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
          if (viewing) getBodyEl();
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
            case 'secret_request': showSecretModal(event.name, event.service, event.reason); break;
            case 'secrets_request': showMultiSecretModal(event.secrets); break;
              case 'approval_requested':
              if (viewing) bodyEl.appendChild(makeApprovalCard(event.approvalId, event.toolName, event.context, event.argsPreview));
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
                bodyEl.appendChild(note);
              }
              break;
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
      // No post-event auto-scroll (see WS handler comment above).
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
  _liveStreams.delete(streamSessionId);
  // pin-bottom stays — see WS-handler note. Latest turn keeps reserved height.
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

// Worker bubbles — Step 1 of JARVIS-mode. Per-opId map of the streaming
// chat bubbles owned by background workers. Created lazily on first
// worker_stream event for an opId, finalized on worker_done. Lives
// outside chat.activeChat.messages because workers can stream
// independent of the main agent's turn boundary.
const _workerBubbles = new Map(); // opId -> { div, content, contentEl }

function ensureWorkerBubble(opId, taskHint) {
  if (_workerBubbles.has(opId)) return _workerBubbles.get(opId);
  const el = document.getElementById('messages');
  if (!el) return null;
  // Use the assistant-bubble layout so the worker message flows inline
  // with chat. Previously inline styles + raw <pre> placement caused the
  // bubble to render way below other messages with weird spacing.
  const div = document.createElement('div');
  div.className = 'msg assistant worker-bubble streaming';
  div.setAttribute('role', 'article');
  div.setAttribute('aria-label', 'Worker message');
  div.dataset.opId = opId;
  const labelText = taskHint ? `⚙ Worker — ${esc(taskHint)}` : '⚙ Worker';
  div.innerHTML =
    `<div class="msg-label">${labelText}</div>` +
    `<div class="msg-body"><div class="worker-content"></div></div>` +
    `<div class="msg-footer"></div>`;
  // One-time CSS for worker tinting — keeps the visual distinct from
  // main agent without a stylesheet migration.
  const styleId = '_workerBubbleCSS';
  if (!document.getElementById(styleId)) {
    const s = document.createElement('style');
    s.id = styleId;
    s.textContent =
      '.msg.assistant.worker-bubble .msg-label{color:#9d9bff}' +
      '.msg.assistant.worker-bubble .msg-body{border-left:2px solid #4a4870;padding-left:10px;opacity:.92}' +
      '.msg.assistant.worker-bubble .worker-content{white-space:pre-wrap;font-size:.92rem;line-height:1.45}';
    document.head.appendChild(s);
  }
  el.appendChild(div);
  if (typeof Spring !== 'undefined') {
    try { Spring.fadeIn(div, { preset: 'stiff', slide: true, slideFrom: 8 }); } catch {}
  }
  try { el.scrollTop = el.scrollHeight; } catch {}
  const contentEl = div.querySelector('.worker-content');
  const entry = { div, content: '', contentEl };
  _workerBubbles.set(opId, entry);
  return entry;
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
  // Migrate the viewport-height pin to the newest assistant bubble. Without
  // this, an agent-emitted follow-up message (build progress, multi-stage
  // reply, op-status update — anything that doesn't go through the user-send
  // flow) lands below the prior bubble's reserved 100vh-of-room and shows
  // up as a giant gap between the two messages.
  if (role === 'assistant') {
    document.querySelectorAll('.msg.assistant.pin-bottom').forEach(prev => prev.classList.remove('pin-bottom'));
    div.classList.add('pin-bottom');
  }
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
  card.innerHTML = `<div class="tool-header" onclick="this.parentElement.classList.toggle('open')"><span class="indicator"></span><span class="tool-name">${esc(name)}</span><span class="tool-count" style="font-size:.7rem;margin-right:.3rem"></span><span class="tool-summary" style="color:var(--muted);font-size:.72rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${esc(toolSummary(name, args))}</span><span class="chevron">&#9654;</span></div>`
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
// (Removed: renderGeneratedImage. The built-in image_generation flow via
// Codex OAuth never worked — see codex-client.ts ~line 144 for why. Image
// generation now happens by the agent navigating to a paid LLM site via
// the browser tool.)

/**
 * Find or create the last activity-group inside this container. Activity
 * groups consolidate ALL consecutive tool calls within one assistant
 * response into a single collapsible block — instead of 15 stacked tool
 * cards flooding the chat, you see "⚙ Agent activity (15)" with a
 * click-to-expand header.
 *
 * A new group starts when the assistant emits actual text content — see
 * the renderStreamContent path which inserts a marker element that
 * breaks the activity-group lookup.
 */
function ensureActivityGroup(container) {
  // Walk children backwards — if the LAST child is an activity-group,
  // reuse it. If anything else is in between (text, image, etc.), start
  // a new group so cards stay grouped per "burst" of activity.
  const last = container.lastElementChild;
  if (last && last.classList && last.classList.contains('activity-group')) {
    return last;
  }
  const group = document.createElement('div');
  group.className = 'activity-group';
  group.style.cssText = 'border:1px solid var(--border,#333);border-radius:6px;margin:.4rem 0;overflow:hidden;background:var(--surface-2,rgba(0,0,0,0.15))';
  group.innerHTML =
    `<div class="activity-group-header" style="cursor:pointer;padding:.4rem .6rem;display:flex;align-items:center;gap:.5rem;font-size:.75rem;color:var(--muted);user-select:none" onclick="this.parentElement.classList.toggle('open');this.querySelector('.activity-chevron').textContent=this.parentElement.classList.contains('open')?'\\u25BC':'\\u25B6'">` +
      `<span style="opacity:.8">⚙</span>` +
      `<span class="activity-label" style="flex:1">Agent activity</span>` +
      `<span class="activity-count" style="font-variant-numeric:tabular-nums">0</span>` +
      `<span class="activity-chevron">▶</span>` +
    `</div>` +
    `<div class="activity-group-body" style="max-height:320px;overflow-y:auto;padding:0 .4rem .4rem"></div>`;
  // Hide the body when not .open
  const styleId = '_activityGroupCSS';
  if (!document.getElementById(styleId)) {
    const s = document.createElement('style');
    s.id = styleId;
    s.textContent = '.activity-group:not(.open) .activity-group-body{display:none}';
    document.head.appendChild(s);
  }
  container.appendChild(group);
  return group;
}

function appendToolCardGrouped(container, name, args, riskLevel, context) {
  const group = ensureActivityGroup(container);
  const body = group.querySelector('.activity-group-body');
  const cards = body.querySelectorAll('.tool-card');
  const last = cards[cards.length - 1];

  // Same-name dedup INSIDE the group (preserves the legacy "bash x6" UX).
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
    bumpActivityCount(group);
    return last;
  }
  const card = makeToolCard(name, args, riskLevel, context);
  body.appendChild(card);
  bumpActivityCount(group);
  return card;
}

function bumpActivityCount(group) {
  const countEl = group.querySelector('.activity-count');
  if (!countEl) return;
  const cur = parseInt(countEl.getAttribute('data-total') || '0', 10) + 1;
  countEl.setAttribute('data-total', String(cur));
  countEl.textContent = String(cur);
  // When count gets large, hint that there's more
  const label = group.querySelector('.activity-label');
  if (label) label.textContent = cur >= 5 ? `Agent activity — ${cur} actions` : 'Agent activity';
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

// Secret modal lives in /js/secret-modal.js — exposes window.showSecretModal,
// window.showMultiSecretModal, window.submitSecret, window.cancelSecret.

// ── Upload ──
// ── Retry with error hints ──
function showRetryError(el, originalMessage, errorMsg) {
  let hint = 'Check your internet connection and try again.';
  if (errorMsg.includes('timeout') || errorMsg.includes('Timeout')) hint = 'The server took too long to respond. It may be processing a heavy task — try again in a moment.';
  else if (errorMsg.includes('Failed to fetch') || errorMsg.includes('network')) hint = 'Could not reach the server. Make sure Local Agent X is running.';
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
let _voiceSilenceTimer = null; // sphere → idle if no audio frame for 800ms

// Dictate mode is mutually exclusive with voice mode. Uses the browser's
// native SpeechRecognition API (instant-on, native streaming partials, no
// model download, no WebSocket) instead of the full voice-chat pipeline
// which is overkill for one-shot speech-to-text. Mic stream is still
// captured so the sphere visualization can react to audio.
let dictateMode = false;
let dictateSR = null;          // SpeechRecognition instance
let dictateMicStream = null;   // MediaStream for sphere analyser only
let dictateCtx = null;         // AudioContext for sphere analyser
let dictateRestartGuard = false; // prevent restart-loop on errors

async function toggleMic() {
  if (voiceMode) { stopVoiceMode(); }
  else {
    if (dictateMode) stopDictate();   // mutex: only one mic mode at a time
    await startVoiceMode();
  }
}

// ── Dictate mode ──
// Speech-to-text only — pipes Whisper finals into the message textarea so
// the user can review and send manually. No agent reply, no TTS playback.
// Reuses the voice WS, mic-capture worklet, and sphere visualization, but
// short-circuits the agent_start / assistant_delta event flow on the client.
// A pending server-side `mode: "dictate"` flag would let us skip TTS init
// entirely (~80MB Kokoro download); for v1 the model loads but never fires
// because we don't auto-submit transcripts.

async function toggleDictate() {
  if (dictateMode) { stopDictate(); }
  else {
    if (voiceMode) stopVoiceMode();   // mutex: only one mic mode at a time
    await startDictate();
  }
}

async function startDictate() {
  if (dictateMode) return;
  // Browser SpeechRecognition is the right tool for one-shot dictation:
  // instant-on, native streaming partials, no model download, no WebSocket.
  // Quality is roughly base.en-equivalent (~3-5% WER). If unavailable
  // (Firefox/Safari without webkit prefix) we'd fall back to the WS
  // pipeline, but Chrome/Edge cover the vast majority of users.
  // Browser support summary (last verified: 2026-05):
  //   Chrome / Edge / Brave / Opera (desktop + Android) → works (Google cloud ASR)
  //   Safari (macOS 14.1+ / iOS 14.5+)                  → works (webkitSpeechRecognition prefix; Apple on-device ASR on newer hardware)
  //   Firefox                                          → flag-gated, disabled by default
  //
  // For Firefox / unsupported browsers we tell the user how to recover
  // (switch browser, or use Voice Mode which goes through the local
  // Whisper WS pipeline and works everywhere).
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    alert(
      "Dictation isn't supported in this browser.\n\n" +
      "Works in Chrome, Edge, Brave, Opera, and Safari (Mac 14.1+ / iOS 14.5+).\n" +
      "Doesn't work in Firefox (disabled by default).\n\n" +
      "Two fallbacks:\n" +
      "  1. Switch to a Chromium-based browser, or\n" +
      "  2. Use Voice Mode (the 🎤 button) which uses the local Whisper pipeline and works everywhere.",
    );
    return;
  }
  try {
    dictateMode = true;
    dictateRestartGuard = false;

    // Mic stream for sphere visualization. Browser SR opens its own mic
    // session internally (we don't get its audio) — this getUserMedia is
    // ONLY for the AnalyserNode that drives the dust particle reactions.
    // Cheap; same permission prompt as voice mode.
    try {
      dictateMicStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      dictateCtx = new AudioContext();
      const source = dictateCtx.createMediaStreamSource(dictateMicStream);
      if (window.VoiceSphere) {
        const ana = dictateCtx.createAnalyser();
        ana.fftSize = 2048;
        source.connect(ana);
        const savedMode = localStorage.getItem('lax_voice_view_mode') || 'split';
        VoiceSphere.show(savedMode);
        VoiceSphere.attachMicAnalyser(ana);
        VoiceSphere.setState('listening');
      }
    } catch (sphereErr) {
      // Sphere is decoration — keep going if mic-for-visuals fails.
      console.warn('[dictate] sphere mic init failed (continuing without visualization):', sphereErr);
    }

    // SpeechRecognition itself
    dictateSR = new SR();
    dictateSR.continuous = true;       // mic stays hot until user stops
    dictateSR.interimResults = true;   // live streaming partials
    dictateSR.lang = navigator.language || 'en-US';
    dictateSR.maxAlternatives = 1;

    dictateSR.onresult = (event) => {
      const preview = document.getElementById('dictate-preview');
      let interim = '';
      // Walk new results since last event. Final results commit to the
      // textarea via appendDictatedText (handles capitalize + period join).
      // Interim results stack into the preview row below the textarea.
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0].transcript;
        if (result.isFinal) {
          appendDictatedText(transcript);
        } else {
          interim += transcript;
        }
      }
      if (preview) {
        preview.textContent = interim;
        preview.style.display = interim ? 'block' : 'none';
      }
    };

    dictateSR.onerror = (event) => {
      console.warn('[dictate] SR error:', event.error, event.message || '');
      // Non-fatal errors: 'no-speech', 'audio-capture' (transient mic glitch),
      // 'aborted' (we stopped it). Fatal: 'not-allowed' (mic permission denied).
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        alert('Mic permission denied. Allow microphone access for dictation.');
        stopDictate();
      }
    };

    dictateSR.onend = () => {
      // SR auto-stops after silence on some browsers even with continuous=true.
      // Restart it so the mic stays hot until the user explicitly stops.
      if (dictateMode && !dictateRestartGuard) {
        try { dictateSR.start(); } catch {} // already-started errors are fine
      }
    };

    dictateSR.start();
    updateDictateUI();
    // Focus the textarea so Enter routes through handleInputKeydown
    // (stops dictation) instead of triggering the dictate-btn click again.
    // Without this the user's Enter could hit whatever element had focus
    // when they clicked the button.
    document.getElementById('msg-input')?.focus();
    console.log('[dictate] started (browser SpeechRecognition)');
  } catch (e) {
    console.error('[dictate] start failed:', e);
    dictateMode = false;
    cleanupDictateResources();
    alert('Could not start dictation: ' + (e?.message || e));
  }
}

function stopDictate() {
  if (!dictateMode) return;
  dictateMode = false;
  dictateRestartGuard = true; // block onend from auto-restarting
  cleanupDictateResources();
  const preview = document.getElementById('dictate-preview');
  if (preview) { preview.textContent = ''; preview.style.display = 'none'; }
  updateDictateUI();
  // Cursor back to the textarea + caret at end so the next Enter sends
  // the dictated message instead of falling through to nothing.
  const ta = document.getElementById('msg-input');
  if (ta) {
    ta.focus();
    const len = ta.value.length;
    try { ta.setSelectionRange(len, len); } catch {}
  }
  console.log('[dictate] stopped');
}

function cleanupDictateResources() {
  try { dictateSR && dictateSR.stop(); } catch {}
  dictateSR = null;
  try { dictateMicStream && dictateMicStream.getTracks().forEach(t => t.stop()); } catch {}
  dictateMicStream = null;
  try { dictateCtx && dictateCtx.close(); } catch {}
  dictateCtx = null;
  if (window.VoiceSphere) { try { VoiceSphere.hide(); } catch {} }
}

function updateDictateUI() {
  const btn = document.getElementById('dictate-btn');
  if (!btn) return;
  if (dictateMode) {
    btn.classList.add('dictating');
    btn.title = 'Stop dictation (or press Enter)';
  } else {
    btn.classList.remove('dictating');
    btn.title = 'Dictate (speech to text only — no agent reply)';
  }
}

// Append a Whisper-finalized utterance into the message textarea with
// dumb multi-sentence joining: space + capitalize next + add terminal
// punctuation if missing. Whisper does intra-utterance punctuation well;
// cross-utterance is best-effort. User edits before sending = safety net.
function appendDictatedText(utterance) {
  const ta = document.getElementById('msg-input');
  if (!ta || !utterance) return;
  let text = utterance.trim();
  if (!text) return;
  const existing = ta.value;
  if (existing.length === 0) {
    // First utterance — capitalize first character if it isn't already.
    text = text.charAt(0).toUpperCase() + text.slice(1);
    ta.value = text;
  } else {
    // Continuation — ensure prior text terminates, then capitalize new.
    const lastChar = existing.charAt(existing.length - 1);
    const needsTerminator = !/[.!?,;:]/.test(lastChar);
    const sep = needsTerminator ? '. ' : ' ';
    const cap = text.charAt(0).toUpperCase() + text.slice(1);
    ta.value = existing + sep + cap;
  }
  // Auto-grow + scroll to end so the user sees what just landed.
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.scrollTop = ta.scrollHeight;
  // Clear preview row — that partial is now committed above.
  const preview = document.getElementById('dictate-preview');
  if (preview) preview.textContent = '';
}

// Centralized textarea Enter handler. Dictate mode steals Enter for stop;
// otherwise normal send. Shift-Enter always inserts a newline (textarea default).
function handleInputKeydown(event) {
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  if (dictateMode) { stopDictate(); }
  else { sendMessage(); }
}

async function startVoiceMode() {
  if (voiceMode) return;
  try {
    // 1) Connect to /ws/voice with auth token.
    //
    // Use a LOCAL ws reference for everything in this init function. The
    // global voiceWS used to be assigned and then read back in handler
    // attach + send calls — but a stale onclose from a previous session
    // could fire mid-init and null voiceWS via cleanupVoiceResources,
    // causing a TypeError on `voiceWS.onmessage = ...`. The local ref
    // immunizes us from that race; the wrap-onclose closure-guards the
    // cleanup so only the CURRENT WS triggers a global teardown.
    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/voice?token=${encodeURIComponent(AUTH_TOKEN)}`;
    const ws = new WebSocket(wsUrl);
    voiceWS = ws;
    ws.binaryType = 'arraybuffer';

    await new Promise((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('voice ws error'));
      ws.onclose = (e) => {
        if (ws.readyState !== WebSocket.OPEN) reject(new Error(`voice ws closed before open (code ${e.code})`));
      };
    });

    // Attach handlers BEFORE hello so server-side ready/init events aren't lost.
    // The onclose closure compares ws to the current voiceWS — if a fresh
    // session has reassigned voiceWS, this stale handler is a no-op.
    ws.onmessage = handleVoiceWsMessage;
    ws.onclose = () => {
      if (voiceWS !== ws) return; // stale handler from a prior session
      console.log('[voice] ws closed');
      cleanupVoiceResources();
    };

    // 2) Send hello + saved voice/speed settings. Mode tells the server
    // whether to run the full agent pipeline (chat) or stop after Whisper
    // and emit the transcript only (dictate). Server-side guards in
    // voice-session.ts and gpu-session.ts skip agent_start + TTS in
    // dictate mode so the user only gets the transcript, not a phantom
    // agent reply.
    const sid = (typeof activeChat !== 'undefined' && activeChat?.id) ? activeChat.id : 'default';
    const sessionMode = dictateMode ? 'dictate' : 'chat';
    ws.send(JSON.stringify({ type: 'hello', sessionId: 'chat-' + sid + '-' + Date.now(), mode: sessionMode }));
    const savedVoice = localStorage.getItem('lax_voice') || 'am_michael';
    const savedSpeed = parseFloat(localStorage.getItem('lax_speed') || '1.15');
    ws.send(JSON.stringify({ type: 'voice_settings', voice: savedVoice, speed: savedSpeed }));

    // 3) AudioContext + worklets. Cache-bust the worklet URLs — without the
    // version param, an older browser-cached worklet file (missing the
    // registerProcessor call) silently "loads" but doesn't register the
    // processor name, then `new AudioWorkletNode(ctx, 'mic-capture')` throws
    // "mic-capture is not defined in AudioWorkletGlobalScope". Bump the
    // version when the worklet code changes.
    voiceCtx = new AudioContext();
    await voiceCtx.audioWorklet.addModule('/js/voice/mic-capture-worklet.js?v=vb2');
    await voiceCtx.audioWorklet.addModule('/js/voice/playback-worklet.js?v=vb2');

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

    // 6) Sphere visualization — tap mic + TTS playback through analysers
    if (window.VoiceSphere) {
      try {
        const micAna = voiceCtx.createAnalyser(); micAna.fftSize = 2048;
        source.connect(micAna);
        const ttsAna = voiceCtx.createAnalyser(); ttsAna.fftSize = 2048;
        voicePlaybackNode.connect(ttsAna);
        const savedMode = localStorage.getItem('lax_voice_view_mode') || 'split';
        VoiceSphere.show(savedMode);
        VoiceSphere.attachMicAnalyser(micAna);
        VoiceSphere.attachTtsAnalyser(ttsAna);
        VoiceSphere.setState('idle');
      } catch (sphereErr) { console.warn('[voice-sphere] init failed:', sphereErr); }
    }

    voiceMode = true;
    voiceEnabled = true;
    // Only flip the chat-mode UI labels in actual voice-chat mode. Dictate
    // reuses the same WS + sphere infra but is a different product surface
    // — labeling its session as "VOICE ON" + lighting up the mic-btn would
    // mislead the user into thinking the agent is listening for a reply.
    if (!dictateMode) {
      const ttsBtn = document.getElementById('tts-toggle');
      if (ttsBtn) { ttsBtn.textContent = 'VOICE ON'; ttsBtn.className = 'active'; }
    }
    updateVoiceUI();
    console.log(`[voice] session started (mode=${dictateMode ? 'dictate' : 'chat'})`);
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
  if (window.VoiceSphere) { try { VoiceSphere.hide(); } catch {} }
  try { renderVoiceEngineBadge(null); } catch {}
  window.LAX_VOICE_RUNTIME = null;
  updateVoiceUI();
}

function handleVoiceWsMessage(e) {
  // Binary frames are TTS PCM — pipe to playback worklet
  if (typeof e.data !== 'string') {
    if (voicePlaybackNode) voicePlaybackNode.port.postMessage({ cmd: 'pcm', pcm: e.data });
    // First audio frame of a turn = the moment Optimus actually starts
    // talking. Switch the sphere to 'speaking' here, NOT on agent_start
    // (which fires when text streaming begins, before any audio reaches
    // the speaker). Reset the silence watchdog every frame; when it expires
    // we know audio playback has actually finished.
    if (window.VoiceSphere && VoiceSphere.currentState !== 'speaking') {
      VoiceSphere.setState('speaking');
    }
    if (_voiceSilenceTimer) clearTimeout(_voiceSilenceTimer);
    _voiceSilenceTimer = setTimeout(() => {
      if (window.VoiceSphere && VoiceSphere.currentState === 'speaking') {
        VoiceSphere.setState('idle');
      }
    }, 800);
    return;
  }
  let msg;
  try { msg = JSON.parse(e.data); } catch { return; }

  switch (msg.type) {
    case 'voice_ready':
      if (voicePlaybackNode && msg.ttsSampleRate) {
        voicePlaybackNode.port.postMessage({ cmd: 'setRate', rate: msg.ttsSampleRate });
      }
      window.LAX_VOICE_RUNTIME = { engine: msg.engine || null, tts: msg.tts || null, stt: msg.stt || null };
      try { renderVoiceEngineBadge(window.LAX_VOICE_RUNTIME); } catch (badgeErr) { console.warn('[voice] badge render failed:', badgeErr); }
      break;
    case 'vad_speech_start': isListening = true; updateVoiceUI();
      window.VoiceSphere && VoiceSphere.setState('listening'); break;
    case 'vad_speech_end':   isListening = false; updateVoiceUI();
      window.VoiceSphere && VoiceSphere.setState('thinking'); break;
    case 'final': {
      if (!msg.text) break;
      // Dictate mode: route Whisper finals into the message textarea instead
      // of the chat thread. User reviews + sends manually.
      if (dictateMode) {
        appendDictatedText(msg.text);
        break;
      }
      const empty = document.getElementById('empty');
      if (empty) empty.remove();
      if (typeof addMessageEl === 'function') addMessageEl('user', msg.text);
      if (typeof activeChat !== 'undefined' && activeChat) {
        activeChat.messages.push({ role: 'user', content: msg.text });
        activeChat.updatedAt = Date.now();
      }
      break;
    }
    case 'partial': {
      // Streaming Sherpa partial — show in the ghost preview row below the
      // textarea. Only renders during dictate mode (in voice mode we let
      // the chat thread handle it). Each partial REPLACES the prior partial
      // (Sherpa rewrites as it gets more audio); on speech-end the `final`
      // event commits to textarea via appendDictatedText and clears the row.
      if (!dictateMode || !msg.text) break;
      const preview = document.getElementById('dictate-preview');
      if (preview) {
        preview.textContent = msg.text;
        preview.style.display = 'block';
      }
      break;
    }
    case 'agent_start': {
      // Dictate mode: agent should never run, but if a stale server still
      // tries to start a turn, just drop the events instead of injecting
      // a phantom assistant bubble into the chat thread.
      if (dictateMode) break;
      if (typeof addMessageEl === 'function') {
        voiceCurrentMsgEl = addMessageEl('assistant', '');
        voiceCurrentMsgBody = voiceCurrentMsgEl?.querySelector('.msg-body');
        if (voiceCurrentMsgBody) voiceCurrentMsgBody.innerHTML = '<div class="thinking"><span>.</span><span>.</span><span>.</span></div>';
      }
      voiceCurrentMsgText = '';
      isSpeaking = true; updateVoiceUI();
      // Sphere stays in 'thinking' here — it transitions to 'speaking' when
      // the first audio frame actually arrives at the playback worklet,
      // which is when the user hears anything (the SoVITS synth + sentence
      // buffering adds 1-3s of lag after text starts streaming).
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
      // Sphere transitions to idle via the audio-frame watchdog (800ms of
      // no PCM frames) — these events fire when the SIDECAR queue is empty
      // but the worklet's ring buffer can still have audio. Trusting them
      // here cut the visible pulse short before the user's speakers stopped.
      break;
    case 'visual':
      // LLM-driven particle directive. The agent called voice_visual mid-
      // reply; sphere morphs to the requested form for ~durationMs.
      if (window.VoiceSphere && typeof VoiceSphere.handleDirective === 'function') {
        VoiceSphere.handleDirective({
          kind: msg.kind, value: msg.value, durationMs: msg.durationMs,
        });
      }
      break;
    case 'voice_error':
    case 'agent_error':
    case 'stt_error':
    case 'tts_error':
      console.warn('[voice]', msg.type, msg.message);
      break;
  }
}

// Browser-fallback TTS for text chat. When the user's chosen TTS engine in
// Settings is "browser", we pipe streaming reply deltas into the browser's
// native window.speechSynthesis so users without a GPU/sidecar can still
// hear replies (robotic but free). For any other engine we no-op here —
// voice mode (mic) handles its own TTS via the Lite sidecar WebSocket.
let _browserTtsBuf = "";
function _browserTtsActive() {
  try { return localStorage.getItem('lax_tts_engine') === 'browser'; } catch { return false; }
}
function _browserSpeak(text) {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  // Pull rate from saved settings so the speed slider in Settings matches.
  try {
    const r = parseFloat(localStorage.getItem('lax_speed') || '1.0');
    if (r > 0.4 && r < 2.5) u.rate = r;
  } catch {}
  window.speechSynthesis.speak(u);
}
function feedTTS(delta) {
  if (!_browserTtsActive() || !delta) return;
  _browserTtsBuf += delta;
  // Speak whole sentences as they arrive. If the buffer crosses a sentence
  // terminator, slice off and speak that part; keep the tail for next delta.
  const SENT = /[.!?]["')\]]?(\s|$)/g;
  let lastCut = 0;
  let m;
  while ((m = SENT.exec(_browserTtsBuf)) !== null) {
    const sentence = _browserTtsBuf.slice(lastCut, m.index + m[0].length).trim();
    if (sentence) _browserSpeak(sentence);
    lastCut = m.index + m[0].length;
  }
  if (lastCut > 0) _browserTtsBuf = _browserTtsBuf.slice(lastCut);
}
function flushTTS() {
  if (!_browserTtsActive()) { _browserTtsBuf = ""; return; }
  const tail = _browserTtsBuf.trim();
  if (tail) _browserSpeak(tail);
  _browserTtsBuf = "";
}
function stopSpeaking() {
  if (voicePlaybackNode) voicePlaybackNode.port.postMessage({ cmd: 'flush' });
  if ('speechSynthesis' in window) {
    try { window.speechSynthesis.cancel(); } catch {}
  }
  _browserTtsBuf = "";
  isSpeaking = false; updateVoiceUI();
}
function toggleTTS() { toggleMic(); }
function fetchTTSAudio() { return null; } // shim


function renderVoiceEngineBadge(rt) {
  const el = document.getElementById('voice-engine-badge');
  if (!el) return;
  if (!rt || !rt.engine) { el.style.display = 'none'; el.textContent = ''; el.classList.remove('fellback'); return; }
  const engineLabel = rt.engine === 'tier4' ? 'Tier 4'
    : rt.engine === 'python' ? 'Python sidecar'
    : rt.engine === 'cpu_fallback' ? 'CPU fallback'
    : String(rt.engine);
  const parts = [engineLabel];
  if (rt.tts && rt.tts.device) {
    const dev = String(rt.tts.device).toUpperCase();
    parts.push(dev);
    if (rt.tts.dtype) parts.push(String(rt.tts.dtype));
  }
  if (rt.tts && rt.tts.voice) parts.push('voice: ' + String(rt.tts.voice));
  if (rt.tts && typeof rt.tts.speed === 'number') parts.push(rt.tts.speed + 'x');
  if (rt.stt && rt.stt.model) {
    let whisper = 'whisper ' + String(rt.stt.model);
    if (rt.stt.provider && rt.stt.provider !== 'cpu') whisper += '/' + String(rt.stt.provider);
    parts.push(whisper);
  }
  let fellBack = false;
  if (rt.tts && rt.tts.fellBack) fellBack = true;
  if (rt.stt && rt.stt.fellBack) fellBack = true;
  let label = parts.join(' · ');
  if (fellBack) label += ' (cpu fallback)';
  el.textContent = label;
  el.style.display = 'block';
  el.classList.toggle('fellback', fellBack);
}

function updateVoiceUI(state) {
  const mic = document.getElementById('mic-btn'), ind = document.getElementById('voice-indicator');
  if (!mic) return;
  if (state === 'transcribing') {
    mic.className = 'input-btn listening';
    if (ind) { ind.className = 'listening'; ind.textContent = '⚡ TRANSCRIBING...'; }
    return;
  }
  // Dictate mode: keep mic-btn neutral (the dictate-btn pulses cyan via its
  // own .dictating class). Voice indicator shows DICTATING so the user
  // knows the mic is hot but the agent isn't replying.
  if (dictateMode) {
    mic.className = 'input-btn';
    mic.title = 'Voice mode (currently in dictate — click to switch)';
    if (ind) { ind.className = 'listening'; ind.textContent = '✏ DICTATING'; }
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
    const entry = { name: f.name, size: f.size, type: f.type, isImage, url: null, dataUrl: null, _uploadPromise: null };

    // Local preview for images
    if (isImage) {
      const reader = new FileReader();
      reader.onload = () => { entry.dataUrl = reader.result; renderUploadPreviews(); };
      reader.readAsDataURL(f);
    }

    pendingUploads.push(entry);
    renderUploadPreviews();

    // Upload to server in background — track the promise so sendMessage can await it
    const form = new FormData();
    form.append('file', f);
    entry._uploadPromise = (async () => {
      try {
        const res = await apiFetch('/api/upload', { method: 'POST', body: form, headers: {} });
        const data = await res.json();
        if (data.files && data.files[0]) entry.url = data.files[0].url;
      } catch (e) { console.warn('Upload failed:', e); }
    })();
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
  // Studio tier detection: only fetch the cloned-voice library if the
  // Chatterbox sidecar is up. Re-renders the picker once we know.
  refreshClonedVoices();
  // Persistent training-status pill: polls /api/voices/sovits/training/list
  // every 30s. Shows a small indicator near the top of the chat when a
  // pipeline is running so the user knows training is still alive after
  // they navigate away and come back. Auto-hides + refreshes the voice
  // picker when training completes.
  // 10s poll instead of 30s so newly-registered clones (or stalled
  // orchestrators that the user manually nudged) appear in the picker
  // within ~10s, no server restart needed.
  pollTrainingStatus();
  setInterval(pollTrainingStatus, 10000);
}

let _lastTrainingRunCount = 0;
async function pollTrainingStatus() {
  let runs = [];
  try {
    const r = await apiFetch('/api/voices/sovits/training/list');
    if (r.ok) {
      const d = await r.json();
      runs = (d.runs || []).filter(x => x.stage !== 'register');
    }
  } catch { return; }
  // Always refresh the clone list — cheap call (one /tier probe + at most
  // two list calls), and it covers cases the running→idle transition
  // misses (orchestrator died before registering, user added a clone via
  // the manage modal, manual API registration, etc.).
  refreshClonedVoices().then(() => updateStatusBar?.());
  _lastTrainingRunCount = runs.length;

  let pill = document.getElementById('training-pill');
  if (runs.length === 0) {
    if (pill) pill.remove();
    return;
  }
  if (!pill) {
    pill = document.createElement('div');
    pill.id = 'training-pill';
    pill.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:80;padding:6px 14px;border:1px solid #4a9eff;background:rgba(8,18,38,.9);color:#9fdcff;border-radius:18px;font-size:.78rem;font-family:var(--mono,monospace);cursor:pointer;backdrop-filter:blur(6px);box-shadow:0 2px 12px rgba(74,158,255,.3)';
    pill.title = 'Click to open training panel';
    pill.addEventListener('click', () => { if (typeof openTrainVoiceModal === 'function') openTrainVoiceModal(); });
    document.body.appendChild(pill);
  }
  const stageLabels = {
    download: 'downloading', slice: 'slicing', asr: 'transcribing',
    ref: 'picking ref', format: 'extracting features',
    train_sovits: 'training SoVITS', train_gpt: 'training GPT',
  };
  const r0 = runs[0];
  const stage = stageLabels[r0.stage] || r0.stage;
  const more = runs.length > 1 ? ` +${runs.length - 1} more` : '';
  pill.textContent = `🎤 Training ${r0.name} · ${stage}${more}`;
}

async function refreshClonedVoices() {
  try {
    const tierRes = await apiFetch('/api/voices/tier');
    const tier = await tierRes.json();
    window._studioTierReady = !!(tier.chatterbox && tier.chatterbox.ready);
    window._sovitsTierReady = !!(tier.sovits && tier.sovits.ready);
    // SoVITS clones (trained or zero-shot) — best quality when fine-tuned
    if (window._sovitsTierReady) {
      const r = await apiFetch('/api/voices/sovits');
      if (r.ok) {
        const data = await r.json();
        window._sovitsVoices = Array.isArray(data?.clones) ? data.clones : [];
      }
    } else {
      window._sovitsVoices = [];
    }
    // Chatterbox clones (single-stage zero-shot TTS, fallback / parallel)
    if (window._studioTierReady) {
      const r = await apiFetch('/api/voices/chatterbox');
      if (r.ok) {
        const data = await r.json();
        window._chatterboxVoices = Array.isArray(data?.clones) ? data.clones : [];
      }
    } else {
      window._chatterboxVoices = [];
    }
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
  // it changes (or on next session start). Built-in Kokoro voices are
  // always available; custom voice cloning is the optional Studio tier
  // (Chatterbox sidecar at :7010, populated when reachable).
  const savedVoice = localStorage.getItem('lax_voice') || 'am_michael';
  const savedSpeed = parseFloat(localStorage.getItem('lax_speed') || '1.15');
  const voiceGroups = [
    ['American Male', ['am_michael','am_adam','am_echo','am_eric','am_fenrir','am_liam','am_onyx','am_puck']],
    ['American Female', ['af_nicole','af_bella','af_sarah','af_sky','af_heart','af_nova','af_river','af_alloy']],
    ['British Male', ['bm_george','bm_daniel','bm_fable','bm_lewis']],
    ['British Female', ['bf_emma','bf_alice','bf_isabella','bf_lily']],
  ];
  const voiceLabel = (id) => id.split('_')[1].replace(/\b\w/g, c => c.toUpperCase());
  // Cloned voices come from two optional sidecars:
  //   * SoVITS (:7012)     — "sv:<id>"  trained or zero-shot, best quality
  //   * Chatterbox (:7010) — "cb:<id>"  zero-shot, kept as fallback
  // refreshClonedVoices() populates these arrays async on page init; we
  // re-render the bar once they land.
  const svClones = Array.isArray(window._sovitsVoices) ? window._sovitsVoices : [];
  const cbClones = Array.isArray(window._chatterboxVoices) ? window._chatterboxVoices : [];
  const allCloneIds = [
    ...svClones.map(c => 'sv:' + c.id),
    ...cbClones.map(c => 'cb:' + c.id),
  ];
  // If the saved voice references a clone that no longer exists, or uses
  // the legacy "clone:<id>" prefix from the dropped RVC tier, fall back
  // to the default Kokoro voice.
  const isStaleClone = (savedVoice.startsWith('clone:') || savedVoice.startsWith('cb:') || savedVoice.startsWith('sv:'))
    && !allCloneIds.includes(savedVoice);
  const effectiveVoice = isStaleClone ? 'am_michael' : savedVoice;
  if (effectiveVoice !== savedVoice) localStorage.setItem('lax_voice', effectiveVoice);
  let voiceOpts = voiceGroups.map(([group, ids]) =>
    `<optgroup label="${esc(group)}">` +
    ids.map(id => `<option value="${esc(id)}" ${id === effectiveVoice ? 'selected' : ''}>${esc(voiceLabel(id))}</option>`).join('') +
    `</optgroup>`
  ).join('');
  if (svClones.length > 0) {
    voiceOpts += `<optgroup label="My Trained Voices">` +
      svClones.map(c => {
        const tag = c.fine_tuned ? ' ★' : '';
        return `<option value="sv:${esc(c.id)}" ${('sv:' + c.id) === effectiveVoice ? 'selected' : ''}>${esc(c.name)}${tag}</option>`;
      }).join('') +
      `</optgroup>`;
  }
  if (cbClones.length > 0) {
    voiceOpts += `<optgroup label="Zero-shot Cloned Voices">` +
      cbClones.map(c => `<option value="cb:${esc(c.id)}" ${('cb:' + c.id) === effectiveVoice ? 'selected' : ''}>${esc(c.name)}</option>`).join('') +
      `</optgroup>`;
  }
  // Voice management actions: only show if at least one cloning sidecar is reachable.
  if (window._sovitsTierReady || window._studioTierReady) {
    voiceOpts += `<optgroup label=" ">`;
    if (window._sovitsTierReady) {
      voiceOpts += `<option value="__train_voice__">+ Train a new voice (30 min)…</option>`;
    }
    if (window._studioTierReady) {
      voiceOpts += `<option value="__add_chatterbox__">+ Add a quick zero-shot voice…</option>`;
    }
    if (cbClones.length > 0 || svClones.length > 0) {
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
  if (voice === '__manage_clones__' || voice === '__add_chatterbox__' || voice === '__train_voice__') {
    if (voice === '__add_chatterbox__') openAddChatterboxModal();
    else if (voice === '__train_voice__') openTrainVoiceModal();
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


function openTrainVoiceModal() {
  const existing = document.getElementById('train-voice-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'train-voice-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:9999;display:flex;align-items:center;justify-content:center';
  modal.innerHTML = `
    <div style="background:var(--bg,#fff);color:var(--text,#000);border:1px solid var(--border,#ccc);border-radius:10px;padding:22px;max-width:540px;width:94%">
      <h3 style="margin:0 0 6px;font-size:1.1rem">Train a new voice</h3>
      <p style="margin:0 0 14px;color:var(--muted,#666);font-size:.82rem">
        Paste a YouTube URL with at least 20 minutes of one person speaking — clean dialog, minimal music.
        Pipeline runs locally on your GPU: download → slice → transcribe → train SoVITS + GPT → register.
        Wall time on an RTX 3060: <strong>~30-45 min</strong>. You can close this and the training continues server-side.
      </p>
      <div id="tv-incomplete" style="margin-bottom:14px"></div>
      <div style="margin-bottom:10px">
        <label style="display:block;font-size:.78rem;color:var(--muted,#666);margin-bottom:4px">Voice name</label>
        <input id="tv-name" type="text" placeholder="e.g. Optimus Prime" style="width:100%;padding:8px;border:1px solid var(--border,#ccc);border-radius:6px;font-size:.9rem"/>
      </div>
      <div style="margin-bottom:10px">
        <label style="display:block;font-size:.78rem;color:var(--muted,#666);margin-bottom:4px">YouTube URL</label>
        <input id="tv-url" type="url" placeholder="https://youtube.com/watch?v=..." style="width:100%;padding:8px;border:1px solid var(--border,#ccc);border-radius:6px;font-size:.9rem"/>
      </div>
      <label style="display:flex;align-items:center;gap:8px;font-size:.85rem;margin-bottom:12px;cursor:pointer">
        <input id="tv-denoise" type="checkbox" checked style="margin:0"/>
        <span>Source has background music or noise (run vocal isolation; adds ~3-5 min)</span>
      </label>
      <details style="margin-bottom:12px;font-size:.82rem">
        <summary style="cursor:pointer;color:var(--muted,#666)">Advanced</summary>
        <div style="margin-top:8px;display:flex;gap:10px">
          <label style="flex:1">SoVITS epochs<input id="tv-eps-s" type="number" value="8" min="2" max="40" style="width:100%;padding:6px;border:1px solid var(--border,#ccc);border-radius:5px;margin-top:3px"/></label>
          <label style="flex:1">GPT epochs<input id="tv-eps-g" type="number" value="15" min="2" max="40" style="width:100%;padding:6px;border:1px solid var(--border,#ccc);border-radius:5px;margin-top:3px"/></label>
        </div>
      </details>
      <div id="tv-progress" style="display:none;margin:10px 0">
        <div style="display:flex;justify-content:space-between;font-size:.8rem;color:var(--muted,#666);margin-bottom:4px">
          <span id="tv-stage-label">Starting…</span>
          <span id="tv-pct">0%</span>
        </div>
        <div style="height:6px;background:var(--border,#ccc);border-radius:3px;overflow:hidden">
          <div id="tv-bar" style="height:100%;width:0;background:linear-gradient(90deg,#4a9eff,#7ad4ff);transition:width .4s ease"></div>
        </div>
        <div id="tv-log" style="margin-top:8px;font-family:monospace;font-size:.72rem;color:var(--muted,#666);max-height:120px;overflow:auto;padding:6px;background:var(--surface,#f5f5f5);border-radius:5px"></div>
      </div>
      <div id="tv-status" style="font-size:.82rem;color:var(--muted,#666);margin-bottom:10px;min-height:1em"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="tv-cancel" style="padding:7px 14px;border:1px solid var(--border,#ccc);background:transparent;color:var(--text,#000);border-radius:6px;cursor:pointer">Close</button>
        <button id="tv-start" style="padding:7px 14px;border:none;background:#4a9eff;color:#fff;border-radius:6px;cursor:pointer;font-weight:600">Start training</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  const $ = (id) => modal.querySelector('#' + id);
  let aborter = null;

  let listPollTimer = null;
  // Per-row log-tail pollers. Cleared on re-render (otherwise stale rows
  // leak timers) and on close. _openRowExp tracks which rows are expanded
  // so a re-render can re-bind their log viewers.
  const _rowLogTimers = new Map();
  const _openRowExp = new Set();
  const stopAllRowLogTimers = () => {
    for (const t of _rowLogTimers.values()) clearInterval(t);
    _rowLogTimers.clear();
  };
  const close = () => {
    if (aborter) aborter.abort();
    if (listPollTimer) { clearInterval(listPollTimer); listPollTimer = null; }
    stopAllRowLogTimers();
    modal.remove();
  };
  $('tv-cancel').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  // Fetch and render any in-progress runs the user can resume. Re-polls
  // every 5s while the modal is open so the stage advances live (e.g.
  // user sees "format" → "SoVITS training" → "GPT training" without
  // having to close/reopen the modal).
  const fetchAndRender = async () => {
    try {
      const r = await apiFetch('/api/voices/sovits/training/list');
      if (!r.ok) return null;
      const data = await r.json();
      return (data.runs || []).filter(x => x.stage !== 'register');
    } catch { return null; }
  };
  (async () => {
    try {
      const runs = (await fetchAndRender()) || [];
      if (runs.length === 0) return;
      const stageLabels = {
        download: 'Downloading', slice: 'Slicing', asr: 'Transcribing',
        ref: 'Picking reference', format: 'Extracting features',
        train_sovits: 'SoVITS training', train_gpt: 'GPT training',
      };
      const fmtAge = (ms) => {
        const m = Math.floor((Date.now() - ms) / 60000);
        if (m < 60) return m + 'm ago';
        return Math.floor(m / 60) + 'h ago';
      };
      // Pipeline overall % per stage — matches the STAGE markers the
      // orchestrator emits. Used to render a progress bar on each row.
      const stagePct = {
        download: 5, trim: 10, denoise: 15, slice: 20, asr: 35, ref: 50,
        format: 55, train_sovits: 75, train_gpt: 95, register: 100,
      };
      const renderList = () => {
        const items = runs.map(r => {
          // A run whose workdir was touched in the last 90 seconds is almost
          // certainly still training. For those, show a pulsing green
          // "Live" badge and hide Resume so the user can't accidentally
          // spawn a duplicate pipeline.
          const ageMs = Date.now() - r.mtimeMs;
          const isLive = ageMs < 90_000;
          const stageLabel = esc(stageLabels[r.stage] || r.stage);
          const pct = stagePct[r.stage] ?? 0;
          const badge = isLive
            ? `<span style="display:inline-flex;align-items:center;gap:5px;padding:2px 7px;border-radius:10px;background:rgba(40,180,80,.18);color:#3fcf6f;font-size:.7rem;font-weight:600;margin-left:6px"><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#3fcf6f;animation:vsPulse 1.2s ease-in-out infinite"></span>LIVE</span>`
            : '';
          const actions = isLive
            ? `<button data-clear="${esc(r.name)}" title="Force-stop and delete this run" style="padding:5px 8px;border:1px solid var(--border,#ccc);background:transparent;color:var(--muted,#666);border-radius:5px;cursor:pointer;font-size:.95rem;line-height:1" onclick="event.stopPropagation()">×</button>`
            : `<button data-resume="${esc(r.name)}" style="padding:5px 10px;border:1px solid #4a9eff;background:transparent;color:#4a9eff;border-radius:5px;cursor:pointer;font-size:.78rem" onclick="event.stopPropagation()">Resume</button>
               <button data-clear="${esc(r.name)}" title="Delete this training run + free its disk" style="padding:5px 8px;border:1px solid var(--border,#ccc);background:transparent;color:var(--muted,#666);border-radius:5px;cursor:pointer;font-size:.95rem;line-height:1" onclick="event.stopPropagation()">×</button>`;
          const title = r.displayName || r.name;
          const subline = r.displayName
            ? `<span style="font-family:monospace;font-size:.7rem;color:var(--muted,#666);opacity:.7">${esc(r.name)}</span> · at <strong>${stageLabel}</strong> · ${pct}% · last touched ${fmtAge(r.mtimeMs)}`
            : `at <strong>${stageLabel}</strong> · ${pct}% · last touched ${fmtAge(r.mtimeMs)}`;
          return `
            <div data-row="${esc(r.name)}" style="border:1px solid var(--border,#ccc);border-radius:6px;margin-bottom:6px;font-size:.82rem;cursor:pointer;transition:background .15s" title="Click to view live log">
              <div style="display:flex;align-items:center;gap:6px;padding:8px">
                <div style="flex:1;min-width:0">
                  <div style="font-weight:600">${esc(title)}${badge}</div>
                  <div style="color:var(--muted,#666);font-size:.75rem">${subline}</div>
                </div>
                ${actions}
              </div>
              <div style="height:3px;background:var(--border,#eee);border-radius:0 0 5px 5px;overflow:hidden">
                <div style="height:100%;width:${pct}%;background:${isLive ? 'linear-gradient(90deg,#3fcf6f,#7ad4ff)' : 'linear-gradient(90deg,#4a9eff,#7ad4ff)'};transition:width .4s ease"></div>
              </div>
              <div data-log-pane="${esc(r.name)}" style="display:none;border-top:1px solid var(--border,#eee);padding:6px 10px;background:var(--surface,#f8f8f8);font-family:monospace;font-size:.7rem;color:var(--muted,#666);max-height:160px;overflow:auto;white-space:pre-wrap"></div>
            </div>
          `;
        }).join('');
        $('tv-incomplete').innerHTML = runs.length === 0 ? '' : `
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
            <div style="font-size:.78rem;color:var(--muted,#666)">In-progress training (resume to skip work already done):</div>
            <button id="tv-clear-all" style="border:none;background:transparent;color:var(--muted,#666);font-size:.74rem;cursor:pointer;text-decoration:underline">Clear all</button>
          </div>
          ${items}
        `;
        modal.querySelectorAll('[data-resume]').forEach(btn => {
          btn.addEventListener('click', () => {
            const expName = btn.getAttribute('data-resume');
            // Prefer the run's saved display name from _meta.json. If the
            // user typed something in the Voice name field, use that as an
            // override (lets people rename mid-resume if they want). Falls
            // back to a sane default only when both are missing.
            const run = runs.find(x => x.name === expName);
            const typed = $('tv-name').value.trim();
            const name = typed || (run && run.displayName) || expName;
            startTrainingRequest({ name, resumeExpName: expName });
          });
        });

        // Click row → toggle inline log viewer that polls the bridge's
        // /log endpoint every 2s. Lets the user re-attach to live progress
        // for a run they kicked off and walked away from.
        const startRowPoll = async (expName, pane) => {
          let since = 0;
          const poll = async () => {
            try {
              const r = await apiFetch('/api/voices/sovits/training/' + encodeURIComponent(expName) + '/log?since=' + since);
              if (!r.ok) return;
              const d = await r.json();
              if (since === 0) pane.textContent = '';
              if (d.content) {
                pane.textContent += d.content;
                pane.scrollTop = pane.scrollHeight;
              }
              since = d.size || since;
            } catch { /* */ }
          };
          pane.textContent = 'loading…';
          pane.style.display = 'block';
          await poll();
          const timer = setInterval(poll, 2000);
          _rowLogTimers.set(expName, timer);
        };
        modal.querySelectorAll('[data-row]').forEach(row => {
          const expName = row.getAttribute('data-row');
          // If this row was already expanded before the re-render, keep it
          // open and re-bind a fresh poller (the previous timer was cleared
          // by stopAllRowLogTimers on the renderList call).
          const pane = row.querySelector('[data-log-pane]');
          if (_openRowExp.has(expName) && pane) {
            startRowPoll(expName, pane);
          }
          row.addEventListener('click', async () => {
            if (!pane) return;
            if (pane.style.display === 'none' || pane.style.display === '') {
              _openRowExp.add(expName);
              await startRowPoll(expName, pane);
            } else {
              pane.style.display = 'none';
              _openRowExp.delete(expName);
              const t = _rowLogTimers.get(expName);
              if (t) { clearInterval(t); _rowLogTimers.delete(expName); }
            }
          });
        });
        modal.querySelectorAll('[data-clear]').forEach(btn => {
          btn.addEventListener('click', async () => {
            const expName = btn.getAttribute('data-clear');
            if (!confirm(`Delete training run ${expName}? This frees its disk and removes any partial checkpoints.`)) return;
            btn.disabled = true; btn.textContent = '…';
            try {
              const r = await apiFetch('/api/voices/sovits/training/' + encodeURIComponent(expName), { method: 'DELETE' });
              if (!r.ok) throw new Error('HTTP ' + r.status);
              const idx = runs.findIndex(x => x.name === expName);
              if (idx >= 0) runs.splice(idx, 1);
              renderList();
            } catch (e) {
              btn.disabled = false; btn.textContent = '×';
              alert('Delete failed: ' + e.message);
            }
          });
        });
        const clearAllBtn = $('tv-clear-all');
        if (clearAllBtn) clearAllBtn.addEventListener('click', async () => {
          if (!confirm(`Delete ALL ${runs.length} in-progress training runs?`)) return;
          clearAllBtn.disabled = true; clearAllBtn.textContent = 'clearing…';
          for (const r of runs.slice()) {
            try {
              await apiFetch('/api/voices/sovits/training/' + encodeURIComponent(r.name), { method: 'DELETE' });
            } catch { /* */ }
          }
          runs.length = 0;
          renderList();
        });
      };
      renderList();
      // Poll every 5s and refresh the list in place so the stage label
      // advances as training progresses. Stops on modal close. Each
      // re-render clears any open log-tail pollers; renderList rebinds
      // them for rows still in _openRowExp.
      listPollTimer = setInterval(async () => {
        const next = await fetchAndRender();
        if (!next) return;
        runs.length = 0;
        for (const r of next) runs.push(r);
        stopAllRowLogTimers();
        renderList();
      }, 5000);
    } catch { /* */ }
  })();

  async function startTrainingRequest({ name, resumeExpName }) {
    const url = $('tv-url').value.trim();
    const epsS = parseInt($('tv-eps-s').value) || 8;
    const epsG = parseInt($('tv-eps-g').value) || 15;
    if (!name) return ($('tv-status').textContent = 'Voice name required.');
    if (!resumeExpName && !url) return ($('tv-status').textContent = 'YouTube URL required.');
    $('tv-start').style.display = 'none';
    $('tv-incomplete').style.display = 'none';
    $('tv-status').textContent = resumeExpName ? `Resuming ${resumeExpName}…` : 'Submitting…';
    $('tv-progress').style.display = 'block';
    aborter = new AbortController();
    try {
      const body = { name, epochsSovits: epsS, epochsGpt: epsG };
      if (resumeExpName) {
        body.resumeExpName = resumeExpName;
      } else {
        body.sourceUrl = url;
        body.denoise = $('tv-denoise').checked;
      }
      const res = await apiFetch('/api/voices/sovits/train', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: aborter.signal,
      });
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nlnl;
        while ((nlnl = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, nlnl);
          buf = buf.slice(nlnl + 2);
          const ev = block.split('\n').reduce((acc, line) => {
            const m = line.match(/^(event|data):\s?(.*)$/);
            if (m) acc[m[1]] = (acc[m[1]] || '') + m[2];
            return acc;
          }, {});
          if (!ev.event) continue;
          let data = {};
          try { data = JSON.parse(ev.data || '{}'); } catch {}
          handleTrainEvent(ev.event, data);
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        $('tv-status').textContent = 'Failed: ' + e.message;
        $('tv-start').style.display = '';
      }
    }
  }

  $('tv-start').addEventListener('click', () => {
    startTrainingRequest({ name: $('tv-name').value.trim() });
  });

  function handleTrainEvent(event, data) {
    const logEl = $('tv-log');
    if (event === 'stage') {
      $('tv-stage-label').textContent = data.label || data.id;
      $('tv-pct').textContent = (data.pct || 0) + '%';
      $('tv-bar').style.width = (data.pct || 0) + '%';
      const eta = data.etaSec > 0 ? ` (~${Math.ceil(data.etaSec/60)} min)` : '';
      logEl.innerHTML += `<div style="color:#4a9eff">▸ ${esc(data.label || data.id)}${eta}</div>`;
    } else if (event === 'log') {
      const cls = data.stderr ? 'color:#c66' : 'color:var(--muted,#666)';
      logEl.innerHTML += `<div style="${cls}">${esc(data.line || '')}</div>`;
    } else if (event === 'done') {
      $('tv-bar').style.width = '100%';
      $('tv-pct').textContent = '100%';
      $('tv-stage-label').textContent = 'Done';
      $('tv-status').innerHTML = `&#10003; <strong>${esc(data.name)}</strong> trained (${data.elapsed_sec ? Math.ceil(data.elapsed_sec/60) + ' min' : 'ok'}). Refreshing voice picker…`;
      refreshClonedVoices().then(() => updateStatusBar?.());
      $('tv-cancel').textContent = 'Close';
      $('tv-start').style.display = 'none';
    } else if (event === 'error') {
      $('tv-status').textContent = '⚠ ' + (data.message || 'training failed');
      $('tv-start').style.display = '';
    }
    logEl.scrollTop = logEl.scrollHeight;
  }
}

function openAddChatterboxModal() {
  const existing = document.getElementById('add-chatterbox-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'add-chatterbox-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:center;justify-content:center';
  modal.innerHTML = `
    <div style="background:var(--bg, #fff);color:var(--text, #000);border:1px solid var(--border, #ccc);border-radius:10px;padding:24px;max-width:480px;width:92%">
      <h3 style="margin:0 0 6px;font-size:1.1rem">Add a Chatterbox voice</h3>
      <p style="margin:0 0 14px;color:var(--muted, #666);font-size:.83rem">Upload a clean 10-30s WAV/MP3 of one person speaking. Chatterbox clones the voice in real time — no training step needed. Local-only, nothing leaves this machine.</p>
      <div style="margin-bottom:12px">
        <label style="display:block;font-size:.78rem;color:var(--muted, #666);margin-bottom:4px">Voice name</label>
        <input id="acb-name" type="text" placeholder="My Voice" style="width:100%;padding:8px;border:1px solid var(--border, #ccc);border-radius:6px;font-size:.9rem"/>
      </div>
      <div style="margin-bottom:14px">
        <label style="display:block;font-size:.78rem;color:var(--muted, #666);margin-bottom:4px">Reference audio (10-30s recommended)</label>
        <input id="acb-file" type="file" accept="audio/*" style="width:100%;font-size:.85rem"/>
      </div>
      <div id="acb-status" style="font-size:.8rem;color:var(--muted, #666);margin-bottom:12px;min-height:1em"></div>
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button id="acb-cancel" type="button" style="padding:8px 14px;border:1px solid var(--border, #ccc);background:transparent;color:var(--text, #000);border-radius:6px;cursor:pointer">Cancel</button>
        <button id="acb-upload" type="button" style="padding:8px 14px;border:none;background:#3498db;color:#fff;border-radius:6px;cursor:pointer">Upload &amp; install</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  document.getElementById('acb-cancel').onclick = () => modal.remove();

  const status = document.getElementById('acb-status');
  const setStatus = (msg, isError) => { status.textContent = msg; status.style.color = isError ? '#c0392b' : 'var(--muted, #666)'; };

  document.getElementById('acb-upload').onclick = async () => {
    const name = (document.getElementById('acb-name').value || '').trim() || 'My Voice';
    const file = document.getElementById('acb-file').files[0];
    if (!file) { setStatus('Pick an audio file first.', true); return; }
    if (file.size > 18 * 1024 * 1024) { setStatus('File too big (max ~18MB).', true); return; }
    setStatus('Uploading…', false);
    try {
      const arrayBuf = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuf);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
      }
      const b64 = btoa(binary);
      const r = await apiFetch('/api/voices/chatterbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, audio_b64: b64 }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { setStatus('Failed: ' + (data.error || data.detail || ('HTTP ' + r.status)), true); return; }
      setStatus(`✓ Installed "${data.name || name}". Selected as your voice.`, false);
      await refreshClonedVoices();
      // Auto-select the new voice
      const newId = 'cb:' + data.id;
      localStorage.setItem('lax_voice', newId);
      const sel = document.getElementById('voice-quick-select');
      if (sel) sel.value = newId;
      quickSwitchVoice(newId);
      // Replace the upload button with a clear "next step" prompt so the
      // user knows exactly what to do, instead of the modal vanishing.
      const cancelBtn = document.getElementById('acb-cancel');
      const uploadBtn = document.getElementById('acb-upload');
      if (uploadBtn) uploadBtn.style.display = 'none';
      if (cancelBtn) {
        cancelBtn.textContent = 'Got it — close this';
        cancelBtn.style.background = '#27ae60';
        cancelBtn.style.color = '#fff';
        cancelBtn.style.border = 'none';
      }
      setStatus(`✓ Installed "${data.name || name}". Close this, click the mic button, and speak.`, false);
    } catch (e) { setStatus('Failed: ' + e.message, true); }
  };
}

function openManageClonesModal() {
  const existing = document.getElementById('manage-clones-modal');
  if (existing) existing.remove();

  // Show clones from both providers — sovits (trained ★) first, then
  // chatterbox (zero-shot). Each row is tagged with its provider so the
  // rename/delete buttons hit the right /api/voices/<provider>/ endpoint.
  const sv = (Array.isArray(window._sovitsVoices) ? window._sovitsVoices : [])
    .map(c => ({ ...c, provider: 'sovits' }));
  const cb = (Array.isArray(window._chatterboxVoices) ? window._chatterboxVoices : [])
    .map(c => ({ ...c, provider: 'chatterbox' }));
  const all = [...sv, ...cb];

  const renderRow = (c) => {
    const tag = c.provider === 'sovits'
      ? (c.fine_tuned ? '<span style="font-size:.7rem;color:#3fcf6f">★ trained</span>' : '<span style="font-size:.7rem;color:#9ed3ff">zero-shot</span>')
      : '<span style="font-size:.7rem;color:#9ed3ff">chatterbox</span>';
    return `
      <div class="mc-row" data-id="${esc(c.id)}" data-provider="${esc(c.provider)}" data-name="${esc(c.name)}" style="display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--border, #eee)">
        <div style="flex:1;min-width:0">
          <div class="mc-name" style="font-size:.88rem">${esc(c.name)}</div>
          <div style="font-size:.7rem;color:var(--muted,#666);margin-top:2px;font-family:var(--mono)">${esc(c.id)} · ${tag}</div>
        </div>
        <button class="mc-rename" type="button" title="Rename" style="padding:6px 10px;border:1px solid #4a9eff;background:transparent;color:#4a9eff;border-radius:6px;cursor:pointer;font-size:.78rem">Rename</button>
        <button class="mc-delete" type="button" title="Delete" style="padding:6px 10px;border:none;background:#e74c3c;color:#fff;border-radius:6px;cursor:pointer;font-size:.78rem">Delete</button>
      </div>`;
  };
  const rows = all.length === 0
    ? `<div style="padding:16px;color:var(--muted, #666);font-size:.85rem;text-align:center">No cloned voices installed.</div>`
    : all.map(renderRow).join('');

  const modal = document.createElement('div');
  modal.id = 'manage-clones-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:center;justify-content:center';
  modal.innerHTML = `
    <div style="background:var(--bg, #fff);color:var(--text, #000);border:1px solid var(--border, #ccc);border-radius:10px;padding:0;max-width:520px;width:94%;max-height:80vh;display:flex;flex-direction:column">
      <div style="padding:14px 18px;border-bottom:1px solid var(--border, #eee)">
        <h3 style="margin:0;font-size:1.05rem">Manage cloned voices</h3>
        <p style="margin:4px 0 0;color:var(--muted, #666);font-size:.78rem">Rename or remove cloned voices. Delete frees the voice's model files from disk.</p>
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

  modal.querySelectorAll('.mc-rename').forEach(btn => {
    btn.onclick = async () => {
      const row = btn.closest('.mc-row');
      const id = row.dataset.id;
      const provider = row.dataset.provider;
      // Use the dataset attribute (single source of truth) instead of
      // reading textContent — the row container has TWO inner divs (name +
      // id badge) and querying the first child grabbed both, which is how
      // a previous rename ended up with garbage like "Jarvis* (trained)\n
      // 69970259a38c · ★ trained" stored as the name.
      const currentName = row.dataset.name || '';
      const next = prompt('New name for "' + currentName + '":', currentName);
      if (next === null) return;
      const trimmed = next.trim();
      if (!trimmed || trimmed === currentName) return;
      btn.disabled = true; statusEl.textContent = 'Renaming…'; statusEl.style.color = 'var(--muted,#666)';
      try {
        const r = await apiFetch('/api/voices/' + provider + '/' + encodeURIComponent(id), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: trimmed }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) { statusEl.textContent = 'Failed: ' + (data.error || ('HTTP ' + r.status)); statusEl.style.color = '#c0392b'; btn.disabled = false; return; }
        row.querySelector('.mc-name').textContent = trimmed;
        row.dataset.name = trimmed;
        await refreshClonedVoices();
        if (typeof updateStatusBar === 'function') updateStatusBar();
        statusEl.textContent = `Renamed to "${trimmed}".`;
        btn.disabled = false;
      } catch (e) {
        statusEl.textContent = 'Failed: ' + e.message; statusEl.style.color = '#c0392b';
        btn.disabled = false;
      }
    };
  });

  modal.querySelectorAll('.mc-delete').forEach(btn => {
    btn.onclick = async () => {
      const row = btn.closest('.mc-row');
      const id = row.dataset.id;
      const provider = row.dataset.provider;
      if (!confirm(`Delete this voice? Removes its model files from disk. (${id})`)) return;
      btn.disabled = true; statusEl.textContent = 'Deleting…'; statusEl.style.color = 'var(--muted, #666)';
      try {
        const r = await apiFetch('/api/voices/' + provider + '/' + encodeURIComponent(id), { method: 'DELETE' });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) { statusEl.textContent = 'Failed: ' + (data.error || ('HTTP ' + r.status)); statusEl.style.color = '#c0392b'; btn.disabled = false; return; }
        row.remove();
        const fullId = (provider === 'sovits' ? 'sv:' : 'cb:') + id;
        if (localStorage.getItem('lax_voice') === fullId) {
          localStorage.setItem('lax_voice', 'am_michael');
        }
        await refreshClonedVoices();
        if (typeof updateStatusBar === 'function') updateStatusBar();
        statusEl.textContent = `Deleted.`;
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
    // Re-render the control buttons. Without this, hitting Pause flipped the
    // status text to "paused" but the button stayed as "Pause" forever
    // (visible in the screenshot — top card showed status PAUSED but the
    // button row still read PAUSE / REDIRECT / CANCEL). Re-rendering the
    // controls section based on the new status flips Pause → Resume and
    // back. Output area and scroll position are left untouched.
    var controlsEl = card.querySelector('.agent-feed-controls');
    if (controlsEl) {
      var safeId = esc(agentId);
      var isPaused = existing.status === 'paused';
      controlsEl.innerHTML =
        (isPaused
          ? '<button class="agent-ctrl-btn" onclick="onAgentResume(\'' + safeId + '\')">Resume</button>'
          : '<button class="agent-ctrl-btn" onclick="onAgentPause(\'' + safeId + '\')">Pause</button>') +
        '<button class="agent-ctrl-btn" onclick="onAgentRedirect(\'' + safeId + '\')">Redirect</button>' +
        '<button class="agent-ctrl-btn cancel" onclick="onAgentCancel(\'' + safeId + '\')">Cancel</button>';
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
      '<button class="agent-feed-dismiss" title="Dismiss card (does not cancel)" onclick="onAgentDismiss(\'' + safeId + '\')">×</button>' +
    '</div>' +
    '<div class="agent-feed-output">' + esc(output) + '</div>' +
    '<div class="agent-feed-controls">' +
      (isPaused
        ? '<button class="agent-ctrl-btn" onclick="onAgentResume(\'' + safeId + '\')">Resume</button>'
        : '<button class="agent-ctrl-btn" onclick="onAgentPause(\'' + safeId + '\')">Pause</button>') +
      '<button class="agent-ctrl-btn" onclick="onAgentRedirect(\'' + safeId + '\')">Redirect</button>' +
      // Stay inline: kills the worker, marks the auto-delegate decision as a
      // user-override (training signal), re-submits the original message
      // with /discuss prefix so this exact text bypasses auto-delegate.
      // 404s gracefully for non-auto-delegate ops (autopilot, self_edit) —
      // the button is harmless on cards that aren't auto-delegate spawns.
      '<button class="agent-ctrl-btn" title="This should have been a chat reply, not a worker. Kills this op and re-asks inline." onclick="onAgentStayInline(\'' + safeId + '\')">Stay inline</button>' +
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
  // Backend route by id prefix: op_* → worker pool (real semantics
  // pending Step 7); agent-* → legacy Handler. UI flips to "paused"
  // either way so the button toggles to Resume. For worker-pool ops,
  // pause is best-effort tonight — the worker doesn't actually halt
  // mid-LLM-call yet (Step 7 polish wires the agent-loop iteration
  // boundary to honor pause/resume properly).
  var payload = { type: 'agent-control', agentId: agentId, action: 'pause' };
  if (chatWs && chatWs.readyState === WebSocket.OPEN) {
    chatWs.send(JSON.stringify(payload));
  }
  // Status MUST be exactly 'paused' so renderAgentCard's
  // `isPaused = status === 'paused'` swaps the button to Resume.
  // Previously this was 'waiting' which never matched and the button
  // stayed stuck on Pause forever.
  updateAgentFeed(agentId, { status: 'paused' });
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
  // Mark as cancelled and remove. Backend (chat-ws.ts) routes by id
  // prefix: op_* → killOp (real worker subprocess kill); agent-* →
  // legacy Handler.cancelAgent. Either way the worker dies, no more
  // bg_op_progress events fire, the card stays gone (was respawning
  // when cancel routed to Handler for op_* ids — handler ignored,
  // worker kept running, progress events kept re-rendering the card).
  updateAgentFeed(agentId, { status: 'cancelled' });
  setTimeout(function() { removeAgentFeed(agentId); }, 1500);
}

// User clicked "Stay inline" — POST to /api/auto-delegate/override which
// kills the op + tags the decision as a user-correction (training signal)
// + returns the original message so we can re-submit with /discuss prefix.
// The next time the user types this exact message it'll bypass auto-delegate.
async function onAgentStayInline(agentId) {
  try {
    const r = await apiPost('/api/auto-delegate/override', { opId: agentId });
    const data = await r.json();
    updateAgentFeed(agentId, { status: 'overridden — re-asking inline' });
    setTimeout(function() { removeAgentFeed(agentId); }, 1500);
    if (data && data.message) {
      // Resubmit with /discuss prefix so the next pass forces inline.
      // Goes through sendMessage so the chat thread shows the user message
      // again (Whisper re-render isn't necessary; this is a re-attempt).
      const ta = document.getElementById('msg-input');
      if (ta) {
        ta.value = '/discuss ' + data.message;
        try { sendMessage(); } catch (e) { console.warn('[stay-inline] resubmit failed:', e); }
      }
    } else {
      console.info('[stay-inline] no message to resubmit (op was not auto-delegated)');
    }
  } catch (e) {
    console.warn('[stay-inline] override failed:', e);
  }
}

function onAgentDismiss(agentId) {
  // Pure UI hide — does NOT cancel/kill the underlying op. For removing
  // completed or stale cards that the auto-prune timer hasn't gotten to
  // yet, or for de-cluttering the sidebar without touching live work.
  // Use Cancel (X-shaped circle) if you want the worker actually killed.
  removeAgentFeed(agentId);
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
