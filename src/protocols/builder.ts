/**
 * Protocol Builder — create/edit/delete custom protocols programmatically.
 *
 * Storage: workspace/protocols/custom.json. Lives under workspace so the
 * file is picked up by the workspace git sync — protocols learned on one
 * machine flow to all of the user's other machines. Previously stored at
 * ~/.lax/custom-protocols.json (local-only); first load migrates that
 * file to the new location if present.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { Protocol, ProtocolStep } from "../protocols.js";
import type { ToolDefinition } from "../types.js";
import { getRuntimeConfig } from "../config.js";

import { createLogger } from "../logger.js";
const logger = createLogger("protocols.builder");

/** Resolve the workspace/protocols dir (creates it if missing). */
function protocolsDir(): string {
  const cfg = getRuntimeConfig();
  const dir = resolve(cfg.workspace, "protocols");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function customProtocolsPath(): string {
  return join(protocolsDir(), "custom.json");
}

const LEGACY_PATH = join(homedir(), ".lax", "custom-protocols.json");
let _migrationRan = false;

/** One-time migration: ~/.lax/custom-protocols.json → workspace/protocols/custom.json.
 *  Idempotent — after the first successful move the legacy file is gone and
 *  this becomes a no-op. */
function migrateLegacyCustomProtocols(): void {
  if (_migrationRan) return;
  _migrationRan = true;
  try {
    if (!existsSync(LEGACY_PATH)) return;
    const newPath = customProtocolsPath();
    if (existsSync(newPath)) return; // workspace already has one — keep it, don't clobber
    renameSync(LEGACY_PATH, newPath);
    logger.info(`[protocols] Migrated custom protocols → ${newPath}`);
  } catch (e) {
    logger.warn(`[protocols] Legacy migration failed: ${(e as Error).message}`);
  }
}

export function loadCustomProtocols(): Protocol[] {
  migrateLegacyCustomProtocols();
  const path = customProtocolsPath();
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      return [];
    }
  }
  return [];
}

export function saveCustomProtocols(protocols: Protocol[]): void {
  migrateLegacyCustomProtocols();
  writeFileSync(customProtocolsPath(), JSON.stringify(protocols, null, 2), "utf-8");
}

export function createProtocol(protocol: Protocol): Protocol {
  const protocols = loadCustomProtocols();
  if (protocols.find(m => m.name === protocol.name)) {
    throw new Error(`Protocol "${protocol.name}" already exists`);
  }
  protocols.push(protocol);
  saveCustomProtocols(protocols);
  return protocol;
}

export function editProtocol(name: string, updates: Partial<Protocol>): Protocol {
  const protocols = loadCustomProtocols();
  const idx = protocols.findIndex(m => m.name === name);
  if (idx === -1) throw new Error(`Protocol "${name}" not found`);
  protocols[idx] = { ...protocols[idx], ...updates, name: updates.name ?? protocols[idx].name };
  saveCustomProtocols(protocols);
  return protocols[idx];
}

export function deleteProtocol(name: string): boolean {
  const protocols = loadCustomProtocols();
  const idx = protocols.findIndex(m => m.name === name);
  if (idx === -1) return false;
  protocols.splice(idx, 1);
  saveCustomProtocols(protocols);
  return true;
}

export function getProtocol(name: string): Protocol | undefined {
  return loadCustomProtocols().find(m => m.name === name);
}

export function createBuilderTools(): ToolDefinition[] {
  return [
    {
      name: "protocol_create",
      description: "Create a new custom protocol with steps, rules, and triggers.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Unique protocol name" },
          description: { type: "string", description: "What this protocol does" },
          triggers: { type: "array", items: { type: "string" }, description: "Phrases that activate this protocol" },
          steps: { type: "array", items: { type: "object" }, description: "Array of ProtocolStep objects" },
          rules: { type: "array", items: { type: "string" }, description: "Rules to follow during execution" },
        },
        required: ["name", "description", "triggers", "steps"],
      },
      async execute(args) {
        try {
          const protocol = createProtocol({
            name: String(args.name),
            description: String(args.description),
            triggers: args.triggers as string[],
            steps: args.steps as ProtocolStep[],
            rules: (args.rules as string[]) || [],
            learnablePreferences: [],
          });
          try {
            const { recordUsage } = await import("./usage.js");
            recordUsage({
              action: "built",
              name: protocol.name,
              sessionId: typeof (args as { _sessionId?: string })._sessionId === "string" ? (args as { _sessionId: string })._sessionId : undefined,
            });
          } catch { /* telemetry never fails the call */ }
          return { content: `Created protocol "${protocol.name}" with ${protocol.steps.length} steps.` };
        } catch (e: any) {
          return { content: e.message, isError: true };
        }
      },
    },
    {
      name: "protocol_edit",
      description: "Edit an existing custom protocol.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Protocol name to edit" },
          updates: { type: "object", description: "Partial protocol fields to update" },
        },
        required: ["name", "updates"],
      },
      async execute(args) {
        try {
          const updated = editProtocol(String(args.name), args.updates as Partial<Protocol>);
          return { content: `Updated protocol "${updated.name}".` };
        } catch (e: any) {
          return { content: e.message, isError: true };
        }
      },
    },
    {
      name: "protocol_delete",
      description: "Delete a custom protocol.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Protocol name to delete" },
        },
        required: ["name"],
      },
      async execute(args) {
        const deleted = deleteProtocol(String(args.name));
        return { content: deleted ? `Deleted protocol "${args.name}".` : `Protocol "${args.name}" not found.` };
      },
    },
  ];
}
