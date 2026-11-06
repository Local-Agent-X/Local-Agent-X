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
// External deps (resolved at call time): esc (shared.js), sendMessage (chat-send.js).

const _PROGRESS_TOOLS = new Set(['update_plan', 'wrap_up']);

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
