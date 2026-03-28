/**
 * Mission Builder — create/edit/delete custom missions programmatically.
 * Custom missions are stored in ~/.sax/custom-missions.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Mission, MissionStep } from "../missions.js";
import type { ToolDefinition } from "../types.js";

const CUSTOM_MISSIONS_PATH = join(homedir(), ".sax", "custom-missions.json");

function ensureDir(): void {
  const dir = join(homedir(), ".sax");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function loadCustomMissions(): Mission[] {
  if (existsSync(CUSTOM_MISSIONS_PATH)) {
    try {
      return JSON.parse(readFileSync(CUSTOM_MISSIONS_PATH, "utf-8"));
    } catch {
      return [];
    }
  }
  return [];
}

export function saveCustomMissions(missions: Mission[]): void {
  ensureDir();
  writeFileSync(CUSTOM_MISSIONS_PATH, JSON.stringify(missions, null, 2), "utf-8");
}

export function createMission(mission: Mission): Mission {
  const missions = loadCustomMissions();
  if (missions.find(m => m.name === mission.name)) {
    throw new Error(`Mission "${mission.name}" already exists`);
  }
  missions.push(mission);
  saveCustomMissions(missions);
  return mission;
}

export function editMission(name: string, updates: Partial<Mission>): Mission {
  const missions = loadCustomMissions();
  const idx = missions.findIndex(m => m.name === name);
  if (idx === -1) throw new Error(`Mission "${name}" not found`);
  missions[idx] = { ...missions[idx], ...updates, name: updates.name ?? missions[idx].name };
  saveCustomMissions(missions);
  return missions[idx];
}

export function deleteMission(name: string): boolean {
  const missions = loadCustomMissions();
  const idx = missions.findIndex(m => m.name === name);
  if (idx === -1) return false;
  missions.splice(idx, 1);
  saveCustomMissions(missions);
  return true;
}

export function getMission(name: string): Mission | undefined {
  return loadCustomMissions().find(m => m.name === name);
}

export function createBuilderTools(): ToolDefinition[] {
  return [
    {
      name: "mission_create",
      description: "Create a new custom mission with steps, rules, and triggers.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Unique mission name" },
          description: { type: "string", description: "What this mission does" },
          triggers: { type: "array", items: { type: "string" }, description: "Phrases that activate this mission" },
          steps: { type: "array", items: { type: "object" }, description: "Array of MissionStep objects" },
          rules: { type: "array", items: { type: "string" }, description: "Rules to follow during execution" },
        },
        required: ["name", "description", "triggers", "steps"],
      },
      async execute(args) {
        try {
          const mission = createMission({
            name: String(args.name),
            description: String(args.description),
            triggers: args.triggers as string[],
            steps: args.steps as MissionStep[],
            rules: (args.rules as string[]) || [],
            learnablePreferences: [],
          });
          return { content: `Created mission "${mission.name}" with ${mission.steps.length} steps.` };
        } catch (e: any) {
          return { content: e.message, isError: true };
        }
      },
    },
    {
      name: "mission_edit",
      description: "Edit an existing custom mission.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Mission name to edit" },
          updates: { type: "object", description: "Partial mission fields to update" },
        },
        required: ["name", "updates"],
      },
      async execute(args) {
        try {
          const updated = editMission(String(args.name), args.updates as Partial<Mission>);
          return { content: `Updated mission "${updated.name}".` };
        } catch (e: any) {
          return { content: e.message, isError: true };
        }
      },
    },
    {
      name: "mission_delete",
      description: "Delete a custom mission.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Mission name to delete" },
        },
        required: ["name"],
      },
      async execute(args) {
        const deleted = deleteMission(String(args.name));
        return { content: deleted ? `Deleted mission "${args.name}".` : `Mission "${args.name}" not found.` };
      },
    },
  ];
}
