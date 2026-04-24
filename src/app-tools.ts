/**
 * App Agent Tools — the agent's programmatic interface to apps.
 *
 * These tools let agents create, operate, and interact with apps they build.
 * Unlike passive dashboards, agents actively use apps as operational workspaces —
 * reading user interactions, updating state, and running workflows through them.
 *
 * Security:
 * - All operations check permissions via AppRegistry.checkAccess()
 * - Input validation on all mutations
 * - Audit trail for every operation
 * - Rate limiting on state/event operations
 */

import type { ToolDefinition, ToolResult } from "./types.js";
import {
  AppRegistry,
  type AppDefinition,
  type ComponentDefinition,
  type LayoutDefinition,
  type AppPermissions,
  type AppVisibility,
  type AccessLevel,
  validateAppId,
  validateAppDefinition,
} from "./app-runtime.js";
import { renderApp } from "./app-renderer.js";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { EventBus } from "./event-bus.js";

function ok(content: string): ToolResult { return { content }; }
function err(content: string): ToolResult { return { content, isError: true }; }

const registry = AppRegistry.getInstance();

// Helper: get agent ID from context (falls back to conversation agent)
function getActor(args: Record<string, unknown>): string {
  return String(args._actor || args._agentId || "agent");
}

// ── app_create ──

const appCreate: ToolDefinition = {
  name: "app_create",
  description:
    "Create a new app — an interactive mini-application inside the platform. " +
    "Define components (stats, tables, forms, buttons, charts, lists, toggles, etc.), " +
    "layout (grid/flex/stack/tabs/sidebar), data bindings, actions, and events. " +
    "The app is immediately accessible and you can programmatically read/write its state. " +
    "Use apps for: operational dashboards, data collection forms, approval queues, " +
    "coordination boards, monitoring panels, or any interactive workspace you need.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Unique app ID (slug, e.g. 'task-tracker', 'research-board')" },
      name: { type: "string", description: "Human-readable name" },
      description: { type: "string", description: "What this app does" },
      components: {
        type: "array",
        description: "Array of component definitions: { id, type, props, children? }. " +
          "Types: stat, text, button, input, select, toggle, table, chart, list, image, form, custom, " +
          "progress, alert, code, markdown, divider, tabs, accordion, modal, badge, avatar",
        items: { type: "object" },
      },
      layout: {
        type: "object",
        description: "Layout config: { type, columns?, gap? }. Types: grid, flex, stack, tabs, sidebar",
      },
      dataBindings: { type: "array", description: "Optional data bindings: [{ componentId, property, source, expression }]", items: { type: "object" } },
      actions: { type: "array", description: "Optional named actions: [{ name, targetComponent?, handler }]", items: { type: "object" } },
      events: { type: "array", description: "Optional event definitions: [{ name, sourceComponent?, description }]", items: { type: "object" } },
      visibility: { type: "string", description: "Access level: 'private' (only you), 'team' (all agents can read), 'public' (everyone). Default: team" },
    },
    required: ["id", "name", "components", "layout"],
  },
  async execute(args) {
    const actor = getActor(args);
    const rawId = String(args.id || "").replace(/[^a-zA-Z0-9_-]/g, "-");
    const idValidation = validateAppId(rawId);
    if (!idValidation.valid) return err(idValidation.errors.join("; "));

    const visibility = (args.visibility as AppVisibility) || "team";
    if (!["private", "team", "public"].includes(visibility)) return err("Invalid visibility. Use: private, team, public");

    const def: AppDefinition = {
      id: rawId,
      name: String(args.name || rawId),
      description: String(args.description || ""),
      components: (args.components as ComponentDefinition[]) || [],
      dataBindings: (args.dataBindings as any[]) || [],
      actions: (args.actions as any[]) || [],
      events: (args.events as any[]) || [],
      layout: (args.layout as LayoutDefinition) || { type: "stack" },
      status: "active",
      version: 1,
      permissions: {
        owner: actor,
        visibility,
        allowedAgents: [],
        accessLevels: {},
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const result = registry.create(def, actor);
    if (result.error) return err(result.error);

    // Generate and save HTML
    const port = parseInt(process.env.SAX_PORT || "7007", 10);
    const html = renderApp(def, port);
    const dir = join(homedir(), ".sax", "apps", rawId);
    writeFileSync(join(dir, "index.html"), html, "utf-8");

    EventBus.emit("app:create", { id: rawId, name: def.name });

    return ok(
      `App "${def.name}" created (v1)\n\n` +
      `ID: ${rawId}\n` +
      `URL: http://127.0.0.1:${port}/apps/${rawId}\n` +
      `Components: ${def.components.length}\n` +
      `Layout: ${def.layout.type}\n` +
      `Visibility: ${visibility}\n` +
      `Status: active`
    );
  },
};

// ── app_update ──

const appUpdate: ToolDefinition = {
  name: "app_update",
  description: "Update an existing app's components, layout, metadata, or permissions. Re-renders the HTML automatically. Requires write access.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "App ID" },
      name: { type: "string", description: "New name (optional)" },
      description: { type: "string", description: "New description (optional)" },
      components: { type: "array", description: "Replace all components (optional)", items: { type: "object" } },
      layout: { type: "object", description: "Replace layout (optional)" },
      visibility: { type: "string", description: "Change visibility: private, team, public (optional)" },
    },
    required: ["id"],
  },
  async execute(args) {
    const actor = getActor(args);
    const id = String(args.id || "");

    const partial: Partial<AppDefinition> = {};
    if (args.name) partial.name = String(args.name);
    if (args.description) partial.description = String(args.description);
    if (args.components) partial.components = args.components as ComponentDefinition[];
    if (args.layout) partial.layout = args.layout as LayoutDefinition;
    if (args.visibility) {
      partial.permissions = { visibility: args.visibility as AppVisibility } as any;
    }

    const result = registry.update(id, partial, actor);
    if (result.error) return err(result.error);

    // Re-render HTML
    const port = parseInt(process.env.SAX_PORT || "7007", 10);
    const html = renderApp(result.app!, port);
    const dir = join(homedir(), ".sax", "apps", id);
    writeFileSync(join(dir, "index.html"), html, "utf-8");

    EventBus.emit("app:update", { id });
    return ok(`App "${result.app!.name}" updated (v${result.app!.version}). ${result.app!.components.length} components.`);
  },
};

