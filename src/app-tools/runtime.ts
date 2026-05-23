/**
 * App runtime tools — read / action / query.
 * Live state + events + audit + permissions snapshot. CRUD lives in
 * lifecycle.ts; sidebar pin/unpin in sidebar.ts.
 */

import type { ToolDefinition } from "../types.js";
import { AppRegistry } from "../app-runtime.js";
import { EventBus } from "../event-bus.js";
import { ok, err, getActor } from "./shared.js";

const registry = AppRegistry.getInstance();

export const appRead: ToolDefinition = {
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

export const appAction: ToolDefinition = {
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

export const appQuery: ToolDefinition = {
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
