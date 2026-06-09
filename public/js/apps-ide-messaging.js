// -- App IDE View -- messaging --
// Chat send/inject, prompt prefix handling, agent dispatch, input enable/
// disable, stop, fresh-chat, history load, and chat-bubble rendering.
// Split out of apps-ide.js (core: state + lifecycle). Loads as a classic
// browser script (no module). Runtime calls into core symbols (ideSetStatus,
// ideStartTimer, ideStopTimer, the _ide* state vars) are fine -- none are
// referenced at load time, so this file is safe to load before apps-ide.js.

// ── Send & input ──
async function sendIdeChatMessage() {
  const input = document.getElementById('ide-chat-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text && idePendingUploads.length === 0) return;

  // Mid-stream inject: the agent's mid-turn already. Send the text into the
  // running op's inject queue instead of starting a new turn. Server's
  // interjectDrainMiddleware picks it up at the next iteration boundary so
  // the agent sees the new instruction without abandoning current work.
  // (Same path main chat uses; see chat-send.js inject branch.) Inject
  // messages don't carry attachments today — same constraint as main chat;
  // queued files surface on the next non-inject send.
  if (_ideStreaming) {
    if (typeof chatWs !== 'undefined' && chatWs && chatWs.readyState === WebSocket.OPEN) {
      const injectId = (window.crypto && window.crypto.randomUUID)
        ? window.crypto.randomUUID()
        : ('inj-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8));
      chatWs.send(JSON.stringify({ type: 'inject', sessionId: _ideSessionId, message: text, injectId }));
      input.value = '';
      input.style.height = 'auto';
      // Echo locally so the user sees the inject landed; no [queued] styling
      // because the IDE doesn't render queue-state (main chat does — the IDE
      // intentionally stays lighter).
      ideAddMessage('user', text);
    }
    return;
  }

  // Wait for any in-flight uploads to finish before capturing attachments.
  // Hard 8s ceiling per chat-send.js — a hung server would otherwise leave
  // a pending promise forever and block this and every future send.
  const inflight = idePendingUploads.filter(f => f._uploadPromise).map(f => f._uploadPromise);
  if (inflight.length > 0) {
    await Promise.race([
      Promise.all(inflight),
      new Promise(resolve => setTimeout(resolve, 8000)),
    ]);
  }
  const msgAttachments = idePendingUploads.length ? idePendingUploads.map(f => ({
    name: f.name, size: f.size, type: f.type, isImage: f.isImage,
    url: f.url || null, dataUrl: f.dataUrl || null,
  })) : null;
  const hasImages = msgAttachments && msgAttachments.some(a => a.isImage);
  const nonImageFiles = msgAttachments ? msgAttachments.filter(a => !a.isImage) : [];
  const uploadPrefix = nonImageFiles.length
    ? `Attached files:\n${nonImageFiles.map(f => `- ${f.name} (${f.size} bytes)`).join('\n')}\n\n`
    : '';
  const displayText = text || (hasImages ? '' : '');

  input.value = '';
  input.style.height = 'auto';
  idePendingUploads = [];
  if (window.__uploadContexts && window.__uploadContexts.ide) window.__uploadContexts.ide.setState([]);
  if (typeof renderUploadPreviews === 'function') renderUploadPreviews('ide');

  ideAddMessage('user', displayText, false, msgAttachments);
  const errPrefix = (typeof ideDrainErrorsForAgent === 'function') ? ideDrainErrorsForAgent() : '';
  ideSendToAgent(ideContextPrefix() + errPrefix + uploadPrefix + text, msgAttachments);
}

function ideContextPrefix() {
  return 'IMPORTANT: You are in IDE mode editing an app. ' +
    'If the user is asking a question, brainstorming, or asking what to do next ' +
    '(e.g. "what should we add?", "what do you think?", "any ideas?", "should we...?"), ' +
    'reply in chat with your suggestions FIRST and wait for an explicit go-ahead before editing. ' +
    'Only start editing files when given a clear directive ("add X", "fix Y", "build it", "do it", "go"). ' +
    'Do NOT use agent_spawn, delegate, or build_app tools. ' +
    'When you do edit, do the work YOURSELF using read, write, edit, bash, glob, and grep tools directly. ' +
    'Work in workspace/apps/' + _ideAppId + '/. ' +
    'Do NOT include http://127.0.0.1 URLs in your reply — the user is viewing the app in a live preview iframe next to this chat, so any "open the app here" link is redundant noise. ';
}
// Marker used to strip the prefix from displayed user messages so the
// hidden IDE instructions don't show up as a chat bubble when history reloads.
const IDE_PREFIX_MARKER = 'IMPORTANT: You are in IDE mode editing an app.';
function ideStripPrefix(text) {
  if (typeof text !== 'string' || !text.startsWith(IDE_PREFIX_MARKER)) return text;
  // Prefix ends at the last sentence-ending period before the user's real text.
  // Pattern: a series of sentences ending in '. ', then the user content.
  // Cheapest robust match: find 'workspace/apps/{id}/. ' OR 'redundant noise. '
  // and slice past it. Fall back to the original text if no match.
  const cuts = [/redundant noise\.\s+/, new RegExp('workspace/apps/[^/]+/\\.\\s+')];
  for (const re of cuts) {
    const m = text.match(re);
    if (m && m.index != null) return text.slice(m.index + m[0].length);
  }
  return text;
}

function ideSendToAgent(message, attachments) {
  _ideStreaming = true;
  _ideContent = '';
  _ideToolCount = 0;
  ideDisableInput();
  ideSetStatus('working', 'Thinking...');
  ideStartTimer();
  ideAddMessage('assistant', '', true);

  if (typeof chatWs !== 'undefined' && chatWs && chatWs.readyState === WebSocket.OPEN) {
    chatWs.send(JSON.stringify({
      type: 'chat', sessionId: _ideSessionId,
      message: message, attachments: attachments || []
    }));
  }
}

function ideDisableInput() {
  const input = document.getElementById('ide-chat-input');
  const btn = document.getElementById('ide-chat-send');
  const stopBtn = document.getElementById('ide-chat-stop');
  // Keep input + send-btn ENABLED during streaming: sendIdeChatMessage routes
  // typed text to the inject queue when _ideStreaming. Locking the input
  // prevented the user from steering mid-turn ("actually use blue", "skip the
  // header"); main chat's composer made the same choice.
  if (input) { input.placeholder = 'Working… type to inject into this turn'; }
  if (stopBtn) stopBtn.style.display = 'flex';
}

function ideEnableInput() {
  const input = document.getElementById('ide-chat-input');
  const btn = document.getElementById('ide-chat-send');
  const stopBtn = document.getElementById('ide-chat-stop');
  if (input) { input.disabled = false; input.placeholder = 'Describe changes...'; input.focus(); }
  if (btn) btn.disabled = false;
  if (stopBtn) stopBtn.style.display = 'none';
}

// Send {type: 'stop', sessionId} — server's handleStop cancels the canonical
// op + releases the turn lock. Same signal main chat's stopChat sends; do
// NOT close-and-reconnect the WS (main chat does that as a sledgehammer
// and it would kill any concurrent main-chat stream). HTTP fallback in case
// the WS dropped.
function stopIdeChat() {
  if (!_ideSessionId) return;
  if (typeof chatWs !== 'undefined' && chatWs && chatWs.readyState === WebSocket.OPEN) {
    chatWs.send(JSON.stringify({ type: 'stop', sessionId: _ideSessionId }));
  }
  if (typeof apiFetch === 'function') {
    apiFetch('/api/chats/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: _ideSessionId }),
    }).catch(() => {});
  }
  // Mark the in-flight assistant message as stopped so the user sees the
  // cancellation took effect before the server's `done`/`error` event arrives
  // (which can lag a few seconds). Match main chat's [stopped by user] style.
  const activeEl = document.getElementById('ide-assistant-active');
  if (activeEl) {
    const textEl = activeEl.querySelector('.ide-text') || activeEl;
    if (!textEl.textContent.includes('[stopped')) {
      const note = document.createElement('div');
      note.style.cssText = 'color:var(--muted);font-size:.72rem;margin-top:8px;font-style:italic';
      note.textContent = '[stopped by user]';
      activeEl.appendChild(note);
    }
    activeEl.removeAttribute('id');
  }
  _ideStreaming = false;
  _ideContent = '';
  ideStopTimer();
  ideSetStatus('ready', 'Stopped');
  ideEnableInput();
}
window.stopIdeChat = stopIdeChat;

// Wipe this app's stable session and reset the UI. Used by the Fresh
// Chat button in the topbar — the session is per-app and accumulates
// over many builds, so the user needs an explicit "start over" affordance
// when the conversation has drifted or they just want a clean slate.
async function ideFreshChat() {
  if (!_ideSessionId) return;
  if (!confirm('Wipe this app\'s chat history and start fresh? The app files stay put — only the conversation is reset.')) return;
  try {
    await apiFetch('/api/sessions/' + encodeURIComponent(_ideSessionId), { method: 'DELETE' });
  } catch { /* if delete fails, still reset the UI — server can have a stale row, user sees a clean chat */ }
  const msgs = document.getElementById('ide-chat-messages');
  if (msgs) msgs.innerHTML = '';
  _ideContent = '';
  _ideToolCount = 0;
  _ideTrackedAgents = {};
  ideSetStatus('ready', 'Ready');
}
window.ideFreshChat = ideFreshChat;

// Fetch and render the user/assistant history for this app's stable
// session. UI-projection view drops tool-call detail rows — we just want
// the conversation bubbles. Silent-fail: a fresh app has no session yet
// (404), nothing to render.
async function ideLoadHistory() {
  if (!_ideSessionId) return;
  try {
    const r = await apiFetch('/api/sessions/' + encodeURIComponent(_ideSessionId));
    if (!r.ok) return;
    const session = await r.json();
    const list = Array.isArray(session?.messages) ? session.messages : [];
    for (const m of list) {
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      const raw = typeof m.content === 'string' ? m.content : '';
      if (!raw) continue;
      const text = m.role === 'user' ? ideStripPrefix(raw) : raw;
      if (!text) continue;
      ideAddMessage(m.role, text);
    }
  } catch { /* fresh session or transient — fine to skip */ }
}

// ── Chat messages ──
function __ideAttachmentHtml(attachments) {
  if (!attachments || !attachments.length) return '';
  const safeEsc = (typeof esc === 'function') ? esc : (s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]));
  return '<div class="msg-attachments">' + attachments.map(a => {
    if (a.isImage && a.dataUrl) {
      return `<img src="${safeEsc(a.dataUrl)}" alt="${safeEsc(a.name)}" onclick="typeof openLightbox==='function'&&openLightbox(this.src)" title="${safeEsc(a.name)}" loading="lazy" />`;
    } else if (a.isImage && a.url) {
      const tok = (typeof AUTH_TOKEN !== 'undefined') ? AUTH_TOKEN : '';
      const authedUrl = a.url + (a.url.includes('?') ? '&' : '?') + 'token=' + tok;
      return `<img src="${safeEsc(authedUrl)}" alt="${safeEsc(a.name)}" onclick="typeof openLightbox==='function'&&openLightbox(this.src)" title="${safeEsc(a.name)}" loading="lazy" />`;
    } else if (a.isImage) {
      return `<div class="att-badge"><span>&#128444;</span> ${safeEsc(a.name)}</div>`;
    } else {
      return `<div class="att-badge"><span>&#128196;</span> ${safeEsc(a.name)} (${(a.size / 1024).toFixed(1)}KB)</div>`;
    }
  }).join('') + '</div>';
}

