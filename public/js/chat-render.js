// ── Chat: Rendering (renderMessages + auto-scroll) ──
//
// The full-thread DOM-rendering side of the chat thread:
//   - autoScroll                  — single source of truth for "should I scroll to bottom?"
//   - renderMessage               — per-message DOM builder (one of: user, worker,
//                                   finalized assistant, live synth from store).
//                                   Takes ctx.parent for the synth case so the rerender
//                                   path can build into a detached fragment.
//   - renderMessages              — full DOM rebuild loop over renderMessage
//   - _applyPinBottom             — ChatGPT-style reserved-room pin on the last assistant
//
// The in-place / incremental update paths (live bubble swap, finalize, append,
// inject) live in chat-render-live.js, which loads AFTER this file and reuses
// renderMessage / autoScroll / _applyPinBottom from here.
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
  if (msg.role === 'assistant' && (msg.content || msg._tools || msg._chips || msg._approvals || msg._stopNote || msg._reasoning)) {
    const node = addMessageEl('assistant', msg.content || '', null, msg.timestamp);
    const lastBody = node ? node.querySelector('.msg-body') : null;
    // Persisted "Thinking" block — collapsed by default so the finished answer
    // reads clean, but there to expand later.
    if (lastBody && msg._reasoning) prependReasoningBlock(lastBody, msg._reasoning, false);
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
    // Empty-state markup is owned by home-launcher.js (single source of truth
    // for both the classic hero and the flag-gated command-center layout).
    const sub = activeChat ? 'Start your conversation below.' : 'Select a chat or start a new one.';
    if (typeof window.renderEmptyInto === 'function') {
      window.renderEmptyInto(el, sub);
    } else {
      el.innerHTML = `<div id="empty"><img src="/hero.jpg" alt="Local Agent X" class="hero-img hero-dark" /><img src="/hero-light.png" alt="Local Agent X" class="hero-img hero-light" /><h2>LOCAL AGENT X</h2><p>${sub}</p></div>`;
    }
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
