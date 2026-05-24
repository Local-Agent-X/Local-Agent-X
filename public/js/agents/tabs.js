// Tab switching for the Agents page. Each tab owns its own loader; this
// module just toggles the active class and re-dispatches to the right
// load function so data is fresh on every switch.

import { loadTeam } from './team.js';
import { loadIssues } from './issues.js';
import { loadAgentHistory } from './history.js';
import { loadAgentTemplates } from './templates.js';
import { loadActiveAgents } from './active.js';
import { loadOrgChart } from './orgchart.js';
import { loadDashboard } from './dashboard.js';

export function switchAgentsTab(tab, btn) {
  document.querySelectorAll('.agents-tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.agents-tab').forEach(el => el.classList.remove('active'));
  const panel = document.getElementById('agents-tab-' + tab);
  if (panel) panel.classList.add('active');
  if (btn) btn.classList.add('active');
  // Refresh data
  if (tab === 'dashboard') loadDashboard();
  if (tab === 'team') loadTeam();
  if (tab === 'issues') loadIssues();
  if (tab === 'history') loadAgentHistory();
  if (tab === 'templates') loadAgentTemplates();
  if (tab === 'active') loadActiveAgents();
  if (tab === 'orgchart') loadOrgChart();
}

window.switchAgentsTab = switchAgentsTab;
