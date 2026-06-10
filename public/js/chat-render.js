// ── Chat: Rendering (renderMessages + auto-scroll) ──
//
// The DOM-rendering side of the chat thread:
//   - autoScroll                  — single source of truth for "should I scroll to bottom?"
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

// _buildLiveAssistantInto, _updateActivityOutcome, _renderAssistantToolArtifacts
// live in chat-render-artifacts.js (must load before this file). They build the
// in-flight assistant bubble and its tool-card/chip/progress/approval artifacts.

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
    // path + chat-ws-handler.js inject_consumed branch. The injectId stamp
    // lets inject_consumed un-dim this exact node in place instead of
    // rebuilding the whole thread.
    if (userEl && msg._injectId) userEl.dataset.injectId = msg._injectId;
    if (userEl && msg._queueState === 'queued') userEl.classList.add('queued');
    return userEl;
  }
  if (msg.role === 'assistant' && msg._worker) {
    // Persisted worker bubble — render with the same styling as a live
    // worker_stream bubble, just static. Skip the regular assistant
    // path so the agent's pin-bottom and tool-card logic doesn't apply.
    return appendStaticWorkerBubble(msg._opId, msg.content || '', msg._taskHint, msg._workerStatus);
  }
  if (msg.role === 'assistant' && (msg.content || msg._tools || msg._chips || msg._approvals || msg._stopNote)) {
    const node = addMessageEl('assistant', msg.content || '', null, msg.timestamp);
    const lastBody = node ? node.querySelector('.msg-body') : null;
    _renderAssistantToolArtifacts(lastBody || node, {
      toolEvents: msg._tools || [],
      chips: msg._chips || [],
      progressByTool: msg._progressByTool || {},
      approvals: msg._approvals || [],
      stopNote: msg._stopNote || null,
    });
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
// The live bubble is rebuilt from scratch on every WS event, which would
// wipe any block the user manually expanded. Carry the .open state across
// the swap, matching groups/cards by document order (the rebuild is
// deterministic from the same transcript, so new blocks only append).
function preserveOpenState(oldNode, fresh) {
  for (const sel of ['.activity-group', '.tool-card']) {
    const olds = oldNode.querySelectorAll(sel);
    const news = fresh.querySelectorAll(sel);
    for (let i = 0; i < news.length && i < olds.length; i++) {
      if (!olds[i].classList.contains('open')) continue;
      news[i].classList.add('open');
      const chev = news[i].querySelector('.activity-chevron');
      if (chev) chev.textContent = '▼';
    }
  }
}

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
    const tmp = document.createElement('div');
    const fresh = renderMessage(null, { parent: tmp, isLiveSynth: true, store });
    if (!fresh) return;
    preserveOpenState(oldNode, fresh);
    // Carry the reserved-space class across the swap so the answer keeps
    // streaming into a full viewport of room and the prompt stays pinned.
    if (oldNode.classList.contains('pin-bottom')) fresh.classList.add('pin-bottom');
    oldNode.replaceWith(fresh);
    _liveMessageNodes.set(sessionId, fresh);
    autoScroll();
  });
  _rerenderRafs.set(sessionId, token);
}

// Finalize the live streaming bubble IN PLACE — no #messages wipe. Replaces
// only the one live node with its finalized form (same single-node swap the
// streaming rerender does every frame, so it's visually seamless), instead of
// renderMessages() tearing down and rebuilding the whole thread. The thread
// rebuild is what made every completed turn flash: the smoothly-streamed bubble
// plus every other message vanished and repainted at once. Returns false when
// the live node can't be located so the caller falls back to a full render.
function finalizeLiveMessageInPlace(sessionId, finalizedMsg) {
  const el = document.getElementById('messages');
  if (!el || !finalizedMsg) return false;
  let oldNode = _liveMessageNodes.get(sessionId);
  if (!oldNode || !document.contains(oldNode)) {
    const all = el.querySelectorAll('.msg.assistant');
    oldNode = all[all.length - 1] || null;
  }
  if (!oldNode) return false;
  // Reshape the finalized message (promoteLiveToMessages output) back into the
  // store snapshot _buildLiveAssistantInto reads. Painting from the final
  // content here also covers the post-`done` frame the rAF rerender skips
  // (it bails once isStreaming flips false).
  const store = {
    content: finalizedMsg.content || '',
    toolEvents: finalizedMsg._tools || [],
    chips: finalizedMsg._chips || [],
    progressByTool: finalizedMsg._progressByTool || {},
    approvals: finalizedMsg._approvals || [],
    stopNote: finalizedMsg._stopNote || null,
  };
  const tmp = document.createElement('div');
  const fresh = _buildLiveAssistantInto(tmp, store);
  if (!fresh) return false;
  preserveOpenState(oldNode, fresh);
  if (oldNode.classList.contains('pin-bottom')) fresh.classList.add('pin-bottom');
  // Drop the streaming affordance — this is the terminal paint.
  fresh.querySelectorAll('.msg-body.streaming').forEach(b => b.classList.remove('streaming'));
  // A tools-only turn (no text) leaves _buildLiveAssistantInto's "thinking"
  // placeholder in the body; the finalized bubble must not look like it's
  // still working. Matches the full-render output (no dots).
  fresh.querySelectorAll('.msg-body .thinking').forEach(t => t.remove());
  const footer = fresh.querySelector('.msg-footer');
  if (footer && finalizedMsg.timestamp && typeof formatMsgTime === 'function') {
    footer.innerHTML = `<span class="msg-time">${formatMsgTime(finalizedMsg.timestamp)}</span>`;
  }
  oldNode.replaceWith(fresh);
  _liveMessageNodes.delete(sessionId);
  return true;
}

