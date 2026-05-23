// Agents page entrypoint. Imports each tab module for its side effects
// (window.* assignments so inline onclick attrs resolve) and wires the
// page-init function expected by the SPA router (window.init_<page>).

import { loadProjects } from './agents/projects.js';
import { loadTeam } from './agents/team.js';
import { loadIssues } from './agents/issues.js';
import { loadAgentHistory } from './agents/history.js';
import { loadAgentTemplates } from './agents/templates.js';
import { loadActiveAgents } from './agents/active.js';
import './agents/panel.js';
import './agents/tabs.js';
import './agents/orgchart.js';

async function init_agents() {
  loadProjects();
  loadTeam();
  loadIssues();
  loadAgentHistory();
  loadAgentTemplates();
  loadActiveAgents();
}
window.init_agents = init_agents;
