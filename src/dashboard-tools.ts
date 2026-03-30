/**
 * Dashboard Agent Tools — the agent's programmatic interface to dashboards.
 *
 * These tools let the agent create, read, update, and interact with dashboards
 * it built — no browser automation needed. The agent knows the schema because
 * it defined it, and interacts through structured state/actions.
 */

import type { ToolDefinition, ToolResult } from "./types.js";
import {
  DashboardRegistry,
  type DashboardDefinition,
  type ComponentDefinition,
  type LayoutDefinition,
} from "./dashboard-runtime.js";
import { renderDashboard } from "./dashboard-renderer.js";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { EventBus } from "./event-bus.js";

function ok(content: string): ToolResult { return { content }; }
function err(content: string): ToolResult { return { content, isError: true }; }

const registry = DashboardRegistry.getInstance();

// ── dashboard_create ──

const dashboardCreate: ToolDefinition = {
  name: "dashboard_create",
  description:
    "Create a new dashboard inside the app. Define components (stats, tables, forms, buttons, charts, etc.), " +
    "layout (grid/flex/stack/tabs/sidebar), data bindings, and actions. " +
    "The dashboard is immediately accessible and the agent can programmatically read/write its data.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Unique dashboard ID (slug, e.g. 'sales-metrics')" },
      name: { type: "string", description: "Human-readable name" },
      description: { type: "string", description: "Short description" },
      components: {
        type: "array",
        description: "Array of component definitions: { id, type, props, children? }. Types: stat, text, button, input, select, toggle, table, chart, list, image, form, custom",
        items: { type: "object" },
      },
      layout: {
        type: "object",
        description: "Layout config: { type, columns?, gap? }. Types: grid, flex, stack, tabs, sidebar",
      },
      dataBindings: { type: "array", description: "Optional data bindings: [{ componentId, property, source, expression }]", items: { type: "object" } },
      actions: { type: "array", description: "Optional named actions: [{ name, targetComponent?, handler }]", items: { type: "object" } },
      events: { type: "array", description: "Optional event definitions: [{ name, sourceComponent?, description }]", items: { type: "object" } },
    },
    required: ["id", "name", "components", "layout"],
  },
  async execute(args) {
    const id = String(args.id || "").replace(/[^a-zA-Z0-9_-]/g, "-");
    if (!id) return err("Dashboard ID is required");

    if (registry.get(id)) return err(`Dashboard "${id}" already exists. Use dashboard_update to modify it.`);

    const def: DashboardDefinition = {
      id,
      name: String(args.name || id),
      description: String(args.description || ""),
      components: (args.components as ComponentDefinition[]) || [],
      dataBindings: (args.dataBindings as any[]) || [],
      actions: (args.actions as any[]) || [],
      events: (args.events as any[]) || [],
      layout: (args.layout as LayoutDefinition) || { type: "stack" },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    registry.create(def);

    // Generate and save the HTML
    const port = parseInt(process.env.SAX_PORT || "4800", 10);
    const html = renderDashboard(def, port);
    const dashDir = join(homedir(), ".sax", "dashboards", id);
    writeFileSync(join(dashDir, "index.html"), html, "utf-8");

    EventBus.emit("dashboard:create", { id, name: def.name });

    return ok(`Dashboard "${def.name}" created!\n\nURL: http://127.0.0.1:${port}/dashboards/${id}\nComponents: ${def.components.length}\nLayout: ${def.layout.type}`);
  },
};

// ── dashboard_update ──

const dashboardUpdate: ToolDefinition = {
  name: "dashboard_update",
  description: "Update an existing dashboard's components, layout, or metadata. Re-renders the HTML automatically.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Dashboard ID" },
      name: { type: "string", description: "New name (optional)" },
      description: { type: "string", description: "New description (optional)" },
      components: { type: "array", description: "Replace all components (optional)", items: { type: "object" } },
      layout: { type: "object", description: "Replace layout (optional)" },
    },
    required: ["id"],
  },
  async execute(args) {
    const id = String(args.id || "");
    const existing = registry.get(id);
    if (!existing) return err(`Dashboard "${id}" not found`);

    const partial: Partial<DashboardDefinition> = {};
    if (args.name) partial.name = String(args.name);
    if (args.description) partial.description = String(args.description);
    if (args.components) partial.components = args.components as ComponentDefinition[];
    if (args.layout) partial.layout = args.layout as LayoutDefinition;

    const updated = registry.update(id, partial);
    if (!updated) return err("Failed to update dashboard");

    // Re-render HTML
    const port = parseInt(process.env.SAX_PORT || "4800", 10);
    const html = renderDashboard(updated, port);
    const dashDir = join(homedir(), ".sax", "dashboards", id);
    writeFileSync(join(dashDir, "index.html"), html, "utf-8");

    EventBus.emit("dashboard:update", { id });
    return ok(`Dashboard "${updated.name}" updated. ${updated.components.length} components.`);
  },
};

// ── dashboard_read ──

