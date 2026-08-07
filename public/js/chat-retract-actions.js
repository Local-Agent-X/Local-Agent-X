// ── Chat: last-turn recovery controls ("Regenerate" / "Edit & resend") ──
//
// Lets a user recover a polluted chat WITHOUT starting a new session by
// dropping the last user+assistant/tool pair and either re-running it or
// editing the last prompt back into the composer. Backed by the server
// endpoint POST /api/retract (mode:"turn").
//
// Both controls are attached ONLY to the last real assistant bubble's
// .msg-footer (chat-render.js _applyPinBottom) and are gated to NOT-streaming:
//   - a running turn would make sendMessage() re-route to mid-stream inject
//     (chat-send.js:24,30), and
//   - /api/retract returns HTTP 409 while a turn is active.
// So the controls are simply not rendered while ChatStreamStore.isStreaming().
//
// External deps (runtime globals): apiPost (shared-api.js), activeChat +
// saveChats (app-state.js), renderMessages (chat-render.js),
// ChatStreamStore (chat-stream-store.js), window.sendMessage (chat-send.js).

// Index of the last user message in a messages[] array, or -1.
function _lastUserTurnIndex(msgs) {
  if (!Array.isArray(msgs)) return -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i] && msgs[i].role === 'user') return i;
  }
  return -1;
}

// Display text for a user message — strips the "Attached files:" prefix
// exactly as chat-render.js:95 does for the rendered bubble.
function _userDisplayText(msg) {
  if (!msg) return '';
  return msg.attachments
    ? (msg.content || '').replace(/^Attached files:\n[\s\S]*?\n\n/, '')
    : (msg.content || '');
}

// POST /api/retract for the active session. Returns the parsed ack
// ({ok, mode, removed, messageCount} | {ok:false, reason}). Never throws —
// a network/409/nothing-to-retract failure surfaces as a console warning and
// a falsy-ok ack the caller checks.
async function retractLastTurn(mode) {
  if (!activeChat || !activeChat.id) return { ok: false, reason: 'no-active-chat' };
  try {
    const ack = await apiPost('/api/retract', { sessionId: activeChat.id, mode });
    if (!ack || ack.ok !== true) {
      console.warn('[retract] not retracted:', ack && (ack.reason || 'unknown'));
    }
    return ack || { ok: false, reason: 'no-response' };
  } catch (e) {
    console.warn('[retract] request failed:', e && e.message);
    return { ok: false, reason: (e && e.message) || 'request-failed' };
  }
}

// Drop the last user+assistant/tool pair from the local transcript: everything
// from the last user message to the end of the array. Mirrors the server's
// mode:"turn" removal so the local view matches without a round-trip reload.
function _dropLastLocalTurn(idx) {
  if (idx < 0 || !activeChat || !Array.isArray(activeChat.messages)) return;
  activeChat.messages.splice(idx);
  if (typeof saveChats === 'function') saveChats();
  if (typeof renderMessages === 'function') renderMessages();
}

// Regenerate: retract the last turn on the server, drop it locally, then
// re-send the exact same user prompt to run a fresh turn.
async function regenerateLastTurn() {
  if (!activeChat || typeof ChatStreamStore === 'undefined') return;
  if (ChatStreamStore.isStreaming(activeChat.id)) return; // gated: no retract mid-stream
  const idx = _lastUserTurnIndex(activeChat.messages);
  if (idx < 0) return;
  const userText = activeChat.messages[idx].content || ''; // grab FIRST — retract mutates
  const ack = await retractLastTurn('turn');
  if (!ack || ack.ok !== true) return; // notice already surfaced by retractLastTurn
  _dropLastLocalTurn(idx);
  const input = document.getElementById('msg-input');
  if (input && typeof window.sendMessage === 'function') {
    input.value = userText;
    window.sendMessage();
  }
}

// Edit & resend: retract the last turn, drop it locally, then put the last
// user prompt (display text, attachment prefix stripped) back in the composer
// for the user to edit. Does NOT auto-send.
async function editResendLastTurn() {
  if (!activeChat || typeof ChatStreamStore === 'undefined') return;
  if (ChatStreamStore.isStreaming(activeChat.id)) return; // gated
  const idx = _lastUserTurnIndex(activeChat.messages);
  if (idx < 0) return;
  const displayText = _userDisplayText(activeChat.messages[idx]); // grab FIRST
  const ack = await retractLastTurn('turn');
  if (!ack || ack.ok !== true) return;
  _dropLastLocalTurn(idx);
  const input = document.getElementById('msg-input');
  if (input) {
    input.value = displayText;
    try { input.focus(); } catch {}
    // Nudge any auto-grow listener so the box sizes to the restored text.
    try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
  }
}

// Build + attach the last-turn action bar into a bubble's .msg-footer. Called
// only for the last real assistant bubble (chat-render.js). Renders nothing
// while streaming (controls would 409 / re-route to inject) or when there is
// no user turn to act on. Idempotent — a second call is a no-op.
function appendLastTurnControls(footerEl) {
  if (!footerEl || !activeChat) return;
  if (footerEl.querySelector('.last-turn-actions')) return; // idempotent
  if (typeof ChatStreamStore !== 'undefined'
      && ChatStreamStore.isStreaming && ChatStreamStore.isStreaming(activeChat.id)) return;
  if (_lastUserTurnIndex(activeChat.messages) < 0) return;

  const bar = document.createElement('span');
  bar.className = 'last-turn-actions';

  const mkBtn = (label, title, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'last-turn-btn';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', (ev) => {
      ev.preventDefault();
      if (b.disabled) return;
      b.disabled = true;
      Promise.resolve(onClick()).finally(() => { b.disabled = false; });
    });
    return b;
  };

  bar.appendChild(mkBtn('↻ Regenerate', 'Re-run the last turn', regenerateLastTurn));
  bar.appendChild(mkBtn('✎ Edit & resend', 'Put the last message back in the composer to edit', editResendLastTurn));
  footerEl.appendChild(bar);
}

// One-time minimal styling for the action bar — reuses footer muted tone.
(function _injectLastTurnCss() {
  if (typeof document === 'undefined') return;
  const id = '_lastTurnActionsCSS';
  if (document.getElementById(id)) return;
  const s = document.createElement('style');
  s.id = id;
  s.textContent =
    '.last-turn-actions{display:inline-flex;gap:.4rem;margin-left:.6rem;vertical-align:middle}' +
    '.last-turn-btn{padding:.1rem .45rem;border:1px solid var(--border,#3a3a3a);border-radius:.3rem;' +
    'background:transparent;color:var(--muted,#888);font:inherit;font-size:.68rem;cursor:pointer;opacity:.75}' +
    '.last-turn-btn:hover{opacity:1;color:var(--text,#ddd)}' +
    '.last-turn-btn:disabled{opacity:.4;cursor:default}';
  document.head.appendChild(s);
})();

// Expose entry points on window so the test harness (new Function(src)()) and
// any cross-file caller can reach them; in the browser the top-level function
// declarations are already globals, this just makes it explicit + testable.
if (typeof window !== 'undefined') {
  window.appendLastTurnControls = appendLastTurnControls;
  window.regenerateLastTurn = regenerateLastTurn;
  window.editResendLastTurn = editResendLastTurn;
  window.retractLastTurn = retractLastTurn;
}
