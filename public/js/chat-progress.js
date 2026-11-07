// ── Chat: the reply's step list and its recap ──
//
// Under a reply that did multi-step work: the step list the agent keeps with
// update_plan (or the task_* tools), live as the steps tick over, and at the end
// the recap it closes the turn with (wrap_up): two or three sentences and, when the
// next move is the user's, one question with answer buttons. A button only sends
// its words as the user's next message, and only the latest reply shows them.
//
// Data: the turn's tool events. Every task tool's tool_end carries the session's
// whole list as metadata.plan, so the newest one is the list; wrap_up's carries
// metadata.wrapUp. The live event and the reloaded row both carry metadata, so the
// list and the box are a pure function of the turn's tool events and repaint
// identically. The phone draws the same from the same data (agentxos progress.ts).
// The two tools themselves are bookkeeping, not activity: isProgressTool keeps
// them out of the "Agent activity" group.
//
// Also the offers it makes (session_start's metadata.sessionOffer): a separate task
// as a card the user taps to start it in a chat of its own, linked to this one.
// The tap is the only thing that starts it (POST /api/sessions/start).
//
// External deps (resolved at call time): esc (shared.js), sendMessage (chat-send.js),
// apiFetch, chats, saveChats, renderSidebar, selectChat, activeChat (chat.js).

const _PROGRESS_TOOLS = new Set(['update_plan', 'wrap_up', 'session_start']);

function isProgressTool(name) {
  return _PROGRESS_TOOLS.has(name);
}

function _lastMetadata(toolEvents, key) {
  let found = null;
  for (const t of toolEvents || []) {
    const v = t && t.type === 'end' && t.metadata && t.metadata[key];
    if (v) found = v;
  }
  return found;
}

// The turn's newest step list; null when the turn kept none.
function planOf(toolEvents) {
  const plan = _lastMetadata(toolEvents, 'plan');
  if (!Array.isArray(plan)) return null;
  const steps = plan.filter((s) => s && typeof s.text === 'string' && s.text);
  return steps.length > 0 ? steps : null;
}

// The turn's recap; null when it closed with none.
function wrapUpOf(toolEvents) {
  const w = _lastMetadata(toolEvents, 'wrapUp');
  return w && typeof w.recap === 'string' && w.recap ? w : null;
}

const _STEP_MARK = { completed: '✓', in_progress: '●', failed: '✕', pending: '○' };

function renderPlanList(steps) {
  const el = document.createElement('div');
  el.className = 'chat-plan';
  const done = steps.filter((s) => s.status === 'completed').length;
  el.innerHTML =
    `<div class="chat-plan-head">Steps <span>${done} of ${steps.length}</span></div>` +
    steps.map((s) => {
      const status = _STEP_MARK[s.status] ? s.status : 'pending';
      return `<div class="chat-plan-step ${status}"><span class="chat-plan-mark">${_STEP_MARK[status]}</span><span>${esc(s.text)}</span></div>`;
    }).join('');
  return el;
}

function renderWrapUp(wrap) {
  const el = document.createElement('div');
  el.className = 'chat-wrapup';
  const actions = wrap.ask && Array.isArray(wrap.actions) ? wrap.actions.filter((a) => typeof a === 'string' && a) : [];
  el.innerHTML =
    `<div class="chat-wrapup-recap">${esc(wrap.recap)}</div>` +
    (wrap.ask ? `<div class="chat-wrapup-ask">${esc(wrap.ask)}</div>` : '') +
    (actions.length ? '<div class="chat-wrapup-actions"></div>' : '');
  const row = el.querySelector('.chat-wrapup-actions');
  actions.forEach((label, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chat-wrapup-action' + (i === 0 ? ' primary' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => {
      const input = document.getElementById('msg-input');
      if (!input || typeof window.sendMessage !== 'function') return;
      input.value = label;
      window.sendMessage();
    });
    row.appendChild(btn);
  });
  return el;
}

// Every offer the turn made, in order.
function sessionOffersOf(toolEvents) {
  return (toolEvents || [])
    .map((t) => t && t.type === 'end' && t.metadata && t.metadata.sessionOffer)
    .filter((o) => o && typeof o.title === 'string' && o.title && typeof o.brief === 'string' && o.brief);
}

// chats and activeChat are app-state.js's script-level bindings, not window properties.
function _chatList() {
  return typeof chats !== 'undefined' && Array.isArray(chats) ? chats : [];
}

function _startedChat(originId, title) {
  return _chatList().find((c) => c && c.startedFrom === originId && c.title === title) || null;
}

function _openButton(btn, chatId) {
  btn.textContent = 'Open';
  btn.disabled = false;
  btn.onclick = () => { if (typeof window.selectChat === 'function') window.selectChat(chatId); };
}

function renderSessionOffer(offer) {
  const el = document.createElement('div');
  el.className = 'chat-session-offer';
  el.innerHTML =
    `<div class="chat-session-offer-head"><span class="chat-session-offer-label">New chat</span> ${esc(offer.title)}</div>` +
    `<details class="chat-session-offer-brief" open><summary>Brief</summary><div>${esc(offer.brief)}</div></details>` +
    '<div class="chat-session-offer-row"><button type="button" class="chat-wrapup-action primary">Start</button></div>';
  const btn = el.querySelector('button');
  const originId = (typeof activeChat !== 'undefined' && activeChat && activeChat.id) || '';
  const prior = _startedChat(originId, offer.title);
  if (prior) { _openButton(btn, prior.id); return el; }
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = 'Starting…';
    try {
      const res = await apiFetch('/api/sessions/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: originId, title: offer.title, brief: offer.brief }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (!_startedChat(originId, data.title)) {
        _chatList().unshift({ id: data.sessionId, title: data.title, messages: [], createdAt: Date.now(), updatedAt: Date.now(), startedFrom: originId });
        saveChats();
        renderSidebar();
      }
      _openButton(btn, data.sessionId);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Start';
      el.querySelector('.chat-session-offer-row').insertAdjacentHTML('beforeend', `<span class="chat-session-offer-error">Couldn't start it: ${esc(e.message)}</span>`);
    }
  };
  return el;
}