const dashboardRead: ToolDefinition = {
  name: "dashboard_read",
  description:
    "Read the current state of a dashboard — component values, pending events from user interactions, " +
    "and metadata. This is how the agent 'sees' what's on the dashboard without browser automation.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Dashboard ID" },
      component: { type: "string", description: "Optional: read only this component's value" },
    },
    required: ["id"],
  },
  async execute(args) {
    const id = String(args.id || "");
    const state = registry.getState(id);
    if (!state) return err(`Dashboard "${id}" not found or has no state`);

    if (args.component) {
      const compId = String(args.component);
      const value = state.componentValues[compId];
      return ok(`${compId} = ${JSON.stringify(value, null, 2)}`);
    }

    // Return full state + unconsumed events
    const events = registry.getUnconsumedEvents(id);
    const result = {
      componentValues: state.componentValues,
      pendingEvents: events.map(e => ({
        id: e.id,
        type: e.type,
        component: e.sourceComponent,
        data: e.data,
        time: new Date(e.timestamp).toISOString(),
      })),
      lastAgentUpdate: new Date(state.metadata.lastAgentUpdate).toISOString(),
      lastUserUpdate: state.metadata.lastUserUpdate ? new Date(state.metadata.lastUserUpdate).toISOString() : "never",
    };

    return ok(JSON.stringify(result, null, 2));
  },
};

// ── dashboard_action ──

const dashboardAction: ToolDefinition = {
  name: "dashboard_action",
  description:
    "Trigger an action on a dashboard component. The agent can click buttons, fill inputs, scroll, " +
    "refresh, set HTML, add/remove classes — anything the agent built into the dashboard. " +
    "Actions: click, fill, focus, scroll, addClass, removeClass, setHtml, refresh",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Dashboard ID" },
      action: { type: "string", description: "Action name: click, fill, focus, scroll, addClass, removeClass, setHtml, refresh" },
      target: { type: "string", description: "Component ID to target" },
      value: { description: "Value for the action (e.g., text for fill, class name for addClass)" },
    },
    required: ["id", "action"],
  },
  async execute(args) {
    const id = String(args.id || "");
    const action = String(args.action || "");
    const target = args.target ? String(args.target) : undefined;
    const value = args.value;

    if (!registry.get(id)) return err(`Dashboard "${id}" not found`);

    const queued = registry.queueAction(id, action, target, value);
    if (!queued) return err("Failed to queue action");

    // Also update component value in state for fill actions
    if (action === "fill" && target && value !== undefined) {
      registry.updateComponentValues(id, { [target]: value });
    }

    EventBus.emit("dashboard:action", { dashboardId: id, action, target });
    return ok(`Action queued: ${action}${target ? ` on ${target}` : ""}${value !== undefined ? ` = ${JSON.stringify(value)}` : ""}`);
  },
};

// ── dashboard_query ──

const dashboardQuery: ToolDefinition = {
  name: "dashboard_query",
  description:
    "Query specific data from a dashboard. Read form values, table data, component states, or consume events. " +
    "Use this for targeted reads instead of reading the full state.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Dashboard ID" },
      query: {
        type: "string",
        description: "What to query: 'values' (all component values), 'events' (unconsumed events), 'events:consume' (read and mark consumed), 'definition' (dashboard schema)",
      },
      component: { type: "string", description: "Optional: filter to specific component" },
    },
    required: ["id", "query"],
  },
  async execute(args) {
    const id = String(args.id || "");
    const query = String(args.query || "");

    const def = registry.get(id);
    if (!def) return err(`Dashboard "${id}" not found`);

    switch (query) {
      case "values": {
        const state = registry.getState(id);
        if (!state) return ok("{}");
        if (args.component) {
          return ok(JSON.stringify(state.componentValues[String(args.component)] ?? null));
        }
        return ok(JSON.stringify(state.componentValues, null, 2));
      }

      case "events": {
        const events = registry.getUnconsumedEvents(id);
        return ok(JSON.stringify(events.map(e => ({
          id: e.id, type: e.type, component: e.sourceComponent, data: e.data,
        })), null, 2));
      }

      case "events:consume": {
        const events = registry.getUnconsumedEvents(id);
        if (events.length > 0) {
          registry.consumeEvents(id, events.map(e => e.id));
        }
        return ok(JSON.stringify(events.map(e => ({
          id: e.id, type: e.type, component: e.sourceComponent, data: e.data,
        })), null, 2));
      }

      case "definition": {
        return ok(JSON.stringify(def, null, 2));
      }

      default:
        return err(`Unknown query: ${query}. Use: values, events, events:consume, definition`);
    }
  },
};

// ── dashboard_list ──

const dashboardList: ToolDefinition = {
  name: "dashboard_list",
  description: "List all dashboards with their IDs, names, component counts, and URLs.",
  parameters: { type: "object", properties: {} },
  async execute() {
    const dashboards = registry.list();
    if (dashboards.length === 0) return ok("No dashboards created yet.");

    const port = process.env.SAX_PORT || "4800";
    const lines = dashboards.map(d =>
      `- ${d.name} (${d.id}) — ${d.components.length} components, ${d.layout.type} layout\n  URL: http://127.0.0.1:${port}/dashboards/${d.id}`
    );
    return ok(`${dashboards.length} dashboard(s):\n\n${lines.join("\n")}`);
  },
};

// ── dashboard_delete ──

const dashboardDelete: ToolDefinition = {
  name: "dashboard_delete",
  description: "Delete a dashboard and all its state/events.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Dashboard ID to delete" },
    },
    required: ["id"],
  },
  async execute(args) {
    const id = String(args.id || "");
    const existed = registry.delete(id);
    if (!existed) return err(`Dashboard "${id}" not found`);
    EventBus.emit("dashboard:delete", { id });
    return ok(`Dashboard "${id}" deleted.`);
  },
};

// ── Export all dashboard tools ──

export const dashboardTools: ToolDefinition[] = [
  dashboardCreate,
  dashboardUpdate,
  dashboardRead,
  dashboardAction,
  dashboardQuery,
  dashboardList,
  dashboardDelete,
];
