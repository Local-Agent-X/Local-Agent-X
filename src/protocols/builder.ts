/**
 * Protocol Builder — create/edit/delete custom protocols programmatically.
 * Custom protocols are stored in ~/.sax/custom-protocols.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Protocol, ProtocolStep } from "../protocols.js";
import type { ToolDefinition } from "../types.js";

const CUSTOM_PROTOCOLS_PATH = join(homedir(), ".sax", "custom-protocols.json");

function ensureDir(): void {
  const dir = join(homedir(), ".sax");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function loadCustomProtocols(): Protocol[] {
  if (existsSync(CUSTOM_PROTOCOLS_PATH)) {
    try {
      return JSON.parse(readFileSync(CUSTOM_PROTOCOLS_PATH, "utf-8"));
    } catch {
      return [];
    }
  }
  return [];
}

export function saveCustomProtocols(protocols: Protocol[]): void {
  ensureDir();
  writeFileSync(CUSTOM_PROTOCOLS_PATH, JSON.stringify(protocols, null, 2), "utf-8");
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
