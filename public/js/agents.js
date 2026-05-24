// Agents page entrypoint. Imports each tab module for its side effects
// (window.* assignments so inline onclick attrs resolve) and wires the
// page-init function expected by the SPA router (window.init_<page>).

import { loadProjects } from './agents/projects.js';
import { loadDashboard } from './agents/dashboard.js';
import './agents/team.js';
import './agents/issues.js';
import './agents/history.js';
import './agents/templates.js';
import './agents/active.js';
import './agents/panel.js';
import './agents/tabs.js';
import './agents/orgchart.js';

async function init_agents() {
  // Dashboard is the default tab — load it first so the page paints something
  // useful immediately. Other tabs lazy-load via switchAgentsTab when picked.
  loadProjects();
  loadDashboard();
}
window.init_agents = init_agents;
