// ── Chat: Rendering (renderMessages + stream renderers + auto-scroll) ──
//
// The DOM-rendering side of the chat thread:
//   - autoScroll                — single source of truth for "should I scroll to bottom?"
//   - _upsertStreamingAssistant — keeps the persisted assistant row in
//                                 sync with the live closure-bound stream
//   - renderStreamContent       — rAF-batched markdown render for incoming deltas
//   - stripAgentScratchwork     — removes inline plan/scratch from agent text
//   - renderMessages            — full DOM rebuild from activeChat.messages
//
// Extracted from chat.js as part of the 400-LOC god-file split.
//
// External deps from chat.js / shared.js:
//   - apiFetch, esc, md, normalizeMd, _fixMd  (shared.js)
//   - activeChat, saveChats                   (app.js)
//   - streamingSessionId, _liveStreams, pendingUploads, userScrolledUp
//                                             (chat.js — closure-bound at call time)
//   - addMessageEl, appendStaticWorkerBubble, appendToolCardGrouped
//                                             (chat-helpers.js / chat-tool-cards.js — auto-window)

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

// Upsert the in-flight streaming assistant message into a chat's messages
// array. Critical: identify by the `_streaming: true` flag, NOT by array
// position. The earlier "is the last message a streaming assistant?" check
// broke the moment a mid-turn user inject pushed itself onto the array
// after the assistant — the next save-partial saw the user inject as
// `lastMsg`, missed the streaming assistant, and APPENDED a second
// streaming-assistant entry. renderMessages then rendered both, pulling
// the same live content into two slots, with the user inject sandwiched
// between them. Visually: the user's bubble appeared cut into the middle
// of the assistant's growing reply.
//
// Used by both the WS save-interval and the HTTP-fallback savePartial.
function _upsertStreamingAssistant(chat, content, toolEvents) {
  if (!chat || !Array.isArray(chat.messages)) return;
  // Find the most recent existing streaming-assistant entry.
  let idx = -1;
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const m = chat.messages[i];
    if (m && m.role === 'assistant' && m._streaming) { idx = i; break; }
  }
  if (idx >= 0) {
    chat.messages[idx].content = content;
    chat.messages[idx]._tools = toolEvents.length > 0 ? [...toolEvents] : undefined;
    return;
  }
  // Defensive dup guard: if the LAST assistant message in the array has
  // identical content (and no _streaming flag), don't append a clone.
  // Reproduces in the wild on: WS reconnect-replay firing a late `done`
  // after the assistant was already finalized; sync-from-_liveStreams in
  // renderMessages firing twice; bg_op_nudge persistence race. All of
  // those funnel here and we'd otherwise grow `messages` with identical
  // assistant rows that render as duplicate "Spawned it" / duplicate
  // text bubbles in chat. Guard at the source.
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const m = chat.messages[i];
    if (!m || m.role !== 'assistant') continue;
    if (m.content === content) return;
    break; // stop at first non-streaming assistant — only check most recent
  }
  chat.messages.push({
    role: 'assistant',
    content,
    _streaming: true,
    _tools: toolEvents.length > 0 ? [...toolEvents] : undefined,
  });
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
  // Sync the live stream into activeChat.messages BEFORE rebuilding DOM.
  // The save-interval only flushes every 3s, so if renderMessages runs
  // sooner (mid-stream user inject, fast chat-switch back, reconnect)
  // the streaming-assistant row may not exist yet — the iteration below
  // would then skip it entirely and the live DOM bubble would be wiped
  // with no replacement, leaving the chat looking frozen until the next
  // save tick or page reload. Pull straight from _liveStreams (which
  // exposes closure-bound content + toolEvents getters from the stream
  // handler) and upsert so the iteration sees a real assistant slot.
  if (streamingSessionId === activeChat.id) {
    const live = _liveStreams.get(activeChat.id);
    const hasStreamingMsg = activeChat.messages.some(function(m) { return m && m.role === 'assistant' && m._streaming; });
    if (live && !hasStreamingMsg) {
      _upsertStreamingAssistant(activeChat, live.content || '', live.toolEvents || []);
    }
  }
  el.innerHTML = '';
  for (let i = 0; i < activeChat.messages.length; i++) {
    const msg = activeChat.messages[i];
    if (msg.role === 'user') {
      const displayText = msg.attachments ? msg.content.replace(/^Attached files:\n[\s\S]*?\n\n/, '') : msg.content;
      addMessageEl('user', displayText, msg.attachments, msg.timestamp);
    } else if (msg.role === 'assistant' && msg._worker) {
      // Persisted worker bubble — render with the same styling as a live
      // worker_stream bubble, just static. Skip the regular assistant
      // path so the agent's pin-bottom and tool-card logic doesn't apply.
      appendStaticWorkerBubble(msg._opId, msg.content || '', msg._taskHint, msg._workerStatus);
    } else if (msg.role === 'assistant' && (msg.content || msg._tools)) {
      // Live-content lookup is gated on `_streaming` ONLY, not on array
      // position. Earlier this required the streaming entry to be the
      // LAST message — which broke as soon as a mid-turn inject pushed a
      // user row after the streaming assistant. `live` would resolve null
      // even though the registry still had content, the next branch would
      // strip `_streaming`, and the save-interval would lose track and
      // append a duplicate streaming entry. The streaming-state flag is
      // the source of truth — array position is incidental.
      const live = msg._streaming ? _liveStreams.get(activeChat.id) : null;
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
  el.scrollTop = el.scrollHeight;
}

