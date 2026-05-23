// ── App IDE — WebSocket event handler ──
// Routes chat-WS events scoped to the IDE's session into status updates,
// tool-card mutations, agent tracking, and the assistant text bubble.
// State + lifecycle in apps-ide.js; tool cards + preview in
// apps-ide-tools-files.js; agent panel in apps-ide-agents.js.

function ideAttachWsListener() {
  if (_ideWsHandler && typeof chatWs !== 'undefined' && chatWs) {
    chatWs.removeEventListener('message', _ideWsHandler);
  }
  _ideWsHandler = function(e) {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type !== 'event' || msg.sessionId !== _ideSessionId) return;
      const ev = msg.event;
      switch (ev.type) {
        case 'stream':
          _ideContent += ev.delta;
          ideUpdateAssistantMsg(_ideContent);
          break;
        case 'tool_start':
          _ideToolCount++;
          ideSetStatus('working', ideToolLabel(ev.toolName, ev.args));
          ideAddToolCard(ev.toolName, ev.args, ev.riskLevel, ev.context);
          break;
        case 'tool_end': {
          ideFinishToolCard(ev.toolName, ev.result, ev.allowed !== false);
          const toolName = ev.toolName;
          if (['write','edit','build_app','bash'].includes(toolName)) {
            ideRefreshPreview();
            ideLoadFiles();
          }
          ideSetStatus('working', 'Thinking...');
          break;
        }
        case 'agent_spawn':
          if (ev.agent) {
            _ideTrackedAgents[ev.agent.id] = ev.agent;
            ideAddAgentCard(ev.agent);
            ideStartAgentPolling();
            ideSetStatus('working', 'Agent: ' + (ev.agent.name || ev.agent.role || 'working') + '...');
          }
          break;
        case 'agent_status':
          if (ev.agentId) ideUpdateAgentCard(ev.agentId, ev);
          break;
        case 'done':
          _ideStreaming = false;
          _ideContent = '';
          const activeEl = document.getElementById('ide-assistant-active');
          if (activeEl) activeEl.removeAttribute('id');
          // If agents are still running, keep status as working
          if (ideHasActiveAgents()) {
            ideSetStatus('working', 'Agent working...');
          } else {
            ideStopTimer();
            ideSetStatus('done', 'Done (' + _ideToolCount + ' tool' + (_ideToolCount !== 1 ? 's' : '') + ')');
            ideEnableInput();
          }
          ideRefreshPreview();
          ideLoadFiles();
          break;
        case 'error':
          _ideStreaming = false;
          _ideContent = '';
          ideStopTimer();
          ideStopAgentPolling();
          ideSetStatus('error', ev.message || ev.error || 'Error');
          ideAddMessage('assistant', 'Error: ' + (ev.message || ev.error || 'Something went wrong'));
          ideEnableInput();
          break;
      }
    } catch (err) { /* ignore */ }
  };
  if (typeof chatWs !== 'undefined' && chatWs) {
    chatWs.addEventListener('message', _ideWsHandler);
  }
}

function ideToolLabel(name, args) {
  if (typeof toolSummary === 'function') return toolSummary(name, args);
  switch (name) {
    case 'build_app': return 'Building app...';
    case 'write': return 'Writing ' + ((args && args.path) || 'file').split(/[/\\]/).pop();
    case 'edit': return 'Editing ' + ((args && args.path) || 'file').split(/[/\\]/).pop();
    case 'read': return 'Reading ' + ((args && args.path) || 'file').split(/[/\\]/).pop();
    case 'bash': return 'Running: ' + ((args && args.command) || '').slice(0, 40);
    case 'glob': return 'Searching files...';
    case 'grep': return 'Searching code...';
    default: return name + '...';
  }
}

function ideUpdateAssistantMsg(content) {
  let el = document.getElementById('ide-assistant-active');
  if (!el) {
    ideAddMessage('assistant', '', true);
    el = document.getElementById('ide-assistant-active');
  }
  if (!el) return;
  // First stream event: drop the thinking indicator so text can replace it
  const thinking = el.querySelector('.ide-thinking');
  if (thinking) thinking.remove();
  // Maintain a dedicated text node separate from tool cards so neither clobbers the other
  let textEl = el.querySelector('.ide-text');
  if (!textEl) {
    textEl = document.createElement('div');
    textEl.className = 'ide-text';
    el.insertBefore(textEl, el.firstChild);
  }
  textEl.innerHTML = typeof md === 'function' ? md(content) : content;
  const msgs = document.getElementById('ide-chat-messages');
  if (msgs) msgs.scrollTop = msgs.scrollHeight;
}
