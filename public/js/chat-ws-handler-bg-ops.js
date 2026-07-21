// ── Chat WS: background-op + worker event handlers ──
// Each handler takes the parsed envelope `msg` (with msg.event present and
// msg.event.type pre-matched by the dispatcher). They surface worker
// lifecycle in the AGENTS sidebar — never in the chat thread — so background
// work doesn't pollute the conversation. Step 6 lifecycle: queued → working
// → completed; auto-prune at 30 min.

function handleBgOpQueued(msg) {
  try {
    if (typeof addAgentFeed === 'function') {
      addAgentFeed({
        id: msg.event.opId,
        name: 'Worker: ' + (msg.event.task || '').slice(0, 60),
        role: 'coder',
        // C8: real op type (app_build/research/self_edit/…) drives the card
        // icon. `role: 'coder'` stays as the fallback when opType is absent.
        type: msg.event.opType,
        status: 'queued #' + (msg.event.queuePosition || '?'),
        currentTask: msg.event.task || '',
        output: '⏸ queued (lane: ' + (msg.event.lane || 'build') + ')\n',
        // C6 run-lineage: the op that spawned this worker (C1 stamps it).
        // Lets the AGENTS panel nest workers under their spawning op.
        parentOpId: msg.event.parentOpId,
      });
    }
    return true;
  } catch(e) { console.warn('[bg_op_queued] sidebar update failed', e); return false; }
}

function handleBgOpQueueReordered(msg) {
  try {
    if (typeof updateAgentFeed === 'function') {
      updateAgentFeed(msg.event.opId, { status: 'queued #' + msg.event.queuePosition });
    }
    return true;
  } catch(e) { console.warn('[bg_op_queue_reordered] sidebar update failed', e); return false; }
}

function handleBgOpStarted(msg) {
  try {
    // Two cases: op was queued first (card already exists, just flip
    // status), OR op dispatched immediately (no prior card, create one).
    // updateAgentFeed is no-op if the card doesn't exist; addAgentFeed
    // is idempotent on existing IDs. So calling both is safe.
    if (typeof updateAgentFeed === 'function') {
      updateAgentFeed(msg.event.opId, { status: 'working', output: '▶ started\n', sessionId: msg.sessionId, lastActivityMs: Date.now(), parentOpId: msg.event.parentOpId, type: msg.event.opType });
    }
    if (typeof addAgentFeed === 'function') {
      // Friendlier card name. Cron missions arrive with task =
      // "<scheduled_task>\n<prompt>\n</scheduled_task>" — the raw
      // XML wrapper truncates to "<scheduled_t..." in the sidebar
      // which tells the user nothing. Extract the actual mission
      // intent (first non-trivial line of the prompt) so the card
      // shows what's actually happening.
      var rawTask = msg.event.task || '';
      var displayTask = rawTask;
      var schedMatch = rawTask.match(/<scheduled_task>\s*([\s\S]*?)\s*<\/scheduled_task>/);
      if (schedMatch && schedMatch[1]) displayTask = schedMatch[1];
      displayTask = displayTask.split('\n').map(function(s){return s.trim();}).filter(function(s){return s.length > 0;})[0] || rawTask;
      addAgentFeed({
        id: msg.event.opId,
        name: 'Worker: ' + displayTask.slice(0, 60),
        role: 'coder',
        // C8: real op type drives the card icon (fallback: role 'coder').
        type: msg.event.opType,
        status: 'working',
        currentTask: msg.event.task || '',
        output: '',
        // Stamp sessionId + lastActivityMs so the stuck-stream
        // watchdog (chat-ws.js) can replay missed events via
        // reconnect_op the same way it does for chat-turn ops.
        // Without these the watchdog has nowhere to send the
        // replay and worker cards fell behind silently.
        sessionId: msg.sessionId,
        lastActivityMs: Date.now(),
        // C6 run-lineage parent (see handleBgOpQueued). Set-once in the
        // agent record so re-broadcasts never clobber it.
        parentOpId: msg.event.parentOpId,
      });
    }
    return true;
  } catch(e) { console.warn('[bg_op_started] sidebar update failed', e); return false; }
}

