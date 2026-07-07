// ── Agent Feeds — card control handlers ──
// Pause / Resume / Redirect / Cancel / Stay-inline / Dismiss. All wired
// through window.sendChatWsControl (chat.js) when the chat WS is open;
// falls back to HTTP for redirects. UI-state updates go through
// updateAgentFeed / removeAgentFeed defined in chat-agent-feeds.js.

function onAgentRedirect(agentId) {
  var input = document.getElementById('agent-redirect-' + agentId);
  if (!input) return;
  var isVisible = input.classList.contains('visible');
  input.classList.toggle('visible');
  if (!isVisible) input.focus();
}

function sendAgentRedirect(agentId, instruction) {
  if (!instruction || !instruction.trim()) return;
  var payload = { type: 'agent-redirect', agentId: agentId, instruction: instruction.trim() };
  if (typeof window.sendChatWsControl === 'function' && window.sendChatWsControl(payload)) return;
  // Fallback: direct HTTP redirect when the chat WS isn't open
  fetch(API + '/api/agents/' + agentId + '/redirect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AUTH_TOKEN },
    body: JSON.stringify({ instruction: instruction.trim() })
  }).catch(function() {});
}

function onAgentPause(agentId) {
  // Backend route by id prefix: op_* → worker pool; agent-* → legacy Handler.
  // UI flips to "paused" either way so the button toggles to Resume.
  if (typeof window.sendChatWsControl === 'function') {
    window.sendChatWsControl({ type: 'agent-control', agentId: agentId, action: 'pause' });
  }
  // Status MUST be exactly 'paused' so renderAgentCard's isPaused check
  // swaps the button to Resume.
  updateAgentFeed(agentId, { status: 'paused' });
}

function onAgentResume(agentId) {
  if (typeof window.sendChatWsControl === 'function') {
    window.sendChatWsControl({ type: 'agent-control', agentId: agentId, action: 'resume' });
  }
  updateAgentFeed(agentId, { status: 'working' });
}

function onAgentCancel(agentId) {
  if (typeof window.sendChatWsControl === 'function') {
    window.sendChatWsControl({ type: 'agent-control', agentId: agentId, action: 'cancel' });
  }
  // Mark as cancelled and remove. Backend (chat-ws.ts) routes by id prefix:
  // op_* → killOp (real worker subprocess kill); agent-* → legacy Handler.
  updateAgentFeed(agentId, { status: 'cancelled' });
  setTimeout(function() { removeAgentFeed(agentId); }, 1500);
}

// User clicked "Stay inline" — POST to /api/auto-delegate/override which
// kills the op + tags the decision as a user-correction (training signal)
// + returns the original message so we can re-submit with /discuss prefix.
async function onAgentStayInline(agentId) {
  try {
    const r = await apiPost('/api/auto-delegate/override', { opId: agentId });
    const data = await r.json();
    updateAgentFeed(agentId, { status: 'overridden — re-asking inline' });
    setTimeout(function() { removeAgentFeed(agentId); }, 1500);
    if (data && data.message) {
      const ta = document.getElementById('msg-input');
      if (ta) {
        ta.value = '/discuss ' + data.message;
        try { sendMessage(); } catch (e) { console.warn('[stay-inline] resubmit failed:', e); }
      }
    } else {
      console.info('[stay-inline] no message to resubmit (op was not auto-delegated)');
    }
  } catch (e) {
    console.warn('[stay-inline] override failed:', e);
  }
}

function onAgentDismiss(agentId) {
  // Pure UI hide — does NOT cancel/kill the underlying op. Use Cancel
  // (X-shaped circle) to actually kill the worker.
  removeAgentFeed(agentId);
}

// ── Delegated DOM handlers ── moved from chat-agent-feeds.js (400-LOC
// ceiling). Everything below resolves its callees (toggleAgentFeeds,
// ambientExpanded, sendAgentRedirect) at event time via the classic-script
// global environment, so load order vs the core file doesn't matter.

// Inline agent-card click → open the panel and scroll the matching card into
// view. Delegated, since sanitizeHtml() strips inline on*= handlers from the
// inline card markup. The id rides in data-agent-id (set in
// renderAgentCard_inline) and is read back from dataset here.
document.addEventListener('click', function(e) {
  var card = e.target.closest ? e.target.closest('.agent-inline-card') : null;
  if (!card) return;
  toggleAgentFeeds();
  var id = card.dataset.agentId;
  if (!id) return;
  var target = document.getElementById('agent-card-' + id);
  if (target) target.scrollIntoView({ behavior: 'smooth' });
});

// Worker-card controls are delegated so the markup carries no inline on*=
// handlers — the id rides in data-agent-id rather than being interpolated into
// a handler's JS string (which an entity-encoded id could break out of).
document.addEventListener('click', function(e) {
  if (!e.target.closest) return;
  var btn = e.target.closest('[data-agent-action]');
  if (btn) {
    var id = btn.dataset.agentId;
    switch (btn.dataset.agentAction) {
      case 'resume': onAgentResume(id); break;
      case 'pause': onAgentPause(id); break;
      case 'redirect': onAgentRedirect(id); break;
      case 'stayinline': onAgentStayInline(id); break;
      case 'cancel': onAgentCancel(id); break;
      case 'dismiss': onAgentDismiss(id); break;
    }
    return;
  }
  // C8 "calm": click a header to fold/expand, per-card (dismiss above returns
  // first). Main cards only fold once TERMINAL (running cards keep their live
  // body); AMBIENT cards toggle at ANY status — expanding is their only way to
  // reveal activity + the mission report link. Track expanded ambient ids so
  // the state survives full dock rebuilds (renderAmbientRegion reads it).
  var header = e.target.closest('.agent-feed-header');
  if (header) {
    var foldCard = header.closest('.agent-feed-card');
    if (!foldCard) return;
    var isAmbientCard = foldCard.classList.contains('ambient');
    if (isAmbientCard || foldCard.getAttribute('data-terminal') === '1') {
      var nowFolded = foldCard.classList.toggle('folded');
      if (isAmbientCard) {
        var ambientId = foldCard.id.replace(/^agent-card-/, '');
        if (nowFolded) delete ambientExpanded[ambientId]; else ambientExpanded[ambientId] = 1;
      }
    }
    return;
  }
  var toggle = e.target.closest('[data-agent-toggle="tools"]');
  if (toggle) {
    var group = toggle.parentElement;
    var body = group.querySelector('.worker-tools-body');
    var open = group.classList.toggle('open');
    if (body) body.style.display = open ? 'block' : 'none';
    var chev = toggle.querySelector('.worker-tools-chevron');
    if (chev) chev.textContent = open ? '▼' : '▶';
  }
});
document.addEventListener('keydown', function(e) {
  if (e.key !== 'Enter' || !e.target.closest) return;
  var input = e.target.closest('[data-agent-redirect]');
  if (!input) return;
  sendAgentRedirect(input.dataset.agentRedirect, input.value);
  input.value = '';
  input.classList.remove('visible');
});
