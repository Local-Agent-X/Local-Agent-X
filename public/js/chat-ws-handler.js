// ── Chat: WebSocket message dispatch ──
//
// The full chatWs.onmessage handler body, lifted out of connectChatWs to
// keep chat-ws.js under 400 LOC. Pure dispatch — every event is handled
// inline in the switch below or routed to a per-feature module
// (chat-tool-cards, chat-agent-feeds, chat-voice, etc.). Closures from
// chat-ws.js (chatWs, activeChatsSet, inflightChatOps) and chat.js
// (streamingSessionId, _liveStreams, addMessageEl, …) resolve at call
// time via the classic-script global lexical environment.

// Render a structured Build-Run Summary from bg_op_completed metadata
// emitted by the primal_run_build_plan orchestrator. Replaces the
// "halt reason as one paragraph" failure mode where the user couldn't
// tell which chunk shipped or how to resume.
function renderBuildRunSummary(meta) {
  const lines = [];
  const projectName = (meta.project_name || 'project').toString();
  const phase = (meta.phase || 'unknown').toString().toUpperCase();
  const committed = Number(meta.chunks_committed || 0);
  const total = Number(meta.total_chunks || 0);
  const pct = total > 0 ? Math.round((committed / total) * 100) : 0;
  const bar = '█'.repeat(Math.floor(pct / 10)) + '░'.repeat(10 - Math.floor(pct / 10));

  lines.push('BUILD RUN — ' + projectName);
  lines.push('Status: ' + phase + (meta.resumable ? '  (resumable)' : ''));
  lines.push('Chunks: ' + committed + '/' + total + ' committed  ' + bar + '  ' + pct + '%');
  if (meta.current_chunk) lines.push('Last touched: chunk ' + meta.current_chunk);
  if (meta.halt_gate) lines.push('Halt gate: ' + meta.halt_gate);
  if (meta.halt_reason) {
    const reasonText = String(meta.halt_reason).slice(0, 280);
    lines.push('Halt reason: ' + reasonText + (String(meta.halt_reason).length > 280 ? '…' : ''));
  }

  const verdicts = Array.isArray(meta.per_chunk_verdicts) ? meta.per_chunk_verdicts : [];
  if (verdicts.length > 0) {
    lines.push('');
    lines.push('Per-chunk verdicts:');
    for (const v of verdicts) {
      lines.push('  chunk ' + v.chunk + ': ' + v.action);
    }
  }

  if (meta.resumable && meta.project_dir) {
    lines.push('');
    const pd = String(meta.project_dir).replace(/\\/g, '\\\\');
    lines.push('Resume:  primal_build_resume({project_dir: "' + pd + '"})');
  }
  if (phase === 'COMPLETE') {
    lines.push('');
    lines.push('Build complete. Review LAUNCH_READINESS.md before deploying.');
  }
  return lines.join('\n');
}

