// ── Chat: Rendering (renderMessages + stream renderers + auto-scroll) ──
//
// The DOM-rendering side of the chat thread:
//   - autoScroll                  — single source of truth for "should I scroll to bottom?"
//   - renderStreamContent         — rAF-batched markdown render for incoming deltas
//   - stripAgentScratchwork       — removes inline plan/scratch from agent text
//   - renderLiveAssistantFromStore — synthesizes the in-flight assistant bubble at the
//                                   store's anchor (Phase 1: live row is NOT in messages[])
//   - renderMessages              — full DOM rebuild from activeChat.messages + live anchor
//
// Extracted from chat.js as part of the 400-LOC god-file split.
//
// External deps from chat.js / shared.js:
//   - apiFetch, esc, md, normalizeMd, _fixMd  (shared.js)
//   - activeChat, saveChats                   (app.js)
//   - pendingUploads, userScrolledUp          (chat.js — closure-bound at call time)
//   - ChatStreamStore                          (chat-stream-store.js — per-session stream state)
//   - addMessageEl, appendStaticWorkerBubble, appendToolCardGrouped
//                                             (chat-helpers.js / chat-tool-cards.js — auto-window)

function autoScroll() {
  // ChatGPT-style: during an active streaming turn we DO NOT auto-scroll.
  // The user message was scrolled to the top of the viewport at send time,
  // and the assistant placeholder reserves viewport-height of room below
  // (see .pin-bottom). The response fills that space; the reader controls
  // scroll afterward. Per-session: another chat streaming (IDE while user
  // views main) must not suppress main's auto-scroll.
  if (typeof window.activeChat !== 'undefined' && window.activeChat && ChatStreamStore.isStreaming(window.activeChat.id)) return;
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
  // [stream-debug] TEMP — capture queue→flush latency. If this gap is small
  // (<100ms) but the user perceives lag, the bottleneck is upstream (events
  // arriving in bursts). If it's large, the renderer is the bottleneck.
  const queuedAt = Date.now();
  pending.raf = requestAnimationFrame(() => {
    pending.raf = 0;
    const flushedAt = Date.now();
    const bodyConnected = bodyEl ? document.contains(bodyEl) : 'no-bodyEl';
    console.log(`[stream-debug] rAF-flush gap=${flushedAt - queuedAt}ms bodyConnected=${bodyConnected} latestLen=${(pending.latest||'').length}`);
    // Preserve activity-groups + top-level tool-cards/approval-cards across
    // the markdown re-render. Without preserving the groups, every stream
    // delta would wipe the consolidated activity container.
    const existingGroups = bodyEl.querySelectorAll('.activity-group');
    const orphanCards = bodyEl.querySelectorAll(':scope > .tool-card, :scope > .approval-card');
    const mediaPreviews = bodyEl.querySelectorAll(':scope > .tool-media-preview');
    // Strip inline plans — the agent's "Plan: 1) X, 2) Y" bullet is for
    // its own reasoning, not for the user's eyes. We remove it before render
    // so the visible bubble just shows the final answer, not the scratchwork.
    const stripped = stripAgentScratchwork(pending.latest);
    bodyEl.innerHTML = stripped ? md(stripped) : '';
    // Re-attach media previews FIRST so they sit above the activity group.
    mediaPreviews.forEach(m => bodyEl.appendChild(m));
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

// Paint the in-flight assistant bubble directly from ChatStreamStore at the
// position the iteration is currently at. Phase 1: the live row is NOT in
// activeChat.messages[] during a turn — it exists only here, in the store —
// so renderMessages synthesizes it from store state at liveAnchorIndex.
//
// `el` is the #messages container. Mirrors the same DOM shape the per-event
// dispatcher (chat-ws-handler-chat-events.js) writes into: assistant bubble
// with .msg-body.streaming, thinking dots when no content yet, then tool
// cards routed through appendToolCardGrouped (same collapsing/×N behaviour
// as the live-stream path).
function renderLiveAssistantFromStore(store, el) {
  addMessageEl('assistant', store.content || '', null);
  const allMsgs = el.querySelectorAll('.msg.assistant');
  const lastMsgEl = allMsgs[allMsgs.length - 1];
  const lastBody = lastMsgEl ? lastMsgEl.querySelector('.msg-body') : null;
  if (lastBody) {
    lastBody.classList.add('streaming');
    // Pre-delta render: paint thinking dots so the chat doesn't look frozen
    // until the first token lands. Without this, a renderMessages rebuild
    // mid-stream-before-first-token wipes the indicator.
    if (!store.content) lastBody.innerHTML = '<div class="thinking"><span>.</span><span>.</span><span>.</span></div>';
  }
  const toolEvents = store.toolEvents || [];
  if (toolEvents.length > 0) {
    const cardHost = lastBody || lastMsgEl;
    if (cardHost) {
      try {
        for (const te of toolEvents) {
          if (te.type !== 'start') continue;
          const card = appendToolCardGrouped(cardHost, te.name, te.args || '', te.riskLevel);
          const endEvt = toolEvents.find(t => t.type === 'end' && t.name === te.name);
          if (endEvt) {
            card.querySelector('.indicator').className = 'indicator ' + (endEvt.allowed ? 'allowed' : 'blocked');
            card.querySelector('.tool-detail').textContent = (endEvt.result || '').slice(0, 200) || '✓ Done';
            attachMediaPreview(card, te.name, endEvt.result || '');
          }
        }
      } catch (toolRenderErr) { console.error('[chat] live tool card render error:', toolRenderErr); }
    }
  }
}

function renderMessages() {
  const el = document.getElementById('messages');
  if (!el) return;
  if (!activeChat || activeChat.messages.length === 0) {
    el.innerHTML = `<div id="empty"><img src="/hero.jpg" alt="Local Agent X" class="hero-img hero-dark" /><img src="/hero-light.png" alt="Local Agent X" class="hero-img hero-light" /><h2>LOCAL AGENT X</h2><p>${activeChat ? 'Start your conversation below.' : 'Select a chat or start a new one.'}</p></div>`;
    return;
  }

  // The live (in-flight) assistant row is NOT in activeChat.messages[]
  // during a turn — it lives only in ChatStreamStore. Synthesize it at
  // the captured anchor; the iteration places it between the persisted
  // rows at the right slot.
  const store = ChatStreamStore.get(activeChat.id);
  const streaming = ChatStreamStore.isStreaming(activeChat.id);
  const anchor = (streaming && store && store.liveAnchorIndex >= 0)
                 ? store.liveAnchorIndex : -1;

  el.innerHTML = '';
  for (let i = 0; i < activeChat.messages.length; i++) {
    if (i === anchor) renderLiveAssistantFromStore(store, el);
    const msg = activeChat.messages[i];
    if (msg.role === 'user') {
      const displayText = msg.attachments ? msg.content.replace(/^Attached files:\n[\s\S]*?\n\n/, '') : msg.content;
      const userEl = addMessageEl('user', displayText, msg.attachments, msg.timestamp);
      // Pending mid-turn inject: dim the bubble until the server's
      // inject_consumed event drops _queueState. See chat-send.js inject
      // path + chat-ws-handler.js inject_consumed branch.
      if (userEl && msg._queueState === 'queued') userEl.classList.add('queued');
    } else if (msg.role === 'assistant' && msg._worker) {
      // Persisted worker bubble — render with the same styling as a live
      // worker_stream bubble, just static. Skip the regular assistant
      // path so the agent's pin-bottom and tool-card logic doesn't apply.
      appendStaticWorkerBubble(msg._opId, msg.content || '', msg._taskHint, msg._workerStatus);
    } else if (msg.role === 'assistant' && (msg.content || msg._tools)) {
      addMessageEl('assistant', msg.content || '', null, msg.timestamp);
      if (msg._tools && msg._tools.length > 0) {
        const allMsgsT = el.querySelectorAll('.msg.assistant');
        const lastMsgElT = allMsgsT[allMsgsT.length - 1];
        const lastBody = lastMsgElT ? lastMsgElT.querySelector('.msg-body') : null;
        const cardHost = lastBody || lastMsgElT;
        if (cardHost) {
          try {
            for (const te of msg._tools) {
              if (te.type !== 'start') continue;
              // Route through appendToolCardGrouped so re-render matches
              // the live-stream path: cards land inside the collapsible
              // "Agent activity" group, and consecutive same-tool calls
              // collapse into a single ×N card.
              const card = appendToolCardGrouped(cardHost, te.name, te.args || '', te.riskLevel);
              const endEvt = msg._tools.find(t => t.type === 'end' && t.name === te.name);
              if (endEvt) {
                card.querySelector('.indicator').className = 'indicator ' + (endEvt.allowed ? 'allowed' : 'blocked');
                card.querySelector('.tool-detail').textContent = (endEvt.result || '').slice(0, 200) || '✓ Done';
                attachMediaPreview(card, te.name, endEvt.result || '');
              }
            }
          } catch (toolRenderErr) { console.error('[chat] tool card render error:', toolRenderErr); }
        }
      }
    }
  }
  // Anchor at end-of-array — live row goes after every persisted row.
  if (streaming && store && anchor === activeChat.messages.length) {
    renderLiveAssistantFromStore(store, el);
  }
  // Pin the latest assistant message so it carries the reserved viewport-
  // height of room below it (ChatGPT-style). When navigating to an existing
  // chat, this gives the most recent reply that breathing room without any
  // active stream. Strip the pin from every other assistant first — without
  // this, a sequence of renderMessages() calls (e.g. bg_op_nudge after a
  // worker finishes) would leave pin-bottom on every prior assistant and
  // stack ~100vh of reserved space between every pair of replies.
  const allAssistant = el.querySelectorAll('.msg.assistant');
  allAssistant.forEach(m => m.classList.remove('pin-bottom'));
  const lastAssistant = allAssistant[allAssistant.length - 1];
  if (lastAssistant) {
    // Only reserve viewport-height under the last assistant when it's
    // also the last message overall. If a user message follows it (e.g.
    // mid-stream inject — Step 4 interject path), the reserved space
    // pads an empty assistant body and pushes the inject to the bottom
    // of the viewport with a gap above. With this guard the inject
    // appears flush under the assistant's existing content.
    const allMsgs = el.querySelectorAll('.msg');
    if (allMsgs[allMsgs.length - 1] === lastAssistant) {
      lastAssistant.classList.add('pin-bottom');
    }
  }
  // Defer one frame so the browser applies pin-bottom's min-height before we
  // read scrollHeight — otherwise scrollHeight reflects the pre-pin layout
  // and the scroll lands at the top instead of past the reserved padding,
  // leaving the chat flush at the top of the viewport on re-entry.
  requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
}

