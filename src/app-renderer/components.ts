/**
 * Per-component HTML renderers. All user-provided values pass through
 * escapeHtml / escapeJs / sanitizeHtml at the boundary.
 */

import type { ComponentDefinition } from "../app-runtime/index.js";
import { escapeHtml, escapeJs, safeStr, sanitizeHtml } from "./sanitize.js";

export function renderComponent(comp: ComponentDefinition): string {
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