function handleChatWsMessage(e) {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    // Heartbeat pong — server echoed our JSON ping. Bump the
    // lastPong timestamp so the heartbeat loop in chat-ws.js doesn't
    // misclassify the connection as stale and force-reconnect.
    if (msg.type === 'pong') {
      window.chatWsLastPong = Date.now();
      return;
    }

    if (msg.type === 'active_chats') {
      activeChatsSet = new Set(msg.sessionIds || []);
      renderSidebar(); // Update indicators
    }

    if (msg.type === 'event' && msg.sessionId && msg.event) {
      // Track canonical chat opId + seq so we can reconnect-resume after
      // a WS drop. The opId arrives once per turn via `chat_op_started`;
      // every subsequent canonical-tagged event carries `_opId` + `_seq`
      // on the envelope so we know how far we've consumed. Terminal
      // events (done / error) clear the entry.
      if (msg._opId && inflightChatOps.has(msg._opId)) {
        if (typeof msg._seq === 'number') {
          inflightChatOps.get(msg._opId).lastSeenSeq = msg._seq;
        }
      }
      if (msg.event.type === 'chat_op_started' && msg.event.opId) {
        inflightChatOps.set(msg.event.opId, {
          sessionId: msg.sessionId,
          lastSeenSeq: -1,
        });
        return;
      }
      if (msg.event.type === 'done' || msg.event.type === 'error') {
        if (msg._opId) inflightChatOps.delete(msg._opId);
      }
      // Worker-pool ops surface in the AGENTS sidebar (not the chat thread)
      // so background work doesn't pollute the conversation. The sidebar
      // already handles live status updates, output streaming, and removal,
      // and works regardless of which chat is currently active.
      // Step 6 lifecycle: queued → working → completed.
      // bg_op_queued: op submitted but no worker free yet (creates card with
      //   status "queued #N" so user can see queue depth + position).
      // bg_op_started: a worker picked it up (flips card to "working").
      // bg_op_progress: live tool calls / agent text (appended to card output).
      // bg_op_completed: terminal status (status updated; auto-prune at 30 min).
      if (msg.event.type === 'bg_op_queued') {
        try {
          if (typeof addAgentFeed === 'function') {
            addAgentFeed({
              id: msg.event.opId,
              name: 'Worker: ' + (msg.event.task || '').slice(0, 60),
              role: 'coder',
              status: 'queued #' + (msg.event.queuePosition || '?'),
              currentTask: msg.event.task || '',
              output: '⏸ queued (lane: ' + (msg.event.lane || 'build') + ')\n',
            });
          }
        } catch(e) { console.warn('[bg_op_queued] sidebar update failed', e); }
        return;
      }
      if (msg.event.type === 'bg_op_queue_reordered') {
        try {
          if (typeof updateAgentFeed === 'function') {
            updateAgentFeed(msg.event.opId, { status: 'queued #' + msg.event.queuePosition });
          }
        } catch(e) { console.warn('[bg_op_queue_reordered] sidebar update failed', e); }
        return;
      }
      if (msg.event.type === 'bg_op_started') {
        try {
          // Two cases: op was queued first (card already exists, just flip
          // status), OR op dispatched immediately (no prior card, create one).
          // updateAgentFeed is no-op if the card doesn't exist; addAgentFeed
          // is idempotent on existing IDs. So calling both is safe.
          if (typeof updateAgentFeed === 'function') {
            updateAgentFeed(msg.event.opId, { status: 'working', output: '▶ started\n' });
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
              status: 'working',
              currentTask: msg.event.task || '',
              output: '',
            });
          }
        } catch(e) { console.warn('[bg_op_started] sidebar update failed', e); }
        return;
      }
      if (msg.event.type === 'bg_op_progress') {
        try {
          if (typeof updateAgentFeed === 'function') {
            updateAgentFeed(msg.event.opId, { output: (msg.event.line || '') + '\n' });
          }
        } catch(e) { console.warn('[bg_op_progress] sidebar update failed', e); }
        return;
      }
      // worker_stream: worker's own LLM text deltas. JARVIS-mode per
      // user's intent: main chat stays foreground (you keep talking to
      // the main agent), workers narrate themselves in their OWN
      // right-rail card. Worker text deltas land in the same output
      // area as bg_op_progress (tool-call traces) so each worker card
      // shows both reasoning and tool work side-by-side, like a
      // miniature chat thread off to the side.
      // Off-screen sessions still mark themselves in activeChatsSet
      // so the sidebar can flag activity.
      if (msg.event.type === 'worker_stream') {
        if (!(activeChat && activeChat.id === msg.sessionId)) {
          activeChatsSet.add(msg.sessionId);
          if (typeof renderSidebar === 'function') renderSidebar();
        }
        if (typeof updateAgentFeed === 'function') {
          // streamText → worker-text bubble (top of card body).
          // Tool calls / lifecycle markers come in via `output:` from
          // bg_op_progress/queued/started/completed and land in the
          // collapsible worker-tools-group below.
          updateAgentFeed(msg.event.opId, { streamText: (msg.event.delta || '') });
        }
        return;
      }
      if (msg.event.type === 'worker_done') {
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
        return;
      }
      if (msg.event.type === 'av_blocked_warning') {
        try {
          // Sticky banner — user CAN'T fix bash failures without seeing this.
          // Renders once per browser session (matches the once-per-server
          // emission gate so two browser tabs don't double-banner). Stays
          // until user dismisses with the X button.
          if (document.getElementById('av-banner')) return;
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
        } catch(e) { console.warn('[av_blocked_warning] failed', e); }
        return;
      }
      if (msg.event.type === 'bg_op_nudge') {
        try {
          if (activeChat && activeChat.id === msg.sessionId) {
            activeChat.messages = activeChat.messages || [];
            activeChat.messages.push({ role: 'assistant', content: msg.event.text });
            if (typeof renderMessages === 'function') renderMessages();
          } else {
            activeChatsSet.add(msg.sessionId);
            if (typeof renderSidebar === 'function') renderSidebar();
          }
          if (window.desktop) window.desktop.showNotification('Worker finished', msg.event.text);
        } catch(e) { console.warn('[bg_op_nudge] failed', e); }
        return;
      }
      if (msg.event.type === 'bg_op_completed') {
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
        } catch(e) { console.warn('[bg_op_completed] update failed', e); }
        return;
      }

      // If we're viewing this chat AND it's the one streaming via SSE, skip WS events (avoid duplicates)
      if (activeChat && activeChat.id === msg.sessionId && streamingSessionId === msg.sessionId) {
        return;
      }
      // If we're NOT viewing this chat but it's active, update sidebar indicator
      if (!activeChat || activeChat.id !== msg.sessionId) {
        if (msg.event.type === 'done') {
          activeChatsSet.delete(msg.sessionId);
          renderSidebar();
        }
      }
    }

    // ── Agent-triggered settings changes (theme, provider, etc.) ──
    if (msg.type === 'settings_changed' && msg.settings) {
      if (msg.settings.theme && typeof applyTheme === 'function') {
        localStorage.setItem('sax_theme', msg.settings.theme);
        applyTheme(msg.settings.theme);
      }
      // Provider / model change from agent → force-refresh the status bar's
      // dropdowns so it stops showing the stale previous provider.
      if (msg.settings.provider || msg.settings.model) {
        try { const s = JSON.parse(localStorage.getItem('sax_settings') || '{}');
          if (msg.settings.provider) s.provider = msg.settings.provider;
          if (msg.settings.model) s.model = msg.settings.model;
          localStorage.setItem('sax_settings', JSON.stringify(s)); } catch {}
        _providersCacheTime = 0;
        if (typeof loadProviders === 'function') loadProviders().then(() => updateStatusBar()).catch(() => {});
      }
    }

    // ── Sidebar pins changed (agent pinned/unpinned a page) ──
    if (msg.type === 'sidebar_pins_changed' && msg.pins) {
      try {
        _sidebarPins = msg.pins;
        renderSidebarPins();
      } catch(e) { /* app.js not loaded yet — will pick up on next page load */ }
    }

    // ── App files changed: auto-reload any pinned iframe pointing at that app ──
    // Manifest-generator detects edits under workspace/apps/<name>/ and broadcasts.
    // Without this, the pinned-app iframe only refreshed on user click — agents
    // editing files in the background were invisible until a manual click/refresh.
    if (msg.type === 'app-files-changed' && msg.appName) {
      try {
        const pinIframe = document.getElementById('pin-iframe');
        if (pinIframe && pinIframe.src) {
          // Match `/apps/<appName>/` anywhere in the iframe URL (post-token, post-cache-bust).
          const needle = '/apps/' + msg.appName + '/';
          if (pinIframe.src.indexOf(needle) !== -1) {
            // Bump the cache-bust timestamp so the iframe refetches
            const url = new URL(pinIframe.src, window.location.origin);
            url.searchParams.set('_t', Date.now().toString());
            pinIframe.src = url.toString();
          }
        }
      } catch(e) { console.warn('[app-files-changed] iframe reload failed', e); }
    }

    // ── Desktop notifications for important events ──
    if (msg.type === 'agent-complete' && msg.agentId) {
      if (window.desktop) window.desktop.showNotification('Agent Finished', msg.result?.slice(0, 100) || 'Task complete');
    }

    // ── Agent feed events (inline — no monkey-patching needed) ──
    if (msg.type === 'agent-spawn' && msg.agentId) {
      if (typeof addAgentFeed === 'function') addAgentFeed({ id: msg.agentId, name: msg.name, role: msg.role, status: msg.status || 'working', currentTask: msg.task });
    } else if (msg.type === 'agent-update' && msg.agentId) {
      if (typeof updateAgentFeed === 'function') updateAgentFeed(msg.agentId, msg);
    } else if (msg.type === 'agent-output' && msg.agentId) {
      if (typeof updateAgentFeed === 'function') updateAgentFeed(msg.agentId, { output: msg.output });
    } else if (msg.type === 'agent-complete' && msg.agentId) {
      if (typeof updateAgentFeed === 'function') {
        updateAgentFeed(msg.agentId, { status: msg.success ? 'succeeded' : 'failed', output: msg.result ? '[Result] ' + msg.result.slice(0, 500) : '' });
        // Build a concise one-liner for chat — full details on Agents page
        var statusIcon = msg.success ? '\u2705' : '\u274C';
        var fullResult = msg.result || '';
        // Show the full agent result, not just a one-liner
        var agentMsg = statusIcon + ' **Agent ' + (msg.name || msg.agentId || '') + ' ' + (msg.success ? 'completed' : 'failed') + ':**\n\n' + (fullResult || (msg.success ? 'Done.' : 'Agent failed.'));
        // Cap at 5000 chars to prevent UI overflow
        if (agentMsg.length > 5000) agentMsg = agentMsg.slice(0, 5000) + '\n\n[truncated — full result saved to session]';
        addMessageEl('assistant', agentMsg);
        if (activeChat) {
          activeChat.messages.push({ role: 'assistant', content: agentMsg });
          activeChat.updatedAt = Date.now();
          saveChats();
        }
        setTimeout(function() { if (typeof removeAgentFeed === 'function') removeAgentFeed(msg.agentId); }, 10000);
      }
    }
}
