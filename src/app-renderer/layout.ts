/**
 * Layout HTML renderers — arrange a list of components in grid / flex / stack /
 * tabs / sidebar shells.
 */

import type { ComponentDefinition, LayoutDefinition } from "../app-runtime/index.js";
import { renderComponent } from "./components.js";
import { escapeHtml, safeStr } from "./sanitize.js";

export function renderLayout(layout: LayoutDefinition, components: ComponentDefinition[]): string {
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