// ── app_read ──

const appRead: ToolDefinition = {
  name: "app_read",
  description:
    "Read the current state of an app — component values, pending user events, metadata, and version. " +
    "This is how you 'see' what users have done in the app. Use this to react to user interactions, " +
    "check form submissions, read table data, or monitor button clicks.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "App ID" },
      component: { type: "string", description: "Optional: read only this component's value" },
    },
    required: ["id"],
  },
  async execute(args) {
    const actor = getActor(args);
    const id = String(args.id || "");

    const access = registry.checkAccess(id, actor, "read");
    if (!access.allowed) return err(access.reason || "Access denied");

    const state = registry.getState(id);
    if (!state) return err(`App "${id}" not found or has no state`);

    if (args.component) {
      const compId = String(args.component);
      const value = state.componentValues[compId];
      return ok(`${compId} = ${JSON.stringify(value, null, 2)}`);
    }

    const events = registry.getUnconsumedEvents(id);
    const def = registry.get(id);
    const result = {
      app: def ? { name: def.name, status: def.status, version: def.version } : null,
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
      stateVersion: state.metadata.version,
    };

    return ok(JSON.stringify(result, null, 2));
  },
};

// ── app_action ──

const appAction: ToolDefinition = {
  name: "app_action",
  description:
    "Trigger an action on an app component. Click buttons, fill inputs, update displays, " +
    "set HTML content, add/remove CSS classes, scroll to elements, or refresh the app. " +
    "Actions: click, fill, focus, scroll, addClass, removeClass, setHtml, refresh",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "App ID" },
      action: { type: "string", description: "Action: click, fill, focus, scroll, addClass, removeClass, setHtml, refresh" },
      target: { type: "string", description: "Component ID to target" },
      value: { description: "Value for the action (e.g., text for fill, class name for addClass)" },
    },
    required: ["id", "action"],
  },
  async execute(args) {
    const actor = getActor(args);
    const id = String(args.id || "");
    const action = String(args.action || "");
    const target = args.target ? String(args.target) : undefined;
    const value = args.value;

    const access = registry.checkAccess(id, actor, "write");
    if (!access.allowed) return err(access.reason || "Access denied");

    const ALLOWED_ACTIONS = new Set(["click", "fill", "focus", "scroll", "addClass", "removeClass", "setHtml", "refresh"]);
    if (!ALLOWED_ACTIONS.has(action)) return err(`Invalid action "${action}". Allowed: ${[...ALLOWED_ACTIONS].join(", ")}`);

    const result = registry.queueAction(id, action, target, value, actor);
    if (result.error) return err(result.error);

    // Also update component value for fill actions
    if (action === "fill" && target && value !== undefined) {
      registry.updateComponentValues(id, { [target]: value }, actor);
    }

    EventBus.emit("app:action", { appId: id, action, target });
    return ok(`Action queued: ${action}${target ? ` on ${target}` : ""}${value !== undefined ? ` = ${JSON.stringify(value)}` : ""}`);
  },
};

