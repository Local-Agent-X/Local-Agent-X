/**
 * Protocol Variables — user-defined variables that persist across runs.
 * Stored in ~/.sax/protocol-variables.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ToolDefinition } from "../types.js";

const VARIABLES_PATH = join(homedir(), ".sax", "protocol-variables.json");

export interface VariableScope {
  global: Record<string, unknown>;
  protocols: Record<string, Record<string, unknown>>;
}

function ensureDir(): void {
  const dir = join(homedir(), ".sax");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function loadVariables(): VariableScope {
  if (existsSync(VARIABLES_PATH)) {
    try { return JSON.parse(readFileSync(VARIABLES_PATH, "utf-8")); } catch {}
  }
  return { global: {}, protocols: {} };
}

export function saveVariables(vars: VariableScope): void {
  ensureDir();
  writeFileSync(VARIABLES_PATH, JSON.stringify(vars, null, 2), "utf-8");
}

export function getVariable(key: string, protocolName?: string): unknown {
  const vars = loadVariables();
  if (protocolName && vars.protocols[protocolName]?.[key] !== undefined) {
    return vars.protocols[protocolName][key];
  }
  return vars.global[key];
}

export function setVariable(key: string, value: unknown, protocolName?: string): void {
  const vars = loadVariables();
  if (protocolName) {
    if (!vars.protocols[protocolName]) vars.protocols[protocolName] = {};
    vars.protocols[protocolName][key] = value;
  } else {
    vars.global[key] = value;
  }
  saveVariables(vars);
}

export function deleteVariable(key: string, protocolName?: string): boolean {
  const vars = loadVariables();
  if (protocolName) {
    if (vars.protocols[protocolName]?.[key] === undefined) return false;
    delete vars.protocols[protocolName][key];
  } else {
    if (vars.global[key] === undefined) return false;
    delete vars.global[key];
  }
  saveVariables(vars);
  return true;
}

export function listVariables(protocolName?: string): Record<string, unknown> {
  const vars = loadVariables();
  if (protocolName) {
    return { ...vars.global, ...vars.protocols[protocolName] };
  }
  return vars.global;
}

export function interpolateVariables(text: string, protocolName?: string): string {
  const vars = loadVariables();
  const merged = protocolName
    ? { ...vars.global, ...(vars.protocols[protocolName] ?? {}) }
    : vars.global;

  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const val = merged[key];
    return val !== undefined ? String(val) : match;
  });
}

export function createVariableTools(): ToolDefinition[] {
  return [
    {
      name: "protocol_var_set",
      description: "Set a protocol variable (persists across runs). Use protocolName for protocol-scoped vars, omit for global.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Variable name" },
          value: { type: "string", description: "Variable value" },
          protocolName: { type: "string", description: "Optional: scope to a specific protocol" },
        },
        required: ["key", "value"],
      },
      async execute(args) {
        setVariable(String(args.key), args.value, args.protocolName ? String(args.protocolName) : undefined);
        const scope = args.protocolName ? `protocol:${args.protocolName}` : "global";
        return { content: `Set {{${args.key}}} = "${args.value}" (${scope})` };
      },
    },
    {
      name: "protocol_var_get",
      description: "Get a protocol variable's value.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string" },
          protocolName: { type: "string" },
        },
        required: ["key"],
      },
      async execute(args) {
        const val = getVariable(String(args.key), args.protocolName ? String(args.protocolName) : undefined);
        if (val === undefined) return { content: `Variable "{{${args.key}}}" not set.` };
        return { content: `{{${args.key}}} = ${JSON.stringify(val)}` };
      },
    },
    {
      name: "protocol_var_delete",
      description: "Delete a protocol variable.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string" },
          protocolName: { type: "string" },
        },
        required: ["key"],
      },
      async execute(args) {
        const deleted = deleteVariable(String(args.key), args.protocolName ? String(args.protocolName) : undefined);
        return { content: deleted ? `Deleted {{${args.key}}}.` : `Variable "{{${args.key}}}" not found.` };
      },
    },
    {
      name: "protocol_var_list",
      description: "List all protocol variables, optionally filtered by protocol.",
      parameters: {
        type: "object",
        properties: {
          protocolName: { type: "string", description: "Optional protocol to include scoped vars" },
        },
      },
      async execute(args) {
        const vars = listVariables(args.protocolName ? String(args.protocolName) : undefined);
        const entries = Object.entries(vars);
        if (entries.length === 0) return { content: "No variables set." };
        const list = entries.map(([k, v]) => `• **{{${k}}}** = ${JSON.stringify(v)}`).join("\n");
        return { content: `Variables:\n${list}` };
      },
    },
    {
      name: "protocol_var_interpolate",
      description: "Replace {{variable}} placeholders in text with their values.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text with {{variable}} placeholders" },
          protocolName: { type: "string" },
        },
        required: ["text"],
      },
      async execute(args) {
        const result = interpolateVariables(String(args.text), args.protocolName ? String(args.protocolName) : undefined);
        return { content: result };
      },
    },
  ];
}
