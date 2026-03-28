/**
 * Mission Variables — user-defined variables that persist across runs.
 * Stored in ~/.sax/mission-variables.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ToolDefinition } from "../types.js";

const VARIABLES_PATH = join(homedir(), ".sax", "mission-variables.json");

export interface VariableScope {
  global: Record<string, unknown>;
  missions: Record<string, Record<string, unknown>>;
}

function ensureDir(): void {
  const dir = join(homedir(), ".sax");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function loadVariables(): VariableScope {
  if (existsSync(VARIABLES_PATH)) {
    try { return JSON.parse(readFileSync(VARIABLES_PATH, "utf-8")); } catch {}
  }
  return { global: {}, missions: {} };
}

export function saveVariables(vars: VariableScope): void {
  ensureDir();
  writeFileSync(VARIABLES_PATH, JSON.stringify(vars, null, 2), "utf-8");
}

export function getVariable(key: string, missionName?: string): unknown {
  const vars = loadVariables();
  if (missionName && vars.missions[missionName]?.[key] !== undefined) {
    return vars.missions[missionName][key];
  }
  return vars.global[key];
}

export function setVariable(key: string, value: unknown, missionName?: string): void {
  const vars = loadVariables();
  if (missionName) {
    if (!vars.missions[missionName]) vars.missions[missionName] = {};
    vars.missions[missionName][key] = value;
  } else {
    vars.global[key] = value;
  }
  saveVariables(vars);
}

export function deleteVariable(key: string, missionName?: string): boolean {
  const vars = loadVariables();
  if (missionName) {
    if (vars.missions[missionName]?.[key] === undefined) return false;
    delete vars.missions[missionName][key];
  } else {
    if (vars.global[key] === undefined) return false;
    delete vars.global[key];
  }
  saveVariables(vars);
  return true;
}

export function listVariables(missionName?: string): Record<string, unknown> {
  const vars = loadVariables();
  if (missionName) {
    return { ...vars.global, ...vars.missions[missionName] };
  }
  return vars.global;
}

export function interpolateVariables(text: string, missionName?: string): string {
  const vars = loadVariables();
  const merged = missionName
    ? { ...vars.global, ...(vars.missions[missionName] ?? {}) }
    : vars.global;

  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const val = merged[key];
    return val !== undefined ? String(val) : match;
  });
}

export function createVariableTools(): ToolDefinition[] {
  return [
    {
      name: "mission_var_set",
      description: "Set a mission variable (persists across runs). Use missionName for mission-scoped vars, omit for global.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Variable name" },
          value: { type: "string", description: "Variable value" },
          missionName: { type: "string", description: "Optional: scope to a specific mission" },
        },
        required: ["key", "value"],
      },
      async execute(args) {
        setVariable(String(args.key), args.value, args.missionName ? String(args.missionName) : undefined);
        const scope = args.missionName ? `mission:${args.missionName}` : "global";
        return { content: `Set {{${args.key}}} = "${args.value}" (${scope})` };
      },
    },
    {
      name: "mission_var_get",
      description: "Get a mission variable's value.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string" },
          missionName: { type: "string" },
        },
        required: ["key"],
      },
      async execute(args) {
        const val = getVariable(String(args.key), args.missionName ? String(args.missionName) : undefined);
        if (val === undefined) return { content: `Variable "{{${args.key}}}" not set.` };
        return { content: `{{${args.key}}} = ${JSON.stringify(val)}` };
      },
    },
    {
      name: "mission_var_delete",
      description: "Delete a mission variable.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string" },
          missionName: { type: "string" },
        },
        required: ["key"],
      },
      async execute(args) {
        const deleted = deleteVariable(String(args.key), args.missionName ? String(args.missionName) : undefined);
        return { content: deleted ? `Deleted {{${args.key}}}.` : `Variable "{{${args.key}}}" not found.` };
      },
    },
    {
      name: "mission_var_list",
      description: "List all mission variables, optionally filtered by mission.",
      parameters: {
        type: "object",
        properties: {
          missionName: { type: "string", description: "Optional mission to include scoped vars" },
        },
      },
      async execute(args) {
        const vars = listVariables(args.missionName ? String(args.missionName) : undefined);
        const entries = Object.entries(vars);
        if (entries.length === 0) return { content: "No variables set." };
        const list = entries.map(([k, v]) => `• **{{${k}}}** = ${JSON.stringify(v)}`).join("\n");
        return { content: `Variables:\n${list}` };
      },
    },
    {
      name: "mission_var_interpolate",
      description: "Replace {{variable}} placeholders in text with their values.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text with {{variable}} placeholders" },
          missionName: { type: "string" },
        },
        required: ["text"],
      },
      async execute(args) {
        const result = interpolateVariables(String(args.text), args.missionName ? String(args.missionName) : undefined);
        return { content: result };
      },
    },
  ];
}