function handleBgOpProgress(msg) {
  try {
    if (typeof updateAgentFeed === 'function') {
      // totalTokens (optional): running per-op token total, forwarded from
      // turn_committed's usage. Drives the card's token bar. Absent for ops
      // that don't emit canonical turn usage → the bar simply stays empty.
      var upd = { output: (msg.event.line || '') + '\n', lastActivityMs: Date.now() };
      if (msg.event.status) upd.status = msg.event.status;
      if (typeof msg.event.totalTokens === 'number') upd.totalTokens = msg.event.totalTokens;
      updateAgentFeed(msg.event.opId, upd);
    }
    return true;
  } catch(e) { console.warn('[bg_op_progress] sidebar update failed', e); return false; }
}

// worker_stream: worker's own LLM text deltas. JARVIS-mode per
// user's intent: main chat stays foreground (you keep talking to
// the main agent), workers narrate themselves in their OWN
// right-rail card. Worker text deltas land in the same output
// area as bg_op_progress (tool-call traces) so each worker card
// shows both reasoning and tool work side-by-side, like a
// miniature chat thread off to the side.
// Off-screen sessions still get a sidebar marker so the user sees activity
// even on chats they aren't viewing.
function handleWorkerStream(msg) {
  if (!(activeChat && activeChat.id === msg.sessionId)) {
    ChatStreamStore.setSidebarActive(msg.sessionId, true);
    if (typeof renderSidebar === 'function') renderSidebar();
  }
  if (typeof updateAgentFeed === 'function') {
    // streamText → worker-text bubble (top of card body).
    // Tool calls / lifecycle markers come in via `output:` from
    // bg_op_progress/queued/started/completed and land in the
    // collapsible worker-tools-group below.
    updateAgentFeed(msg.event.opId, { streamText: (msg.event.delta || ''), lastActivityMs: Date.now() });
  }
  return true;
}

function handleWorkerDone(msg) {
  // No live bubble to clean up anymore (worker_stream is suppressed).
  // Final-result delivery is handled by:
  //   - BACKGROUND COMPLETIONS in prepareAgentRequest (next turn)
  //   - bg_op_completed events updating the right-rail card
  // If a stale bubble somehow exists from a prior session state,
  // mark it done so it doesn't sit there styled as streaming.
  const b = _workerBubbles.get(msg.event.opId);
  if (b) {
    b.div.classList.add('done');
    b.div.classList.add('status-' + (msg.event.status || 'completed'));
    b.div.classList.remove('streaming');
    _workerBubbles.delete(msg.event.opId);
  }
  return true;
}

function handleAvBlockedWarning(msg) {
  try {
    // Sticky banner — user CAN'T fix bash failures without seeing this.
    // Renders once per browser session (matches the once-per-server
    // emission gate so two browser tabs don't double-banner). Stays
    // until user dismisses with the X button.
    if (document.getElementById('av-banner')) return true;
    var banner = document.createElement('div');
    banner.id = 'av-banner';
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#3a1a1a;border-bottom:2px solid #ff5555;color:#ffe5e5;padding:14px 20px;font-family:var(--font);font-size:.85rem;line-height:1.45;box-shadow:0 2px 12px rgba(255,85,85,.3)';
    var safeMsg = String(msg.event.message || '').replace(/[<>&]/g, function(c){return {'<':'&lt;','>':'&gt;','&':'&amp;'}[c]});
    banner.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;max-width:1100px;margin:0 auto">' +
        '<div style="flex:1">' +
          '<strong style="color:#ff8888;display:block;margin-bottom:4px;font-size:.95rem">⚠ Antivirus is blocking the agent</strong>' +
          '<div style="white-space:pre-wrap">' + safeMsg + '</div>' +
        '</div>' +
        '<button onclick="document.getElementById(\'av-banner\').remove()" style="background:none;border:1px solid #ff5555;color:#ff8888;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:.75rem;flex-shrink:0">Dismiss</button>' +
      '</div>';
    document.body.appendChild(banner);
    return true;
  } catch(e) { console.warn('[av_blocked_warning] failed', e); return false; }
}

function handleBgOpNudge(msg) {
  try {
    if (activeChat && activeChat.id === msg.sessionId) {
      activeChat.messages = activeChat.messages || [];
      activeChat.messages.push({ role: 'assistant', content: msg.event.text });
      // Append the one new row in place — a full renderMessages() here
      // rebuilt the entire thread and froze the window on long chats.
      const appended = typeof appendMessagesInPlace === 'function'
        && appendMessagesInPlace(activeChat.messages.length - 1);
      if (!appended && typeof renderMessages === 'function') renderMessages();
    } else {
      ChatStreamStore.setSidebarActive(msg.sessionId, true);
      if (typeof renderSidebar === 'function') renderSidebar();
    }
    if (window.desktop) window.desktop.showNotification('Worker finished', msg.event.text);
    return true;
  } catch(e) { console.warn('[bg_op_nudge] failed', e); return false; }
}

