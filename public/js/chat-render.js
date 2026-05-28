// ── Chat: Rendering (renderMessages + stream renderers + auto-scroll) ──
//
// The DOM-rendering side of the chat thread:
//   - autoScroll                  — single source of truth for "should I scroll to bottom?"
//   - renderStreamContent         — rAF-batched markdown render for incoming deltas
//   - stripAgentScratchwork       — removes inline plan/scratch from agent text
//   - renderMessage               — per-message DOM builder (one of: user, worker,
//                                   finalized assistant, live synth from store).
//                                   Takes ctx.parent for the synth case so the rerender
//                                   path can build into a detached fragment.
//   - renderMessages              — full DOM rebuild loop over renderMessage
//   - rerenderLiveMessage         — rAF-batched in-place swap of the live bubble
//                                   from store state (no #messages wipe)
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

// Per-session pointer to the live .msg.assistant DOM node — the bubble that
// rerenderLiveMessage swaps out on each WS event. Populated by the renderMessages
// loop (when it synthesizes the live row) and by rerenderLiveMessage (after swap).
// renderMessages wipes #messages then re-populates inside the loop, so we clear
// at the top.
const _liveMessageNodes = new Map();      // sessionId → .msg.assistant element
// Per-session rAF token so multiple rapid WS events coalesce into one swap
// per frame. The latest store state is read at flush time.
const _rerenderRafs = new Map();          // sessionId → rAF token

