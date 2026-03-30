/**
 * Dashboard Renderer — generates standalone HTML from a DashboardDefinition.
 *
 * Produces a self-contained HTML file with:
 * - The app's dark theme CSS
 * - A lightweight vanilla JS component renderer
 * - WebSocket/polling bridge to the state API
 * - Event dispatching for user interactions
 */

import type { DashboardDefinition, ComponentDefinition, LayoutDefinition } from "./dashboard-runtime.js";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderComponent(comp: ComponentDefinition): string {
  const id = escapeHtml(comp.id);
  const props = comp.props || {};

  switch (comp.type) {
    case "text":
      return `<div class="dash-text" id="${id}">${props.content || ""}</div>`;

    case "stat":
      return `<div class="dash-stat" id="${id}">
        <div class="dash-stat-label">${escapeHtml(String(props.label || ""))}</div>
        <div class="dash-stat-value" data-bind="value">${escapeHtml(String(props.value || "0"))}</div>
        ${props.unit ? `<div class="dash-stat-unit">${escapeHtml(String(props.unit))}</div>` : ""}
      </div>`;

    case "button":
      return `<button class="dash-btn" id="${id}" onclick="dashEvent('click','${id}')">${escapeHtml(String(props.label || "Button"))}</button>`;

    case "input":
      return `<div class="dash-field" id="${id}-wrap">
        ${props.label ? `<label class="dash-label">${escapeHtml(String(props.label))}</label>` : ""}
        <input class="dash-input" id="${id}" type="${props.inputType || "text"}" placeholder="${escapeHtml(String(props.placeholder || ""))}" value="${escapeHtml(String(props.value || ""))}" oninput="dashEvent('input','${id}',this.value)">
      </div>`;

    case "select":
      const options = (Array.isArray(props.options) ? props.options : []) as string[];
      return `<div class="dash-field" id="${id}-wrap">
        ${props.label ? `<label class="dash-label">${escapeHtml(String(props.label))}</label>` : ""}
        <select class="dash-select" id="${id}" onchange="dashEvent('change','${id}',this.value)">
          ${options.map(o => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("")}
        </select>
      </div>`;

    case "toggle":
      return `<label class="dash-toggle" id="${id}-wrap">
        <input type="checkbox" id="${id}" ${props.checked ? "checked" : ""} onchange="dashEvent('toggle','${id}',this.checked)">
        <span class="dash-toggle-label">${escapeHtml(String(props.label || ""))}</span>
      </label>`;

    case "table": {
      const columns = (Array.isArray(props.columns) ? props.columns : []) as string[];
      const rows = (Array.isArray(props.rows) ? props.rows : []) as unknown[][];
      return `<div class="dash-table-wrap" id="${id}">
        <table class="dash-table">
          <thead><tr>${columns.map(c => `<th>${escapeHtml(String(c))}</th>`).join("")}</tr></thead>
          <tbody data-bind="rows">${rows.map(row =>
            `<tr>${(Array.isArray(row) ? row : []).map(cell => `<td>${escapeHtml(String(cell))}</td>`).join("")}</tr>`
          ).join("")}</tbody>
        </table>
      </div>`;
    }

    case "chart":
      return `<div class="dash-chart" id="${id}">
        <canvas id="${id}-canvas" width="${props.width || 400}" height="${props.height || 250}"></canvas>
        <div class="dash-chart-label">${escapeHtml(String(props.label || ""))}</div>
      </div>`;

    case "list": {
      const items = (Array.isArray(props.items) ? props.items : []) as string[];
      return `<div class="dash-list" id="${id}">
        ${props.label ? `<div class="dash-list-label">${escapeHtml(String(props.label))}</div>` : ""}
        <ul data-bind="items">${items.map(i => `<li>${escapeHtml(String(i))}</li>`).join("")}</ul>
      </div>`;
    }

    case "image":
      return `<div class="dash-image" id="${id}">
        <img src="${escapeHtml(String(props.src || ""))}" alt="${escapeHtml(String(props.alt || ""))}" style="max-width:100%">
      </div>`;

    case "form": {
      const fields = comp.children || [];
      return `<form class="dash-form" id="${id}" onsubmit="event.preventDefault();dashEvent('submit','${id}',Object.fromEntries(new FormData(this)))">
        ${fields.map(renderComponent).join("\n")}
        <button class="dash-btn" type="submit">${escapeHtml(String(props.submitLabel || "Submit"))}</button>
      </form>`;
    }

    case "custom":
      return `<div class="dash-custom" id="${id}">${props.html || ""}</div>`;

    default:
      return `<div class="dash-unknown" id="${id}">[Unknown: ${comp.type}]</div>`;
  }
}