function handleBgOpCompleted(msg) {
  try {
    const statusLabel = msg.event.status === 'completed' ? 'completed'
      : msg.event.status === 'failed' ? 'failed' : 'cancelled';
    const filesLine = (msg.event.filesChanged && msg.event.filesChanged.length > 0)
      ? '\n\nfiles: ' + msg.event.filesChanged.slice(0, 5).join(', ')
      : '';
    // Build-orchestrator completions carry structured metadata so we
    // can render a real summary with chunk progress, halt reason,
    // and a Resume affordance. Falls back to plain summary text
    // for other op types or when metadata is absent.
    const meta = msg.event.metadata || {};
    let output;
    if (meta.kind === 'build-run-summary') {
      output = renderBuildRunSummary(meta) + filesLine;
    } else {
      output = (msg.event.summary || '(no summary)') + filesLine;
    }
    // Defense in depth: bg_op_started broadcast can fail to land
    // (WS race, opSession unset, etc.) and we'd reach completion
    // with no card to update — agents panel sits empty even though
    // the op spawned + finished. Ensure a card exists FIRST, then
    // flip its state. addAgentFeed is idempotent on existing IDs.
    if (typeof addAgentFeed === 'function') {
      addAgentFeed({
        id: msg.event.opId,
        name: 'Worker: ' + (msg.event.opId || '').slice(0, 60),
        role: 'coder',
        status: statusLabel,
        output: '',
      });
    }
    if (typeof updateAgentFeed === 'function') {
      var feedUpdate = { status: statusLabel, output: output };
      // Build_app and any future op type that emits a resultUrl get
      // a clickable "Open" link in the card. updateAgentFeed renders
      // the URL into the .agent-feed-result-link element.
      if (msg.event.resultUrl) feedUpdate.resultUrl = msg.event.resultUrl;
      updateAgentFeed(msg.event.opId, feedUpdate);
    }
    if (window.desktop) window.desktop.showNotification('Worker finished', (msg.event.summary || '').slice(0, 100));
    // Keep completed cards visible for 30 min so user has plenty of
    // time to notice them. Previously auto-pruned at 2 min, which
    // meant if user wasn't watching the sidebar in that window they
    // had no signal the work landed. (Followup: add a manual dismiss
    // button + auto-collapse on completion so they don't accumulate
    // visually while still being there for reference.)
    setTimeout(function() { try { if (typeof removeAgentFeed === 'function') removeAgentFeed(msg.event.opId); } catch {} }, 30 * 60 * 1000);

    // Note: no synthetic chat message anymore. The agent narrates the
    // completion naturally on the user's NEXT turn via the pending-
    // notifications queue (ops/pending-notifications.ts). Sidebar
    // shows the live state + full result; chat narration happens
    // organically when the user replies.
    return true;
  } catch(e) { console.warn('[bg_op_completed] update failed', e); return false; }
}

// Dispatcher for the bg_op_* / worker_* / av_blocked_warning event family.
// Returns true if the event was handled (caller should `return` from the
// outer handler), false otherwise.
function dispatchBgOpEvent(msg) {
  return dispatchBgOpEventChecked(msg) !== null;
}

// Checked variant for durable relay ACK. Null means this event family does
// not own the event; false means it owned it but a reducer/DOM side effect failed.
function dispatchBgOpEventChecked(msg) {
  switch (msg.event.type) {
    case 'bg_op_queued':           return handleBgOpQueued(msg);
    case 'bg_op_queue_reordered':  return handleBgOpQueueReordered(msg);
    case 'bg_op_started':          return handleBgOpStarted(msg);
    case 'bg_op_progress':         return handleBgOpProgress(msg);
    case 'worker_stream':          return handleWorkerStream(msg);
    case 'worker_done':            return handleWorkerDone(msg);
    case 'av_blocked_warning':     return handleAvBlockedWarning(msg);
    case 'bg_op_nudge':            return handleBgOpNudge(msg);
    case 'bg_op_completed':        return handleBgOpCompleted(msg);
    default: return null;
  }
}
