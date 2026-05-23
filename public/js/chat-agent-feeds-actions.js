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