function renderLayout(layout: LayoutDefinition, components: ComponentDefinition[]): string {
  const gap = layout.gap || "16px";

  switch (layout.type) {
    case "grid": {
      const cols = layout.columns || 2;
      return `<div class="dash-grid" style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:${gap}">
        ${components.map(renderComponent).join("\n")}
      </div>`;
    }
    case "flex":
      return `<div class="dash-flex" style="display:flex;flex-wrap:wrap;gap:${gap}">
        ${components.map(c => `<div style="flex:1;min-width:250px">${renderComponent(c)}</div>`).join("\n")}
      </div>`;
    case "stack":
      return `<div class="dash-stack" style="display:flex;flex-direction:column;gap:${gap}">
        ${components.map(renderComponent).join("\n")}
      </div>`;
    case "tabs": {
      return `<div class="dash-tabs">
        <div class="dash-tab-bar">${components.map((c, i) =>
          `<button class="dash-tab-btn${i === 0 ? " active" : ""}" onclick="switchTab(this,${i})">${escapeHtml(String(c.props.tabLabel || c.id))}</button>`
        ).join("")}</div>
        ${components.map((c, i) =>
          `<div class="dash-tab-panel${i === 0 ? " active" : ""}" data-tab="${i}">${renderComponent(c)}</div>`
        ).join("")}
      </div>`;
    }
    case "sidebar":
      return `<div class="dash-sidebar-layout" style="display:grid;grid-template-columns:250px 1fr;gap:${gap}">
        ${components.length > 0 ? `<div class="dash-sidebar">${renderComponent(components[0])}</div>` : ""}
        <div class="dash-main">${components.slice(1).map(renderComponent).join("\n")}</div>
      </div>`;
    default:
      return components.map(renderComponent).join("\n");
  }
}

export function renderDashboard(def: DashboardDefinition, port?: number): string {
  const apiBase = `http://127.0.0.1:${port || 4800}`;
  const componentsHtml = renderLayout(def.layout, def.components);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(def.name)} — Dashboard</title>
  <style>
    :root {
      --bg: #0a0a0a; --bg2: #141414; --bg3: #1e1e1e;
      --fg: #e0e0e0; --muted: #888;
      --accent: #00d4ff; --accent2: #0af;
      --border: #2a2a2a; --radius: 8px;
      --sans: system-ui, -apple-system, sans-serif;
      --mono: 'SF Mono', 'Fira Code', monospace;
      --green: #4caf50; --red: #f44336; --yellow: #ffc107; --blue: #2196f3;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--fg); font-family: var(--sans); padding: 24px; min-height: 100vh; }
    h1 { font-size: 1.5rem; font-weight: 600; margin-bottom: 4px; }
    .dash-desc { color: var(--muted); font-size: .85rem; margin-bottom: 20px; }

    /* Components */
    .dash-stat { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; text-align: center; }
    .dash-stat-label { font-size: .75rem; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; margin-bottom: 4px; }
    .dash-stat-value { font-size: 2rem; font-weight: 700; color: var(--accent); font-family: var(--mono); }
    .dash-stat-unit { font-size: .7rem; color: var(--muted); }

    .dash-text { padding: 8px 0; line-height: 1.5; }

    .dash-btn { background: var(--accent); color: #000; border: none; border-radius: var(--radius); padding: 8px 20px; font-weight: 600; cursor: pointer; font-size: .85rem; transition: opacity .15s; }
    .dash-btn:hover { opacity: .85; }

    .dash-field { margin-bottom: 12px; }
    .dash-label { display: block; font-size: .75rem; color: var(--muted); margin-bottom: 4px; }
    .dash-input, .dash-select { width: 100%; background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 8px 12px; color: var(--fg); font-size: .85rem; outline: none; }
    .dash-input:focus, .dash-select:focus { border-color: var(--accent); }

    .dash-toggle { display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: .85rem; }
    .dash-toggle input { width: 16px; height: 16px; accent-color: var(--accent); }

    .dash-table-wrap { overflow-x: auto; }
    .dash-table { width: 100%; border-collapse: collapse; font-size: .8rem; }
    .dash-table th { background: var(--bg3); color: var(--muted); text-transform: uppercase; font-size: .7rem; letter-spacing: .05em; padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); }
    .dash-table td { padding: 8px 12px; border-bottom: 1px solid var(--border); }
    .dash-table tr:hover { background: var(--bg2); }

    .dash-chart { background: var(--bg2); border-radius: var(--radius); padding: 16px; }
    .dash-chart-label { font-size: .75rem; color: var(--muted); text-align: center; margin-top: 8px; }

    .dash-list { background: var(--bg2); border-radius: var(--radius); padding: 12px 16px; }
    .dash-list-label { font-size: .75rem; color: var(--muted); margin-bottom: 8px; }
    .dash-list ul { list-style: none; }
    .dash-list li { padding: 6px 0; border-bottom: 1px solid var(--border); font-size: .85rem; }
    .dash-list li:last-child { border-bottom: none; }

    .dash-form { background: var(--bg2); border-radius: var(--radius); padding: 16px; }

    .dash-image img { border-radius: var(--radius); }

    /* Tabs */
    .dash-tab-bar { display: flex; gap: 4px; margin-bottom: 16px; border-bottom: 1px solid var(--border); }
    .dash-tab-btn { background: none; border: none; color: var(--muted); padding: 8px 16px; cursor: pointer; border-bottom: 2px solid transparent; font-size: .85rem; }
    .dash-tab-btn.active { color: var(--accent); border-bottom-color: var(--accent); }
    .dash-tab-panel { display: none; }
    .dash-tab-panel.active { display: block; }

    /* Status indicator */
    .dash-status { position: fixed; bottom: 12px; right: 12px; font-size: .7rem; color: var(--muted); background: var(--bg2); padding: 4px 10px; border-radius: 12px; border: 1px solid var(--border); }
    .dash-status.connected { color: var(--green); }
  </style>
</head>
<body>
  <h1>${escapeHtml(def.name)}</h1>
  <div class="dash-desc">${escapeHtml(def.description)}</div>
  ${componentsHtml}
  <div class="dash-status" id="dash-status">Connecting...</div>

<script>
const DASH_ID = ${JSON.stringify(def.id)};
const API = ${JSON.stringify(apiBase)};
const AUTH = localStorage.getItem('sax_token') || '';
const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + AUTH };