// ── app_query ──

const appQuery: ToolDefinition = {
  name: "app_query",
  description:
    "Query specific data from an app. Read form values, table data, component states, " +
    "consume events, get the app definition, or view audit logs. " +
    "Queries: 'values', 'events', 'events:consume', 'definition', 'audit', 'permissions'",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "App ID" },
      query: {
        type: "string",
        description: "What to query: 'values' (component values), 'events' (unconsumed), 'events:consume' (read + mark consumed), 'definition' (schema), 'audit' (recent audit log), 'permissions' (access list)",
      },
      component: { type: "string", description: "Optional: filter to specific component" },
    },
    required: ["id", "query"],
  },
  async execute(args) {
    const actor = getActor(args);
    const id = String(args.id || "");
    const query = String(args.query || "");

    const access = registry.checkAccess(id, actor, "read");
    if (!access.allowed) return err(access.reason || "Access denied");

    const def = registry.get(id);
    if (!def) return err(`App "${id}" not found`);

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
          time: new Date(e.timestamp).toISOString(),
        })), null, 2));
      }

      case "events:consume": {
        const events = registry.getUnconsumedEvents(id);
        if (events.length > 0) {
          registry.consumeEvents(id, events.map(e => e.id));
        }
        return ok(JSON.stringify(events.map(e => ({
          id: e.id, type: e.type, component: e.sourceComponent, data: e.data,
          time: new Date(e.timestamp).toISOString(),
        })), null, 2));
      }

      case "definition": {
        const { permissions: _p, ...safe } = def;
        return ok(JSON.stringify(safe, null, 2));
      }

      case "audit": {
        const auditAccess = registry.checkAccess(id, actor, "admin");
        if (!auditAccess.allowed) return err("Admin access required to view audit log");
        const entries = registry.getAuditLog(id, 25);
        return ok(JSON.stringify(entries.map(e => ({
          time: new Date(e.timestamp).toISOString(),
          actor: e.actor,
          action: e.action,
          details: e.details,
          verified: e.signature ? "yes" : "no",
        })), null, 2));
      }

      case "permissions": {
        return ok(JSON.stringify({
          owner: def.permissions.owner,
          visibility: def.permissions.visibility,
          allowedAgents: def.permissions.allowedAgents,
          accessLevels: def.permissions.accessLevels,
        }, null, 2));
      }

      default:
        return err(`Unknown query: ${query}. Use: values, events, events:consume, definition, audit, permissions`);
    }
  },
};

// ── app_list ──

const appList: ToolDefinition = {
  name: "app_list",
  description: "List all apps you have access to, with IDs, names, status, component counts, and URLs.",
  parameters: { type: "object", properties: {} },
  async execute(args) {
    const actor = getActor(args);
    const apps = registry.list(actor);
    if (apps.length === 0) return ok("No apps created yet.");

    const port = process.env.SAX_PORT || "7007";
    const lines = apps.map(a => {
      const status = a.status !== "active" ? ` [${a.status.toUpperCase()}]` : "";
      return `- ${a.name} (${a.id})${status} — ${a.components.length} components, ${a.layout.type} layout, v${a.version}\n  URL: http://127.0.0.1:${port}/apps/${a.id}`;
    });
    return ok(`${apps.length} app(s):\n\n${lines.join("\n")}`);
  },
};

