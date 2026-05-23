import { join } from "node:path";
import { homedir } from "node:os";

export interface AssociationContext {
  timeOfDay: number;
  dayOfWeek: number;
  sessionTopic?: string;
  activeProject?: string;
  entities: string[];
  emotionalState?: string;
  toolsUsed: string[];
  timestamp: number;
}

export interface AssociativeResult {
  memoryId: string;
  content: string;
  score: number;
  associations: { type: string; strength: number }[];
  context: AssociationContext;
}

export interface AssociationWeb {
  center: string;
  connections: { memoryId: string; type: string; strength: number; snippet: string }[];
}

export type AssociationType =
  | "temporal"
  | "topical"
  | "emotional"
  | "entity"
  | "sequential"
  | "project"
  | "tool";

export const ALL_ASSOCIATION_TYPES: AssociationType[] = [
  "temporal",
  "topical",
  "emotional",
  "entity",
  "sequential",
  "project",
  "tool",
];

export interface StoredAssociation {
  from: string;
  to: string;
  type: AssociationType;
  strength: number;
  lastAccessed: number;
  created: number;
}

export interface StoredMemoryNode {
  memoryId: string;
  content: string;
  context: AssociationContext;
  created: number;
}

export interface AssociativeStore {
  nodes: StoredMemoryNode[];
  associations: StoredAssociation[];
}

export const LAX_DIR = join(homedir(), ".lax");
export const STORE_FILE = join(LAX_DIR, "associative-memory.json");
export const HALF_LIFE_MS = 60 * 24 * 60 * 60 * 1000;
export const MAX_NODES = 5000;
export const MAX_ASSOCIATIONS = 20000;