// ── Event dispatch → server ──
function dashEvent(type, componentId, data) {
  fetch(API + '/api/dashboards/' + DASH_ID + '/events', {
    method: 'POST', headers,
    body: JSON.stringify({ type, sourceComponent: componentId, data })
  }).catch(() => {});
}

// ── Tab switching ──
function switchTab(btn, idx) {
  btn.parentElement.querySelectorAll('.dash-tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  btn.closest('.dash-tabs').querySelectorAll('.dash-tab-panel').forEach((p, i) => {
    p.classList.toggle('active', i === idx);
  });
}

// ── State polling — applies agent updates to the DOM ──
let lastUpdate = 0;
async function pollState() {
  try {
    const r = await fetch(API + '/api/dashboards/' + DASH_ID + '/state', { headers: { Authorization: 'Bearer ' + AUTH } });
    if (!r.ok) return;
    const state = await r.json();
    const status = document.getElementById('dash-status');
    if (status) { status.textContent = 'Connected'; status.className = 'dash-status connected'; }

    // Apply component values
    for (const [compId, value] of Object.entries(state.componentValues || {})) {
      const el = document.getElementById(compId);
      if (!el) continue;
      if (el.tagName === 'INPUT' || el.tagName === 'SELECT') {
        if (el.type === 'checkbox') el.checked = !!value;
        else el.value = String(value);
      } else {
        const bound = el.querySelector('[data-bind]');
        if (bound) {
          const bind = bound.getAttribute('data-bind');
          if (bind === 'value') bound.textContent = String(value);
          else if (bind === 'rows' && Array.isArray(value)) {
            bound.innerHTML = value.map(row =>
              '<tr>' + (Array.isArray(row) ? row : []).map(c => '<td>' + c + '</td>').join('') + '</tr>'
            ).join('');
          } else if (bind === 'items' && Array.isArray(value)) {
            bound.innerHTML = value.map(i => '<li>' + i + '</li>').join('');
          }
        } else {
          el.textContent = String(value);
        }
      }
    }

    // Process action queue
    const pending = (state.actionQueue || []).filter(a => !a.consumed);
    const consumed = [];
    for (const act of pending) {
      const el = act.target ? document.getElementById(act.target) : null;
      switch (act.action) {
        case 'click': if (el) el.click(); break;
        case 'fill': if (el) { el.value = String(act.value || ''); el.dispatchEvent(new Event('input')); } break;
        case 'focus': if (el) el.focus(); break;
        case 'scroll': if (el) el.scrollIntoView({ behavior: 'smooth' }); break;
        case 'addClass': if (el && act.value) el.classList.add(String(act.value)); break;
        case 'removeClass': if (el && act.value) el.classList.remove(String(act.value)); break;
        case 'setHtml': if (el) el.innerHTML = String(act.value || ''); break;
        case 'refresh': window.location.reload(); break;
      }
      consumed.push(act.id);
    }
    if (consumed.length > 0) {
      fetch(API + '/api/dashboards/' + DASH_ID + '/actions/consume', {
        method: 'POST', headers,
        body: JSON.stringify({ actionIds: consumed })
      }).catch(() => {});
    }
  } catch {
    const status = document.getElementById('dash-status');
    if (status) { status.textContent = 'Disconnected'; status.className = 'dash-status'; }
  }
}

// Poll every 2 seconds
setInterval(pollState, 2000);
pollState();
</script>
</body>
</html>`;
}