// ── app_delete ──

const appDelete: ToolDefinition = {
  name: "app_delete",
  description: "Delete an app and all its state, events, and audit log. Requires admin access.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "App ID to delete" },
    },
    required: ["id"],
  },
  async execute(args) {
    const actor = getActor(args);
    const id = String(args.id || "");
    const result = registry.delete(id, actor);
    if (!result.deleted) return err(result.error || `App "${id}" not found`);
    EventBus.emit("app:delete", { id });
    return ok(`App "${id}" deleted.`);
  },
};

// ── app_permissions ──

const appPermissions: ToolDefinition = {
  name: "app_permissions",
  description:
    "Manage app permissions. Grant or revoke access for specific agents, change visibility, " +
    "or manage app lifecycle (suspend, activate, archive). Requires admin access.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "App ID" },
      action: { type: "string", description: "Permission action: grant, revoke, suspend, activate, archive" },
      agentId: { type: "string", description: "Agent ID to grant/revoke access (required for grant/revoke)" },
      level: { type: "string", description: "Access level for grant: read, write, admin. Default: read" },
    },
    required: ["id", "action"],
  },
  async execute(args) {
    const actor = getActor(args);
    const id = String(args.id || "");
    const action = String(args.action || "");

    switch (action) {
      case "grant": {
        const agentId = String(args.agentId || "");
        if (!agentId) return err("agentId required for grant");
        const level = (args.level as AccessLevel) || "read";
        if (!["read", "write", "admin"].includes(level)) return err("Invalid level. Use: read, write, admin");
        const result = registry.grantAccess(id, agentId, level, actor);
        if (!result.success) return err(result.error || "Failed");
        return ok(`Granted ${level} access to ${agentId} on app "${id}"`);
      }
      case "revoke": {
        const agentId = String(args.agentId || "");
        if (!agentId) return err("agentId required for revoke");
        const result = registry.revokeAccess(id, agentId, actor);
        if (!result.success) return err(result.error || "Failed");
        return ok(`Revoked access for ${agentId} on app "${id}"`);
      }
      case "suspend": {
        const result = registry.suspend(id, actor);
        if (!result.success) return err(result.error || "Failed");
        EventBus.emit("app:suspend", { id });
        return ok(`App "${id}" suspended. No agents can interact with it.`);
      }
      case "activate": {
        const result = registry.activate(id, actor);
        if (!result.success) return err(result.error || "Failed");
        EventBus.emit("app:activate", { id });
        return ok(`App "${id}" activated.`);
      }
      case "archive": {
        const result = registry.archive(id, actor);
        if (!result.success) return err(result.error || "Failed");
        EventBus.emit("app:archive", { id });
        return ok(`App "${id}" archived (read-only).`);
      }
      default:
        return err(`Unknown action: ${action}. Use: grant, revoke, suspend, activate, archive`);
    }
  },
};

// ── sidebar_pin ──

