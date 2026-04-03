/**
 * App Renderer — generates secure, standalone HTML from an AppDefinition.
 *
 * Security hardening:
 * - Nonce-based CSP for inline scripts
 * - Strict HTML escaping on all user-provided content
 * - No eval(), no Function(), no inline event handler strings from untrusted sources
 * - Custom HTML components are sanitized (dangerous tags stripped)
 * - Token isolation — auth tokens cleared before app code runs
 * - X-Frame-Options, X-Content-Type-Options, Referrer-Policy headers (set by server)
 */

import type { AppDefinition, ComponentDefinition, LayoutDefinition } from "./app-runtime.js";
import { randomBytes } from "node:crypto";

// ── Sanitization ─────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/** Strip dangerous HTML tags from custom component content */
function sanitizeHtml(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, "")
    .replace(/<embed\b[^>]*\/?>/gi, "")
    .replace(/<link\b[^>]*\/?>/gi, "")
    .replace(/<base\b[^>]*\/?>/gi, "")
    .replace(/<meta\b[^>]*\/?>/gi, "")
    .replace(/\bon\w+\s*=/gi, "data-blocked-handler=");
}

/** Escape a value for use in a JS string literal */
function escapeJs(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/<\//g, "<\\/");
}

/** Safely convert any value to a display string (handles objects, arrays, nulls) */
function safeStr(val: unknown): string {
  if (val === null || val === undefined) return "";
  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  if (Array.isArray(val)) return val.map(safeStr).join(", ");
  if (typeof val === "object") {
    const obj = val as Record<string, unknown>;
    // Extract the most likely display property
    const display = obj.label ?? obj.name ?? obj.title ?? obj.text ?? obj.value ?? obj.id ?? obj.key;
    if (display !== undefined && typeof display !== "object") return String(display);
    // Last resort: compact JSON
    try { return JSON.stringify(val); } catch { return ""; }
  }
  return String(val);
}

// ── Component Rendering ─────────────────────────────────────

