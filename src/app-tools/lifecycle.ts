/**
 * App lifecycle tools — create / update / list / delete + permissions.
 * Definition + visibility changes. Runtime state read/write lives in
 * runtime.ts; sidebar pin/unpin in sidebar.ts.
 */

import type { ToolDefinition } from "../types.js";
import {
  AppRegistry,
  type AppDefinition,
  type ComponentDefinition,
  type LayoutDefinition,
  type AppVisibility,
  type AccessLevel,
  validateAppId,
} from "../app-runtime.js";
import { renderApp } from "../app-renderer.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { EventBus } from "../event-bus.js";
import { ok, err, getActor, getAppPort } from "./shared.js";

const registry = AppRegistry.getInstance();

export const appCreate: ToolDefinition = {
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
    const port = getAppPort();
    const html = renderApp(def, port);
    const dir = join(getLaxDir(), "apps", rawId);
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

export const appUpdate: ToolDefinition = {
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
    const port = getAppPort();
    const html = renderApp(result.app!, port);
    const dir = join(getLaxDir(), "apps", id);
    writeFileSync(join(dir, "index.html"), html, "utf-8");

    EventBus.emit("app:update", { id });
    return ok(`App "${result.app!.name}" updated (v${result.app!.version}). ${result.app!.components.length} components.`);
  },
};

export const appList: ToolDefinition = {
  name: "app_list",
  description: "List all apps you have access to, with IDs, names, status, component counts, and URLs.",
  parameters: { type: "object", properties: {} },
  async execute(args) {
    const actor = getActor(args);
    const apps = registry.list(actor);
    if (apps.length === 0) return ok("No apps created yet.");

    const port = getAppPort();
    const lines = apps.map(a => {
      const status = a.status !== "active" ? ` [${a.status.toUpperCase()}]` : "";
      return `- ${a.name} (${a.id})${status} — ${a.components.length} components, ${a.layout.type} layout, v${a.version}\n  URL: http://127.0.0.1:${port}/apps/${a.id}`;
    });
    return ok(`${apps.length} app(s):\n\n${lines.join("\n")}`);
  },
};

export const appDelete: ToolDefinition = {
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

export const appPermissions: ToolDefinition = {
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