const sidebarPin: ToolDefinition = {
  name: "sidebar_pin",
  description:
    "Pin an app or page to the sidebar navigation. ONLY use when the user explicitly says 'pin to sidebar', 'add to sidebar', or 'show in sidebar'. Do NOT use for generic 'add X'/'put X'/'show X'/'use X as background' requests — those are about app content/features, not sidebar navigation.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Display name for the sidebar entry (e.g. 'Calculator')" },
      icon: { type: "string", description: "Emoji icon (e.g. '🧮'). Defaults to '📌'" },
    },
    required: ["name"],
  },
  async execute(args: Record<string, unknown>) {
    const name = String(args.name || "").trim();
    if (!name) return err("name is required");
    const icon = String(args.icon || "📌");

    // Resolve the app URL — check workspace/apps/ for a matching folder
    const dataDir = join(homedir(), ".sax");
    const workspaceApps = resolve("workspace", "apps");
    const slug = name.toLowerCase().replace(/\s+/g, "-");

    let pageUrl = "";
    if (existsSync(resolve(workspaceApps, slug, "index.html"))) {
      pageUrl = `/apps/${slug}/`;
    } else {
      // Fuzzy match against available apps
      try {
        const dirs = readdirSync(workspaceApps).filter(d => existsSync(resolve(workspaceApps, d, "index.html")));
        const match = dirs.find(d => d === slug || d.includes(slug) || slug.includes(d));
        if (match) {
          pageUrl = `/apps/${match}/`;
        } else if (dirs.length > 0) {
          return err(`No app found matching "${name}". Available: ${dirs.join(", ")}`);
        } else {
          return err(`No apps found in workspace.`);
        }
      } catch {
        return err(`Could not read workspace apps directory.`);
      }
    }

    // Read/write settings.json
    const settingsPath = join(dataDir, "settings.json");
    let settings: Record<string, unknown> = {};
    try { if (existsSync(settingsPath)) settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch {}
    const pins = (settings.sidebarPins || []) as Array<{ name: string; icon: string; url: string }>;

    if (pins.length >= 8 && !pins.some(p => p.name === name)) {
      return err("Maximum 8 pinned apps. Unpin one first.");
    }
    if (pins.some(p => p.name === name)) {
      return ok(`${name} is already pinned to the sidebar.`);
    }

    pins.push({ name, icon, url: pageUrl });
    settings.sidebarPins = pins;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { encoding: "utf-8", mode: 0o600 });

    // Notify connected clients
    try { const { broadcastAll } = await import("./chat-ws.js"); broadcastAll({ type: "sidebar_pins_changed", pins }); } catch {}

    return ok(`Pinned ${icon} ${name} to the sidebar.`);
  },
};

// ── sidebar_unpin ──

const sidebarUnpin: ToolDefinition = {
  name: "sidebar_unpin",
  description:
    "Remove an app or page from the sidebar navigation. ONLY use when the user explicitly says 'unpin from sidebar', 'remove from sidebar', 'hide from sidebar', or 'take off sidebar'. Do NOT use for generic 'remove X'/'hide X'/'delete X' requests — those are about app content/features, not sidebar navigation.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Name of the sidebar entry to remove, or 'all' to clear everything" },
    },
    required: ["name"],
  },
  async execute(args: Record<string, unknown>) {
    const name = String(args.name || "").trim();
    if (!name) return err("name is required");

    const dataDir = join(homedir(), ".sax");
    const settingsPath = join(dataDir, "settings.json");
    let settings: Record<string, unknown> = {};
    try { if (existsSync(settingsPath)) settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch {}
    const currentPins = (settings.sidebarPins || []) as Array<{ name: string }>;

    if (name.toLowerCase() === "all") {
      if (currentPins.length === 0) return ok("Sidebar is already empty.");
      const removed = currentPins.map(p => p.name).join(", ");
      settings.sidebarPins = [];
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { encoding: "utf-8", mode: 0o600 });
      try { const { broadcastAll } = await import("./chat-ws.js"); broadcastAll({ type: "sidebar_pins_changed", pins: [] }); } catch {}
      return ok(`Removed all pins from the sidebar: ${removed}`);
    }

    // Case-insensitive match
    const pins = currentPins.filter(p => p.name.toLowerCase() !== name.toLowerCase());
    if (pins.length === currentPins.length) {
      const available = currentPins.map(p => p.name).join(", ");
      return err(`"${name}" is not pinned. Current pins: ${available || "none"}`);
    }

    settings.sidebarPins = pins;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { encoding: "utf-8", mode: 0o600 });

    try { const { broadcastAll } = await import("./chat-ws.js"); broadcastAll({ type: "sidebar_pins_changed", pins }); } catch {}

    return ok(`Removed ${name} from the sidebar.`);
  },
};

// ── Export all app tools ──

export const appTools: ToolDefinition[] = [
  appCreate,
  appUpdate,
  appRead,
  appAction,
  appQuery,
  appList,
  appDelete,
  appPermissions,
  sidebarPin,
  sidebarUnpin,
];

// Backward compatibility
export const dashboardTools = appTools;