function renderMessages() {
  const el = document.getElementById('messages');
  if (!el) return;
  // Entry renders (chat switch / first paint) want to land on the latest
  // message. In-place rebuilds (turn finalize, mid-stream inject, bg-op nudge,
  // server sync) must NOT move the viewport — the reader is already anchored to
  // their prompt at the top, and yanking to scrollHeight here is exactly what
  // made every completed turn lurch. The flag is set by the entry points
  // (selectChat / init_chat) and consumed here; the default is "hold position".
  const scrollToBottom = !!window._chatScrollBottomNext;
  window._chatScrollBottomNext = false;
  const prevScrollTop = el.scrollTop;
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

  // Window the rebuild: entry renders paint only the tail (scrollToBottom
  // doubles as the entry signal — see chat-render-window.js); in-place
  // rebuilds keep whatever history the reader already expanded.
  const windowStart = (typeof _resolveWindowStart === 'function')
    ? _resolveWindowStart(activeChat, scrollToBottom, anchor) : 0;

  // The Map points at DOM nodes we're about to wipe; clear and let the loop
  // re-populate it when it renders the synth row.
  _liveMessageNodes.clear();
  el.innerHTML = '';
  if (typeof _appendEarlierSentinel === 'function') _appendEarlierSentinel(el, activeChat);
  for (let i = windowStart; i < activeChat.messages.length; i++) {
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
  _applyPinBottom(el);
  if (scrollToBottom) {
    // Entry: defer one frame so the browser applies pin-bottom's min-height
    // before we read scrollHeight — otherwise scrollHeight reflects the
    // pre-pin layout and the scroll lands short, leaving the chat flush at
    // the top of the viewport on re-entry.
    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  } else {
    // In-place rebuild: hold the reader's scroll position. The prompt was
    // anchored to the top at send time and stays there straight through
    // finalize — no lurch when the turn completes.
    el.scrollTop = prevScrollTop;
  }
}

// Pin the latest assistant message so it carries the reserved viewport-
// height of room below it (ChatGPT-style). Strip the pin from every other
// assistant first — without this, a sequence of thread updates would leave
// pin-bottom on every prior assistant and stack ~100vh of reserved space
// between every pair of replies. Only reserve the room when the last
// assistant is also the last message overall: if a user message follows it
// (e.g. mid-stream inject), the reserved space would pad an empty assistant
// body and push the inject to the bottom of the viewport with a gap above.
function _applyPinBottom(el) {
  const allAssistant = el.querySelectorAll('.msg.assistant');
  allAssistant.forEach(m => m.classList.remove('pin-bottom'));
  const lastAssistant = allAssistant[allAssistant.length - 1];
  if (!lastAssistant) return;
  const allMsgs = el.querySelectorAll('.msg');
  if (allMsgs[allMsgs.length - 1] === lastAssistant) {
    lastAssistant.classList.add('pin-bottom');
  }
}

// ── Incremental thread updates ──
// renderMessages() wipes #messages and re-parses markdown + re-highlights
// code for EVERY row, which on long threads blocks the renderer main thread
// for seconds — the intermittent whole-window freeze. The recurring triggers
// (bg-op nudge, sync hydrate, mid-stream inject, inject_consumed) only ever
// add or restyle a row, so they go through these in-place paths and fall
// back to a full render only when the DOM isn't in a known-good state.

// Append rows for activeChat.messages[fromIndex..] to the existing thread.
// Returns false when an append can't be trusted (container missing,
// empty-state hero showing, index out of range) so the caller falls back
// to renderMessages().
function appendMessagesInPlace(fromIndex) {
  const el = document.getElementById('messages');
  if (!el || !activeChat || !Array.isArray(activeChat.messages)) return false;
  if (document.getElementById('empty')) return false;
  if (fromIndex < 0 || fromIndex >= activeChat.messages.length) return false;
  for (let i = fromIndex; i < activeChat.messages.length; i++) {
    renderMessage(activeChat.messages[i], {});
  }
  _applyPinBottom(el);
  return true;
}

// Insert a mid-stream inject bubble directly before the live streaming
// assistant row — the DOM mirror of the splice-at-anchor sendMessage applied
// to activeChat.messages. Returns false (caller does a full render) when the
// live node can't be located.
function insertInjectBubbleInPlace(sessionId, injectMsg) {
  const el = document.getElementById('messages');
  if (!el || document.getElementById('empty')) return false;
  let liveNode = _liveMessageNodes.get(sessionId);
  if (!liveNode || !document.contains(liveNode)) {
    const all = el.querySelectorAll('.msg.assistant');
    liveNode = all[all.length - 1] || null;
  }
  if (!liveNode) return false;
  // renderMessage appends to #messages; relocate the bubble to the anchor slot.
  const userEl = renderMessage(injectMsg, {});
  if (!userEl) return false;
  el.insertBefore(userEl, liveNode);
  return true;
}