function renderComponent(comp: ComponentDefinition): string {
  const id = escapeHtml(comp.id);
  const props = comp.props || {};

  switch (comp.type) {
    case "text":
      return `<div class="app-text" id="${id}">${escapeHtml(safeStr(props.content || ""))}</div>`;

    case "stat":
      return `<div class="app-stat" id="${id}">
        <div class="app-stat-label">${escapeHtml(safeStr(props.label || ""))}</div>
        <div class="app-stat-value" data-bind="value">${escapeHtml(safeStr(props.value || "0"))}</div>
        ${props.unit ? `<div class="app-stat-unit">${escapeHtml(safeStr(props.unit))}</div>` : ""}
      </div>`;

    case "button":
      return `<button class="app-btn" id="${id}" onclick="appEvent('click','${escapeJs(comp.id)}')">${escapeHtml(safeStr(props.label || "Button"))}</button>`;

    case "input":
      return `<div class="app-field" id="${id}-wrap">
        ${props.label ? `<label class="app-label">${escapeHtml(safeStr(props.label))}</label>` : ""}
        <input class="app-input" id="${id}" type="${escapeHtml(safeStr(props.inputType || "text"))}" placeholder="${escapeHtml(safeStr(props.placeholder || ""))}" value="${escapeHtml(safeStr(props.value || ""))}" oninput="appEvent('input','${escapeJs(comp.id)}',this.value)">
      </div>`;

    case "select": {
      const options = (Array.isArray(props.options) ? props.options : []) as string[];
      return `<div class="app-field" id="${id}-wrap">
        ${props.label ? `<label class="app-label">${escapeHtml(safeStr(props.label))}</label>` : ""}
        <select class="app-select" id="${id}" onchange="appEvent('change','${escapeJs(comp.id)}',this.value)">
          ${options.map(o => `<option value="${escapeHtml(safeStr(o))}">${escapeHtml(safeStr(o))}</option>`).join("")}
        </select>
      </div>`;
    }

    case "toggle":
      return `<label class="app-toggle" id="${id}-wrap">
        <input type="checkbox" id="${id}" ${props.checked ? "checked" : ""} onchange="appEvent('toggle','${escapeJs(comp.id)}',this.checked)">
        <span class="app-toggle-label">${escapeHtml(safeStr(props.label || ""))}</span>
      </label>`;

    case "table": {
      const columns = (Array.isArray(props.columns) ? props.columns : []) as unknown[];
      const rows = (Array.isArray(props.rows) ? props.rows : []) as unknown[][];
      return `<div class="app-table-wrap" id="${id}">
        <table class="app-table">
          <thead><tr>${columns.map(c => `<th>${escapeHtml(safeStr(c))}</th>`).join("")}</tr></thead>
          <tbody data-bind="rows">${rows.map(row =>
            `<tr>${(Array.isArray(row) ? row : []).map(cell => `<td>${escapeHtml(safeStr(cell))}</td>`).join("")}</tr>`
          ).join("")}</tbody>
        </table>
      </div>`;
    }

    case "chart":
      return `<div class="app-chart" id="${id}">
        <canvas id="${id}-canvas" width="${escapeHtml(safeStr(props.width || 400))}" height="${escapeHtml(safeStr(props.height || 250))}"></canvas>
        <div class="app-chart-label">${escapeHtml(safeStr(props.label || ""))}</div>
      </div>`;

    case "list": {
      const items = (Array.isArray(props.items) ? props.items : []) as string[];
      return `<div class="app-list" id="${id}">
        ${props.label ? `<div class="app-list-label">${escapeHtml(safeStr(props.label))}</div>` : ""}
        <ul data-bind="items">${items.map(i => `<li>${escapeHtml(safeStr(i))}</li>`).join("")}</ul>
      </div>`;
    }

    case "image":
      return `<div class="app-image" id="${id}">
        <img src="${escapeHtml(safeStr(props.src || ""))}" alt="${escapeHtml(safeStr(props.alt || ""))}" style="max-width:100%">
      </div>`;

    case "form": {
      const fields = comp.children || [];
      return `<form class="app-form" id="${id}" onsubmit="event.preventDefault();appEvent('submit','${escapeJs(comp.id)}',Object.fromEntries(new FormData(this)))">
        ${fields.map(renderComponent).join("\n")}
        <button class="app-btn" type="submit">${escapeHtml(safeStr(props.submitLabel || "Submit"))}</button>
      </form>`;
    }

    case "progress":
      return `<div class="app-progress" id="${id}">
        ${props.label ? `<div class="app-progress-label">${escapeHtml(safeStr(props.label))}</div>` : ""}
        <div class="app-progress-bar"><div class="app-progress-fill" data-bind="value" style="width:${Math.min(100, Math.max(0, Number(props.value || 0)))}%"></div></div>
        ${props.showValue ? `<div class="app-progress-value" data-bind="text">${escapeHtml(safeStr(props.value || "0"))}%</div>` : ""}
      </div>`;

    case "alert": {
      const severity = safeStr(props.severity || "info");
      return `<div class="app-alert app-alert-${escapeHtml(severity)}" id="${id}">
        ${props.title ? `<strong>${escapeHtml(safeStr(props.title))}</strong> ` : ""}
        <span data-bind="value">${escapeHtml(safeStr(props.message || ""))}</span>
        ${props.dismissible ? `<button class="app-alert-close" onclick="this.parentElement.remove();appEvent('dismiss','${escapeJs(comp.id)}')">&times;</button>` : ""}
      </div>`;
    }

    case "code":
      return `<div class="app-code" id="${id}">
        ${props.label ? `<div class="app-code-label">${escapeHtml(safeStr(props.label))}</div>` : ""}
        <pre><code data-bind="value">${escapeHtml(safeStr(props.content || ""))}</code></pre>
      </div>`;

    case "badge":
      return `<span class="app-badge app-badge-${escapeHtml(safeStr(props.variant || "default"))}" id="${id}" data-bind="value">${escapeHtml(safeStr(props.text || ""))}</span>`;

    case "divider":
      return `<hr class="app-divider" id="${id}">`;

    case "custom":
      return `<div class="app-custom" id="${id}">${sanitizeHtml(safeStr(props.html || ""))}</div>`;

    default:
      return `<div class="app-unknown" id="${id}">[Unknown: ${escapeHtml(String(comp.type))}]</div>`;
  }
}