function ideAddMessage(role, text, isPlaceholder, attachments) {
  const msgs = document.getElementById('ide-chat-messages');
  if (!msgs) return;
  const el = document.createElement('div');
  el.className = 'ide-msg ' + role;
  if (role === 'assistant' && isPlaceholder) {
    el.innerHTML = '<div class="ide-thinking"><span></span><span></span><span></span></div>';
    el.id = 'ide-assistant-active';
  } else {
    const attachHtml = __ideAttachmentHtml(attachments);
    const body = typeof md === 'function' ? md(text || '') : esc(text || '');
    // Route the final markup through the DOM allowlist sanitizer: md() already
    // sanitizes, but the no-md fallback and attachHtml must not reach innerHTML
    // raw. sanitizeHtml is idempotent on already-safe content.
    el.innerHTML = sanitizeHtml(attachHtml + body);
    if (typeof text === 'string') el.dataset.rawText = text;
  }
  msgs.appendChild(el);
  msgs.scrollTop = msgs.scrollHeight;
  // Re-scroll after images decode (height changes once they paint).
  const imgs = el.querySelectorAll('.msg-attachments img');
  if (imgs.length) imgs.forEach(img => img.onload = () => { msgs.scrollTop = msgs.scrollHeight; });
}

window.sendIdeChatMessage = sendIdeChatMessage;
