// ── IDE Agent Tracking ──
// Monitors spawned sub-agents during IDE app builds, polls for status, renders agent cards

function ideHasActiveAgents() {
  for (const id in _ideTrackedAgents) {
    const s = _ideTrackedAgents[id].status || 'working';
    if (s === 'working' || s === 'running') return true;
  }
  return false;
}

function ideAddAgentCard(agent) {
  const msgs = document.getElementById('ide-chat-messages');
  if (!msgs) return;
  const card = document.createElement('div');
  card.className = 'ide-agent-card working';
  card.id = 'ide-agent-' + agent.id;
  card.innerHTML =
    '<div class="ide-agent-header">' +
      '<span class="ide-tool-spinner"></span>' +
      '<span class="ide-agent-name">' + esc(agent.name || agent.id) + '</span>' +
      '<span class="ide-agent-role">' + esc(agent.role || '') + '</span>' +
    '</div>' +
    '<div class="ide-agent-task">' + esc((agent.task || '').slice(0, 200)) + '</div>' +
    '<div class="ide-agent-output"></div>';
  msgs.appendChild(card);
  msgs.scrollTop = msgs.scrollHeight;
}

function ideUpdateAgentCard(agentId, update) {
  const agent = _ideTrackedAgents[agentId];
  if (!agent) return;
  if (update.status) agent.status = update.status;
  if (update.output) agent.output = (agent.output || '') + update.output;
  if (update.name) agent.name = update.name;

  const card = document.getElementById('ide-agent-' + agentId);
  if (!card) return;
  const isDone = agent.status === 'done' || agent.status === 'completed';
  const isError = agent.status === 'error' || agent.status === 'failed';
  card.className = 'ide-agent-card ' + (isDone ? 'done' : isError ? 'error' : 'working');

  // Replace spinner with status dot when finished
  if (isDone || isError) {
    const spinner = card.querySelector('.ide-tool-spinner');
    if (spinner) {
      const dot = document.createElement('span');
      dot.className = 'indicator ' + (isDone ? 'allowed' : 'blocked');
      spinner.replaceWith(dot);
    }
  }

  // Update output
  if (agent.output) {
    const out = card.querySelector('.ide-agent-output');
    if (out) {
      out.textContent = agent.output.slice(-500);
      out.scrollTop = out.scrollHeight;
    }
  }

  const msgs = document.getElementById('ide-chat-messages');
  if (msgs) msgs.scrollTop = msgs.scrollHeight;
}

function ideStartAgentPolling() {
  if (_ideAgentPollInterval) return;
  _ideAgentPollInterval = setInterval(idePollAgents, 3000);
}

function ideStopAgentPolling() {
  if (_ideAgentPollInterval) { clearInterval(_ideAgentPollInterval); _ideAgentPollInterval = null; }
}

function ideAgentsDone() {
  ideStopAgentPolling();
  ideStopTimer();
  ideSetStatus('done', 'Done (' + _ideToolCount + ' tool' + (_ideToolCount !== 1 ? 's' : '') + ')');
  ideRefreshPreview();
  ideLoadFiles();
  ideEnableInput();
}

async function idePollAgents() {
  if (!ideHasActiveAgents()) { ideAgentsDone(); return; }
  try {
    const r = await fetch(API + '/api/agents/active', {
      headers: { Authorization: 'Bearer ' + AUTH_TOKEN }
    });
    const agents = await r.json();
    if (!Array.isArray(agents)) return;
    for (const a of agents) {
      if (!_ideTrackedAgents[a.id]) continue;
      _ideTrackedAgents[a.id].status = a.status;
      if (a.output) _ideTrackedAgents[a.id].output = a.output;
      ideUpdateAgentCard(a.id, a);
      if (a.status === 'working' || a.status === 'running') {
        ideSetStatus('working', (a.name || 'Agent') + ': ' + (a.progress || 'working...'));
      }
    }
    // Also refresh preview/files periodically while agents work
    ideRefreshPreview();
    ideLoadFiles();
    if (!ideHasActiveAgents()) ideAgentsDone();
  } catch { /* ignore */ }
}
