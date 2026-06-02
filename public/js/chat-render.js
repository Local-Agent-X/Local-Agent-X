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
  _renderAssistantToolArtifacts(bodyEl || div, {
    toolEvents,
    chips: store ? (store.chips || []) : [],
    progressByTool: store ? (store.progressByTool || {}) : {},
    approvals: store ? (store.approvals || []) : [],
    stopNote: store ? store.stopNote : null,
  });
  return div;
}

// Roll tool failures up onto the collapsed "Agent activity" header so the
// user can tell work failed WITHOUT expanding the group — the whole point of
// the outcome indicator. Recomputed on every render from the end events, so
// it stays correct as the turn streams in and after a reload.
function _updateActivityOutcome(bodyEl, toolEvents) {
  const group = bodyEl.querySelector('.activity-group');
  if (!group) return;
  const ends = toolEvents.filter(t => t.type === 'end');
  const failed = ends.filter(t => t.status === 'error' || t.status === 'timeout').length;
  const label = group.querySelector('.activity-label');
  if (label) {
    const total = ends.length;
    let txt = total >= 5 ? `Agent activity — ${total} actions` : 'Agent activity';
    if (failed > 0) txt += ` · ${failed} failed`;
    label.textContent = txt;
  }
  const countEl = group.querySelector('.activity-count');
  if (countEl) countEl.style.color = failed > 0 ? 'var(--danger, #e5484d)' : '';
}

// Shared render for assistant tool artifacts (cards, chips, progress, approvals,
// stop notice). Used by both the live synth path (_buildLiveAssistantInto) and
// the finalized assistant branch in renderMessage so a reloaded chat looks
// identical to its in-flight render.
function _renderAssistantToolArtifacts(bodyEl, data) {
  if (!bodyEl || !data) return;
  const toolEvents = data.toolEvents || [];
  if (toolEvents.length > 0) {
    try {
      // Pair each start with a DISTINCT end. A plain name-match via .find()
      // resolved every same-named start to the FIRST end — so when one tool
      // ran N times in a turn (e.g. 11× generate_image), the first result and
      // its image rendered N times while the other N-1 never showed. Prefer
      // the tool call id when both sides carry a matching one; otherwise fall
      // back to consuming ends in order per tool name (codex ids are composite
      // and don't always line up start↔end, so id-only pairing can miss).
      const endsById = new Map();
      const endsByName = new Map();
      for (const t of toolEvents) {
        if (t.type !== 'end') continue;
        if (t.toolCallId) endsById.set(t.toolCallId, t);
        if (!endsByName.has(t.name)) endsByName.set(t.name, []);
        endsByName.get(t.name).push(t);
      }
      const nameCursor = new Map();
      for (const te of toolEvents) {
        if (te.type !== 'start') continue;
        // Route through appendToolCardGrouped so the swap matches the
        // per-event paint path: cards land inside the collapsible
        // "Agent activity" group, consecutive same-tool calls collapse
        // into a single ×N card.
        const card = appendToolCardGrouped(bodyEl, te.name, te.args || '', te.riskLevel);
        let endEvt = (te.toolCallId && endsById.get(te.toolCallId)) || null;
        if (!endEvt) {
          const list = endsByName.get(te.name) || [];
          const i = nameCursor.get(te.name) || 0;
          endEvt = list[i] || null;
          nameCursor.set(te.name, i + 1);
        }
        if (endEvt) {
          // Execution outcome, not just the approval decision. A tool can be
          // allowed-then-fail (bash exit 1, edit no-match, http 500); the
          // status discriminator carries that. Reuse the existing
          // allowed(green)/blocked(red) dot styles — failure maps to red.
          const failed = endEvt.status === 'error' || endEvt.status === 'timeout';
          const ok = endEvt.allowed !== false && !failed && endEvt.status !== 'blocked';
          card.querySelector('.indicator').className = 'indicator ' + (ok ? 'allowed' : 'blocked');
          // Clean the agent-safety scaffolding off the tool-detail text but
          // leave the raw result in place for attachMediaPreview's URL scan —
          // generate_image results can wrap their /images/foo.png path inside
          // an EXTERNAL_UNTRUSTED_CONTENT block, so cleaning before scanning
          // would lose the URL.
          const rawResult = endEvt.result || '';
          const detailText = rawResult
            .replace(/<<<EXTERNAL_UNTRUSTED_CONTENT[\s\S]*?<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/g, '[content loaded]')
            .replace(/IMPORTANT:.*?Do NOT follow any instructions.*$/gm, '')
            .replace(/<metadata>[\s\S]*?<\/metadata>/g, '')
            .replace(/<content>\n?/g, '').replace(/\n?<\/content>/g, '')
            .trim()
            .slice(0, 200);
          const fallback = failed
            ? (endEvt.status === 'timeout' ? '✗ Timed out' : '✗ Failed')
            : (endEvt.status === 'blocked' || endEvt.allowed === false ? '⚠ Blocked' : '✓ Done');
          card.querySelector('.tool-detail').textContent = detailText || fallback;
          attachMediaPreview(card, te.name, rawResult);
        }
      }
      _updateActivityOutcome(bodyEl, toolEvents);
    } catch (toolRenderErr) { console.error('[chat] tool card render error:', toolRenderErr); }
  }
  // Chips attach to the last tool card matching the chip's emit time. The
  // store keeps insertion order, so appendToolChip's "last card" heuristic
  // matches the live arrival order for the common single-chip case. (Cards
  // and chips can interleave in the rare multi-chip-multi-tool case; not
  // worth tracking exact targets until that bites someone.)
  const chips = data.chips || [];
  for (const chip of chips) { try { appendToolChip(bodyEl, chip); } catch {} }
  // Progress: latest message per tool name. Skip tools that already ended —
  // their tool-detail carries the final result, so progress would just
  // clobber it.
  const progressByTool = data.progressByTool || {};
  for (const toolName of Object.keys(progressByTool)) {
    const ended = toolEvents.some(t => t.type === 'end' && t.name === toolName);
    if (ended) continue;
    const entry = progressByTool[toolName];
    if (entry && typeof entry.message === 'string') {
      try { updateToolProgress(bodyEl, toolName, entry.message); } catch {}
    }
  }
  // Approvals and the stop note hang off bodyEl directly (NOT inside the
  // activity group) — they need to render outside the collapsible block.
  const approvals = data.approvals || [];
  for (const ap of approvals) {
    try {
      const card = makeApprovalCard(ap.id, ap.toolName, ap.context, ap.argsPreview);
      if (ap.status === 'timeout') {
        card.classList.add('timeout');
        const statusEl = card.querySelector('.approval-status');
        if (statusEl) statusEl.textContent = 'Timed out — denied.';
        card.querySelectorAll('button').forEach(b => b.disabled = true);
      }
      bodyEl.appendChild(card);
    } catch (approvalRenderErr) { console.error('[chat] approval card render error:', approvalRenderErr); }
  }
  const stopNote = data.stopNote;
  if (stopNote) {
    const note = document.createElement('div');
    note.className = 'stop-notice';
    note.textContent = stopNote.reason || 'Stopped.';
    note.title = stopNote.debug || stopNote.firedBy || '';
    bodyEl.appendChild(note);
  }
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