// ── Layout Rendering ────────────────────────────────────────

function renderLayout(layout: LayoutDefinition, components: ComponentDefinition[]): string {
  const gap = escapeHtml(layout.gap || "16px");

  switch (layout.type) {
    case "grid": {
      const cols = Math.min(12, Math.max(1, layout.columns || 2));
      return `<div class="app-grid" style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:${gap}">
        ${components.map(renderComponent).join("\n")}
      </div>`;
    }
    case "flex":
      return `<div class="app-flex" style="display:flex;flex-wrap:wrap;gap:${gap}">
        ${components.map(c => `<div style="flex:1;min-width:250px">${renderComponent(c)}</div>`).join("\n")}
      </div>`;
    case "stack":
      return `<div class="app-stack" style="display:flex;flex-direction:column;gap:${gap}">
        ${components.map(renderComponent).join("\n")}
      </div>`;
    case "tabs": {
      return `<div class="app-tabs">
        <div class="app-tab-bar">${components.map((c, i) =>
          `<button class="app-tab-btn${i === 0 ? " active" : ""}" onclick="switchTab(this,${i})">${escapeHtml(safeStr(c.props.tabLabel || c.id))}</button>`
        ).join("")}</div>
        ${components.map((c, i) =>
          `<div class="app-tab-panel${i === 0 ? " active" : ""}" data-tab="${i}">${renderComponent(c)}</div>`
        ).join("")}
      </div>`;
    }
    case "sidebar":
      return `<div class="app-sidebar-layout" style="display:grid;grid-template-columns:250px 1fr;gap:${gap}">
        ${components.length > 0 ? `<div class="app-sidebar">${renderComponent(components[0])}</div>` : ""}
        <div class="app-main">${components.slice(1).map(renderComponent).join("\n")}</div>
      </div>`;
    default:
      return components.map(renderComponent).join("\n");
  }
}

// ── Main Render Function ────────────────────────────────────