// Build the in-flight assistant bubble from ChatStreamStore state into `parent`.
// `parent` is either the live #messages container (renderMessages full-render)
// or a detached div (rerenderLiveMessage swap path). No global side effects —
// no Spring fade, no autoScroll, no pin-bottom migration. The caller handles
// post-build framing.
//
// Mirrors the DOM shape addMessageEl produces for an assistant message plus
// the streaming-class + thinking-dots + tool-card routing that the per-event
// dispatcher (chat-ws-handler-chat-events.js) writes into the same bubble.
function _buildLiveAssistantInto(parent, store) {
  if (!parent) return null;
  const content = store ? (store.content || '') : '';
  const bodyContent = mdPreviewMode ? md(content) : `<pre class="raw-md">${esc(content)}</pre>`;
  const div = document.createElement('div');
  div.className = 'msg assistant';
  div.setAttribute('role', 'article');
  div.setAttribute('aria-label', 'Assistant message');
  div.innerHTML = `<div class="msg-label">Assistant</div><div class="msg-body streaming">${bodyContent}</div><div class="msg-footer"></div>`;
  parent.appendChild(div);
  const bodyEl = div.querySelector('.msg-body');
  // Pre-delta render: thinking dots so the chat doesn't look frozen until
  // the first token lands. Mirrors the manual bubble sendMessage creates.
  if (bodyEl && !content) {
    bodyEl.innerHTML = '<div class="thinking"><span>.</span><span>.</span><span>.</span></div>';
  }
  const toolEvents = store ? (store.toolEvents || []) : [];
  if (toolEvents.length > 0) {
    const cardHost = bodyEl || div;
    try {
      for (const te of toolEvents) {
        if (te.type !== 'start') continue;
        // Route through appendToolCardGrouped so the swap matches the
        // per-event paint path: cards land inside the collapsible
        // "Agent activity" group, consecutive same-tool calls collapse
        // into a single ×N card.
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
  return div;
}

// Render one row from activeChat.messages[] (or the synthetic live row from
// store). Returns the appended DOM node, or null. Appends to #messages by
// default; ctx.parent overrides for the synth case so rerenderLiveMessage can
// build into a detached fragment.
//
// ctx: {
//   parent?:     HTMLElement  // override append target (synth case only)
//   isLiveSynth?: boolean     // render the live row from ctx.store
//   store?:      object       // ChatStreamStore entry (synth case)
// }
function renderMessage(msg, ctx) {
  ctx = ctx || {};
  if (ctx.isLiveSynth) {
    const parent = ctx.parent || document.getElementById('messages');
    return _buildLiveAssistantInto(parent, ctx.store);
  }
  if (!msg) return null;
  if (msg.role === 'user') {
    const displayText = msg.attachments ? msg.content.replace(/^Attached files:\n[\s\S]*?\n\n/, '') : msg.content;
    const userEl = addMessageEl('user', displayText, msg.attachments, msg.timestamp);
    // Pending mid-turn inject: dim the bubble until the server's
    // inject_consumed event drops _queueState. See chat-send.js inject
    // path + chat-ws-handler.js inject_consumed branch.
    if (userEl && msg._queueState === 'queued') userEl.classList.add('queued');
    return userEl;
  }
  if (msg.role === 'assistant' && msg._worker) {
    // Persisted worker bubble — render with the same styling as a live
    // worker_stream bubble, just static. Skip the regular assistant
    // path so the agent's pin-bottom and tool-card logic doesn't apply.
    return appendStaticWorkerBubble(msg._opId, msg.content || '', msg._taskHint, msg._workerStatus);
  }
  if (msg.role === 'assistant' && (msg.content || msg._tools)) {
    const node = addMessageEl('assistant', msg.content || '', null, msg.timestamp);
    if (msg._tools && msg._tools.length > 0) {
      const lastBody = node ? node.querySelector('.msg-body') : null;
      const cardHost = lastBody || node;
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
    return node;
  }
  return null;
}

// rAF-batched swap of the live assistant bubble from ChatStreamStore state.
// Called from dispatchChatStreamEvent after applyEvent so the bubble always
// reflects the latest store snapshot. Multiple events in one frame coalesce
// into a single swap.
//
// Off-screen sessions, post-done events, and missing live nodes are no-ops —
// renderMessages will catch up on next full render.
function rerenderLiveMessage(sessionId) {
  if (!sessionId) return;
  if (!activeChat || activeChat.id !== sessionId) return;
  if (!ChatStreamStore.isStreaming(sessionId)) return;
  if (_rerenderRafs.has(sessionId)) return;
  const token = requestAnimationFrame(() => {
    _rerenderRafs.delete(sessionId);
    // Re-check conditions at flush time — chat switch / done can have
    // landed between queue and flush.
    if (!activeChat || activeChat.id !== sessionId) return;
    if (!ChatStreamStore.isStreaming(sessionId)) return;
    const store = ChatStreamStore.get(sessionId);
    if (!store) return;
    let oldNode = _liveMessageNodes.get(sessionId);
    if (!oldNode || !document.contains(oldNode)) {
      // Fallback: the manual bubble sendMessage created (before any
      // renderMessages run captured it into _liveMessageNodes).
      const messagesEl = document.getElementById('messages');
      if (messagesEl) {
        const all = messagesEl.querySelectorAll('.msg.assistant');
        oldNode = all[all.length - 1] || null;
      }
    }
    if (!oldNode) return;
    // Phase 2 guard: skip the swap when the bubble carries DOM the store
    // can't reconstruct. tool_chip / tool_progress / approval_requested /
    // stopped paint surgically into bodyEl but the store doesn't track
    // them — rebuilding from store would silently drop chips, approval
    // cards, progress bars, and stop notices. Phase 3 extends the store
    // and deletes those surgical ops, at which point this guard becomes
    // unnecessary and goes away.
    if (oldNode.querySelector('.tool-chip, .approval-card, .stop-notice, .tool-progress-bar, .tool-progress-text, .agent-inline-card')) return;
    const tmp = document.createElement('div');
    const fresh = renderMessage(null, { parent: tmp, isLiveSynth: true, store });
    if (!fresh) return;
    oldNode.replaceWith(fresh);
    _liveMessageNodes.set(sessionId, fresh);
    autoScroll();
  });
  _rerenderRafs.set(sessionId, token);
}

function renderMessages() {
  const el = document.getElementById('messages');
  if (!el) return;
  if (!activeChat || activeChat.messages.length === 0) {
    el.innerHTML = `<div id="empty"><img src="/hero.jpg" alt="Local Agent X" class="hero-img hero-dark" /><img src="/hero-light.png" alt="Local Agent X" class="hero-img hero-light" /><h2>LOCAL AGENT X</h2><p>${activeChat ? 'Start your conversation below.' : 'Select a chat or start a new one.'}</p></div>`;
    _liveMessageNodes.clear();
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

  // The Map points at DOM nodes we're about to wipe; clear and let the loop
  // re-populate it when it renders the synth row.
  _liveMessageNodes.clear();
  el.innerHTML = '';
  for (let i = 0; i < activeChat.messages.length; i++) {
    if (i === anchor) {
      const liveNode = renderMessage(null, { parent: el, isLiveSynth: true, store });
      if (liveNode) _liveMessageNodes.set(activeChat.id, liveNode);
    }
    renderMessage(activeChat.messages[i], { parent: el });
  }
  // Anchor at end-of-array — live row goes after every persisted row.
  if (streaming && store && anchor === activeChat.messages.length) {
    const liveNode = renderMessage(null, { parent: el, isLiveSynth: true, store });
    if (liveNode) _liveMessageNodes.set(activeChat.id, liveNode);
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

