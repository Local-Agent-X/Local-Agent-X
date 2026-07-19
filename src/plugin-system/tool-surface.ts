import type { ToolDefinition, ToolResult } from "../types.js";
import type { ToolPolicy } from "../tool-policy/index.js";
import type { UnifiedToolRegistry } from "../tools/registry.js";
import type { PluginManifest } from "./manifest.js";
import { validateToolParameterSchema } from "./tool-schema.js";
import {
  activatePluginToolMetadata,
  deactivatePluginToolMetadata,
  getActivePluginToolMetadata,
} from "./tool-metadata.js";

const SAFE_TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export interface PreparedPluginToolActivation {
  ownerId: string;
  activationToken: symbol;
  tools: ToolDefinition[];
}

export interface PluginToolSurfacePort {
  prepare(
    ownerId: string,
    manifest: PluginManifest,
    module: Record<string, unknown>,
  ): PreparedPluginToolActivation | null;
  activate(prepared: PreparedPluginToolActivation): void;
  abort(prepared: PreparedPluginToolActivation): void;
  deactivate(ownerId: string): void;
}

function asToolDefinition(name: string, value: unknown): ToolDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Plugin tool "${name}" export must be an object`);
  }
  const raw = value as Partial<ToolDefinition>;
  if (raw.name !== name || typeof raw.description !== "string" || raw.description.trim().length === 0) {
    throw new Error(`Plugin tool "${name}" export does not match its declaration`);
  }
  try {
    validateToolParameterSchema(raw.parameters);
  } catch (error) {
    throw new Error(`Plugin tool "${name}" parameters are invalid: ${(error as Error).message}`);
  }
  if (typeof raw.execute !== "function") throw new Error(`Plugin tool "${name}" must export execute()`);
  return raw as ToolDefinition;
}

export class PluginToolSurface implements PluginToolSurfacePort {
  private reservations = new Map<string, { ownerId: string; activationToken: symbol }>();
  private ownerReservations = new Map<string, symbol>();
  private activeByOwner = new Map<string, PreparedPluginToolActivation>();

  constructor(
    private registry: UnifiedToolRegistry,
    private liveTools: ToolDefinition[],
    private policy: ToolPolicy,
  ) {}

  prepare(
    ownerId: string,
    manifest: PluginManifest,
    module: Record<string, unknown>,
  ): PreparedPluginToolActivation | null {
    const declared = manifest.contributions?.tools;
    if (!declared) return null;
    if (this.ownerReservations.has(ownerId) || this.activeByOwner.has(ownerId)) {
      throw new Error(`Plugin "${ownerId}" already owns or reserves a tool surface`);
    }
    const exported = Object.keys(module).sort();
    const expected = [...declared].sort();
    if (exported.length !== expected.length || exported.some((name, index) => name !== expected[index])) {
      throw new Error(`Plugin "${ownerId}" tool exports must exactly match contributions.tools`);
    }

    const activationToken = Symbol(ownerId);
    const definitions = declared.map((name) => {
      if (!SAFE_TOOL_NAME.test(name) || name.startsWith("mcp_")) {
        throw new Error(`Plugin tool name "${name}" is unsafe or reserved`);
      }
      if (!this.policy.findExactRule(name)) {
        throw new Error(`Plugin tool "${name}" has no exact live policy rule`);
      }
      const reservation = this.reservations.get(name);
      if (reservation || this.registry.get(name) || this.liveTools.some((tool) => tool.name === name)) {
        throw new Error(`Plugin tool name "${name}" collides with an active tool`);
      }
      const source = asToolDefinition(name, module[name]);
      const wrapped: ToolDefinition = {
        name,
        description: source.description,
        parameters: source.parameters,
        effect: { class: "non-idempotent" },
        execute: async (args, signal): Promise<ToolResult> => {
          const active = getActivePluginToolMetadata(name);
          if (active?.ownerId !== ownerId || active.activationToken !== activationToken) {
            return {
              content: `Plugin tool "${name}" is no longer active`,
              isError: true,
              status: "blocked",
            };
          }
          return source.execute(args, signal);
        },
      };
      return wrapped;
    });

    for (const tool of definitions) this.reservations.set(tool.name, { ownerId, activationToken });
    this.ownerReservations.set(ownerId, activationToken);
    return { ownerId, activationToken, tools: definitions };
  }

  activate(prepared: PreparedPluginToolActivation): void {
    if (this.ownerReservations.get(prepared.ownerId) !== prepared.activationToken) {
      throw new Error(`Plugin "${prepared.ownerId}" activation reservation was lost`);
    }
    for (const tool of prepared.tools) {
      const reservation = this.reservations.get(tool.name);
      if (reservation?.ownerId !== prepared.ownerId || reservation.activationToken !== prepared.activationToken) {
        throw new Error(`Plugin tool "${tool.name}" activation reservation was lost`);
      }
    }
    try {
      for (const tool of prepared.tools) {
        activatePluginToolMetadata(tool.name, {
          ownerId: prepared.ownerId,
          activationToken: prepared.activationToken,
          kernel: "shell",
          risk: "shell",
        });
        this.registry.register(tool, {
          defer: true,
          tags: ["plugin", "external", prepared.ownerId],
          searchHint: tool.description.slice(0, 80),
          toolClass: "shell",
        });
        this.liveTools.push(tool);
        this.reservations.delete(tool.name);
      }
    } catch (error) {
      for (const tool of prepared.tools) {
        deactivatePluginToolMetadata(tool.name, prepared.ownerId, prepared.activationToken);
        if (this.registry.get(tool.name) === tool) this.registry.unregister(tool.name);
        const index = this.liveTools.indexOf(tool);
        if (index >= 0) this.liveTools.splice(index, 1);
      }
      this.activeByOwner.delete(prepared.ownerId);
      this.abort(prepared);
      throw error;
    }
    this.ownerReservations.delete(prepared.ownerId);
    this.activeByOwner.set(prepared.ownerId, prepared);
  }

  abort(prepared: PreparedPluginToolActivation): void {
    for (const tool of prepared.tools) {
      const reservation = this.reservations.get(tool.name);
      if (reservation?.ownerId === prepared.ownerId && reservation.activationToken === prepared.activationToken) {
        this.reservations.delete(tool.name);
      }
    }
    if (this.ownerReservations.get(prepared.ownerId) === prepared.activationToken) {
      this.ownerReservations.delete(prepared.ownerId);
    }
  }

  deactivate(ownerId: string): void {
    const active = this.activeByOwner.get(ownerId);
    if (!active) return;
    for (const tool of active.tools) {
      deactivatePluginToolMetadata(tool.name, ownerId, active.activationToken);
    }
    let cleanupFailed = false;
    for (const tool of active.tools) {
      try {
        if (this.registry.get(tool.name) === tool) this.registry.unregister(tool.name);
      } catch {
        cleanupFailed = true;
        this.registry.unregisterIfMatches(tool.name, tool);
      }
      const index = this.liveTools.indexOf(tool);
      if (index >= 0) this.liveTools.splice(index, 1);
    }
    this.activeByOwner.delete(ownerId);
    if (cleanupFailed) throw new Error(`Plugin "${ownerId}" tool registry cleanup failed`);
  }
}