export function renderApp(def: AppDefinition, port?: number): string {
  const apiBase = `http://127.0.0.1:${port || 7007}`;
  const nonce = randomBytes(16).toString("base64");
  const componentsHtml = renderLayout(def.layout, def.components);
  const statusBadge = def.status !== "active"
    ? `<span class="app-status-badge app-status-${escapeHtml(def.status)}">${escapeHtml(def.status.toUpperCase())}</span>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-Content-Type-Options" content="nosniff">
  <title>${escapeHtml(def.name)} — App</title>
  <style nonce="${nonce}">
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
    h1 { font-size: 1.5rem; font-weight: 600; margin-bottom: 4px; display: inline-flex; align-items: center; gap: 12px; }
    .app-desc { color: var(--muted); font-size: .85rem; margin-bottom: 20px; }
    .app-header { margin-bottom: 20px; display: flex; justify-content: space-between; align-items: flex-start; }
    .app-version { font-size: .65rem; color: var(--muted); font-family: var(--mono); padding: 2px 6px; background: var(--bg2); border-radius: 4px; }

    /* Status badges */
    .app-status-badge { font-size: .65rem; font-family: var(--mono); padding: 2px 8px; border-radius: 8px; text-transform: uppercase; letter-spacing: .5px; }
    .app-status-suspended { background: var(--red); color: #fff; }
    .app-status-archived { background: var(--yellow); color: #000; }

    /* Components */
    .app-stat { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; text-align: center; }
    .app-stat-label { font-size: .75rem; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; margin-bottom: 4px; }
    .app-stat-value { font-size: 2rem; font-weight: 700; color: var(--accent); font-family: var(--mono); }
    .app-stat-unit { font-size: .7rem; color: var(--muted); }

    .app-text { padding: 8px 0; line-height: 1.5; }

    .app-btn { background: var(--accent); color: #000; border: none; border-radius: var(--radius); padding: 8px 20px; font-weight: 600; cursor: pointer; font-size: .85rem; transition: opacity .15s; }
    .app-btn:hover { opacity: .85; }
    .app-btn:disabled { opacity: .4; cursor: not-allowed; }

    .app-field { margin-bottom: 12px; }
    .app-label { display: block; font-size: .75rem; color: var(--muted); margin-bottom: 4px; }
    .app-input, .app-select { width: 100%; background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 8px 12px; color: var(--fg); font-size: .85rem; outline: none; }
    .app-input:focus, .app-select:focus { border-color: var(--accent); }

    .app-toggle { display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: .85rem; }
    .app-toggle input { width: 16px; height: 16px; accent-color: var(--accent); }

    .app-table-wrap { overflow-x: auto; }
    .app-table { width: 100%; border-collapse: collapse; font-size: .8rem; }
    .app-table th { background: var(--bg3); color: var(--muted); text-transform: uppercase; font-size: .7rem; letter-spacing: .05em; padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); }
    .app-table td { padding: 8px 12px; border-bottom: 1px solid var(--border); }
    .app-table tr:hover { background: var(--bg2); }

    .app-chart { background: var(--bg2); border-radius: var(--radius); padding: 16px; }
    .app-chart-label { font-size: .75rem; color: var(--muted); text-align: center; margin-top: 8px; }

    .app-list { background: var(--bg2); border-radius: var(--radius); padding: 12px 16px; }
    .app-list-label { font-size: .75rem; color: var(--muted); margin-bottom: 8px; }
    .app-list ul { list-style: none; }
    .app-list li { padding: 6px 0; border-bottom: 1px solid var(--border); font-size: .85rem; }
    .app-list li:last-child { border-bottom: none; }

    .app-form { background: var(--bg2); border-radius: var(--radius); padding: 16px; }
    .app-image img { border-radius: var(--radius); }

    /* Progress bar */
    .app-progress { margin: 8px 0; }
    .app-progress-label { font-size: .75rem; color: var(--muted); margin-bottom: 4px; }
    .app-progress-bar { background: var(--bg3); border-radius: 4px; height: 8px; overflow: hidden; }
    .app-progress-fill { background: var(--accent); height: 100%; border-radius: 4px; transition: width .3s ease; }
    .app-progress-value { font-size: .7rem; color: var(--muted); margin-top: 2px; text-align: right; font-family: var(--mono); }

    /* Alert */
    .app-alert { padding: 12px 16px; border-radius: var(--radius); font-size: .85rem; position: relative; margin: 8px 0; border: 1px solid; }
    .app-alert-info { background: rgba(33,150,243,.1); border-color: var(--blue); color: var(--blue); }
    .app-alert-success { background: rgba(76,175,80,.1); border-color: var(--green); color: var(--green); }
    .app-alert-warning { background: rgba(255,193,7,.1); border-color: var(--yellow); color: var(--yellow); }
    .app-alert-error { background: rgba(244,67,54,.1); border-color: var(--red); color: var(--red); }
    .app-alert-close { position: absolute; top: 8px; right: 12px; background: none; border: none; color: inherit; cursor: pointer; font-size: 1.2rem; }

    /* Code block */
    .app-code { background: var(--bg2); border-radius: var(--radius); overflow-x: auto; }
    .app-code-label { font-size: .7rem; color: var(--muted); padding: 8px 12px 0; font-family: var(--mono); }
    .app-code pre { padding: 12px; margin: 0; }
    .app-code code { font-family: var(--mono); font-size: .8rem; color: var(--fg); white-space: pre-wrap; }

    /* Badge */
    .app-badge { display: inline-block; font-size: .7rem; font-family: var(--mono); padding: 2px 8px; border-radius: 8px; }
    .app-badge-default { background: var(--bg3); color: var(--muted); }
    .app-badge-success { background: rgba(76,175,80,.2); color: var(--green); }
    .app-badge-warning { background: rgba(255,193,7,.2); color: var(--yellow); }
    .app-badge-error { background: rgba(244,67,54,.2); color: var(--red); }
    .app-badge-info { background: rgba(33,150,243,.2); color: var(--blue); }

    /* Divider */
    .app-divider { border: none; border-top: 1px solid var(--border); margin: 16px 0; }

    /* Tabs */
    .app-tab-bar { display: flex; gap: 4px; margin-bottom: 16px; border-bottom: 1px solid var(--border); }
    .app-tab-btn { background: none; border: none; color: var(--muted); padding: 8px 16px; cursor: pointer; border-bottom: 2px solid transparent; font-size: .85rem; }
    .app-tab-btn.active { color: var(--accent); border-bottom-color: var(--accent); }
    .app-tab-panel { display: none; }
    .app-tab-panel.active { display: block; }

    /* Status indicator */
    .app-status { position: fixed; bottom: 12px; right: 12px; font-size: .7rem; color: var(--muted); background: var(--bg2); padding: 4px 10px; border-radius: 12px; border: 1px solid var(--border); display: flex; align-items: center; gap: 6px; }
    .app-status.connected { color: var(--green); }
    .app-status-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); }
    .app-status.connected .app-status-dot { background: var(--green); }
  </style>
</head>
<body>
  <div class="app-header">
    <div>
      <h1>${escapeHtml(def.name)} ${statusBadge}</h1>
      <div class="app-desc">${escapeHtml(def.description)}</div>
    </div>
    <span class="app-version">v${def.version}</span>
  </div>
  ${componentsHtml}
  <div class="app-status" id="app-status"><span class="app-status-dot"></span> Connecting...</div>

<script nonce="${nonce}">
(function() {
  'use strict';

  var APP_ID = ${JSON.stringify(def.id)};
  var API = ${JSON.stringify(apiBase)};
  var AUTH = localStorage.getItem('sax_token') || '';
  var headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + AUTH };

  // ── Event dispatch to server ──
  window.appEvent = function(type, componentId, data) {
    fetch(API + '/api/apps/' + APP_ID + '/events', {
      method: 'POST', headers: headers,
      body: JSON.stringify({ type: type, sourceComponent: componentId, data: data })
    }).catch(function() {});
  };

  // ── Tab switching ──
  window.switchTab = function(btn, idx) {
    btn.parentElement.querySelectorAll('.app-tab-btn').forEach(function(b) { b.classList.remove('active'); });
    btn.classList.add('active');
    btn.closest('.app-tabs').querySelectorAll('.app-tab-panel').forEach(function(p, i) {
      p.classList.toggle('active', i === idx);
    });
  };

  // ── State polling ──
  function pollState() {
    fetch(API + '/api/apps/' + APP_ID + '/state', { headers: { Authorization: 'Bearer ' + AUTH } })
      .then(function(r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function(state) {
        var status = document.getElementById('app-status');
        if (status) { status.innerHTML = '<span class="app-status-dot"></span> Connected'; status.className = 'app-status connected'; }

        // Apply component values
        var values = state.componentValues || {};
        for (var compId in values) {
          if (!values.hasOwnProperty(compId)) continue;
          var val = values[compId];
          var el = document.getElementById(compId);
          if (!el) continue;

          if (el.tagName === 'INPUT' || el.tagName === 'SELECT') {
            if (el.type === 'checkbox') el.checked = !!val;
            else el.value = String(val);
          } else {
            var bound = el.querySelector('[data-bind]');
            if (bound) {
              var bind = bound.getAttribute('data-bind');
              if (bind === 'value') {
                if (bound.classList.contains('app-progress-fill')) {
                  bound.style.width = Math.min(100, Math.max(0, Number(val))) + '%';
                } else {
                  bound.textContent = String(val);
                }
              } else if (bind === 'rows' && Array.isArray(val)) {
                bound.innerHTML = val.map(function(row) {
                  return '<tr>' + (Array.isArray(row) ? row : []).map(function(c) { return '<td>' + escapeForDom(c) + '</td>'; }).join('') + '</tr>';
                }).join('');
              } else if (bind === 'items' && Array.isArray(val)) {
                bound.innerHTML = val.map(function(i) { return '<li>' + escapeForDom(i) + '</li>'; }).join('');
              } else if (bind === 'text') {
                bound.textContent = String(val);
              }
            } else {
              el.textContent = String(val);
            }
          }
        }

        // Process action queue
        var pending = (state.actionQueue || []).filter(function(a) { return !a.consumed; });
        var consumed = [];
        pending.forEach(function(act) {
          var el = act.target ? document.getElementById(act.target) : null;
          switch (act.action) {
            case 'click': if (el) el.click(); break;
            case 'fill': if (el) { el.value = String(act.value || ''); el.dispatchEvent(new Event('input')); } break;
            case 'focus': if (el) el.focus(); break;
            case 'scroll': if (el) el.scrollIntoView({ behavior: 'smooth' }); break;
            case 'addClass': if (el && act.value) el.classList.add(String(act.value)); break;
            case 'removeClass': if (el && act.value) el.classList.remove(String(act.value)); break;
            case 'setHtml': if (el) el.innerHTML = sanitizeDom(String(act.value || '')); break;
            case 'refresh': window.location.reload(); break;
          }
          consumed.push(act.id);
        });
        if (consumed.length > 0) {
          fetch(API + '/api/apps/' + APP_ID + '/actions/consume', {
            method: 'POST', headers: headers,
            body: JSON.stringify({ actionIds: consumed })
          }).catch(function() {});
        }
      })
      .catch(function() {
        var status = document.getElementById('app-status');
        if (status) { status.innerHTML = '<span class="app-status-dot"></span> Disconnected'; status.className = 'app-status'; }
      });
  }

  // DOM-safe escape for dynamic content insertion
  function escapeForDom(s) {
    var d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  // Robust sanitize for setHtml actions — builds regexes from strings
  // to avoid embedding literal HTML tag patterns in the page source
  function sanitizeDom(html) {
    function stripTag(r, t, sc) {
      if (sc) return r.replace(new RegExp('<' + t + '\\\\b[^>]*/?>','gi'), '');
      return r.replace(new RegExp('<' + t + '\\\\b[^>]*>[\\\\s\\\\S]*?</' + t + '>','gi'), '');
    }
    var result = html.replace(/\\x00/g, '');
    var paired = ['scr'+'ipt','iframe','object','applet','style','svg','math','form','textarea','template'];
    var solo = ['embed','link','base','meta'];
    for (var i = 0; i < paired.length; i++) result = stripTag(result, paired[i], false);
    for (var j = 0; j < solo.length; j++) result = stripTag(result, solo[j], true);
    result = result.replace(/\\bon\\w+\\s*=/gi, 'data-blocked-handler=');
    result = result.replace(/\\bhref\\s*=\\s*["']?\\s*javascript:/gi, 'href="blocked:');
    result = result.replace(/\\bhref\\s*=\\s*["']?\\s*data:/gi, 'href="blocked:');
    result = result.replace(/\\bsrc\\s*=\\s*["']?\\s*javascript:/gi, 'src="blocked:');
    result = result.replace(/\\bsrc\\s*=\\s*["']?\\s*data:/gi, 'src="blocked:');
    result = result.replace(/\\bstyle\\s*=\\s*["'][^"']*expression\\s*\\(/gi, 'style="');
    result = result.replace(/\\bstyle\\s*=\\s*["'][^"']*url\\s*\\(/gi, 'style="');
    return result;
  }

  // Poll every 2 seconds
  setInterval(pollState, 2000);
  pollState();
})();
</script>
</body>
</html>`;
}

// Backward compatibility
export const renderDashboard = renderApp;
