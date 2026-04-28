/**
 * Associative Recall — contextual web-based memory recall.
 *
 * Links memories to surrounding context (time, topic, project, entities,
 * emotion, tools) and retrieves them through multi-channel association
 * scoring rather than flat keyword search.
 *
 * Persists to ~/.lax/associative-memory.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

// ── Types ────────────────────────────────────────────────────

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

type AssociationType =
  | "temporal"
  | "topical"
  | "emotional"
  | "entity"
  | "sequential"
  | "project"
  | "tool";

const ALL_ASSOCIATION_TYPES: AssociationType[] = [
  "temporal",
  "topical",
  "emotional",
  "entity",
  "sequential",
  "project",
  "tool",
];

interface StoredAssociation {
  from: string;
  to: string;
  type: AssociationType;
  strength: number;
  lastAccessed: number;
  created: number;
}

interface StoredMemoryNode {
  memoryId: string;
  content: string;
  context: AssociationContext;
  created: number;
}

interface AssociativeStore {
  nodes: StoredMemoryNode[];
  associations: StoredAssociation[];
}

// ── Persistence ─────────────────────────────────────────────

const LAX_DIR = join(homedir(), ".lax");
const STORE_FILE = join(LAX_DIR, "associative-memory.json");
const HALF_LIFE_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
const MAX_NODES = 5000;
const MAX_ASSOCIATIONS = 20000;

function ensureDir(): void {
  if (!existsSync(LAX_DIR)) mkdirSync(LAX_DIR, { recursive: true });
}

function atomicWrite(path: string, data: string): void {
  const tmp = path + ".tmp." + randomBytes(4).toString("hex");
  try {
    writeFileSync(tmp, data, "utf-8");
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
}

function loadStore(): AssociativeStore {
  if (!existsSync(STORE_FILE)) return { nodes: [], associations: [] };
  try {
    const raw = readFileSync(STORE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
      associations: Array.isArray(parsed.associations) ? parsed.associations : [],
    };
  } catch {
    return { nodes: [], associations: [] };
  }
}

function saveStore(store: AssociativeStore): void {
  ensureDir();
  // Enforce limits
  if (store.nodes.length > MAX_NODES) {
    store.nodes = store.nodes.slice(-MAX_NODES);
  }
  if (store.associations.length > MAX_ASSOCIATIONS) {
    store.associations = store.associations.slice(-MAX_ASSOCIATIONS);
  }
  atomicWrite(STORE_FILE, JSON.stringify(store, null, 2));
}

// ── Helpers ─────────────────────────────────────────────────

function timeProximity(a: number, b: number): number {
  // How close two times-of-day are (0-23), normalized 0-1
  const diff = Math.abs(a - b);
  const wrapped = Math.min(diff, 24 - diff);
  return 1 - wrapped / 12;
}

function overlapScore(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b.map((s) => s.toLowerCase()));
  let matches = 0;
  for (const item of a) {
    if (setB.has(item.toLowerCase())) matches++;
  }
  return matches / Math.max(a.length, b.length);
}

function textContains(text: string, trigger: string): boolean {
  return text.toLowerCase().includes(trigger.toLowerCase());
}

// ── Class ───────────────────────────────────────────────────

export class AssociativeMemory {
  private static instance: AssociativeMemory | null = null;
  private store: AssociativeStore;

  private constructor() {
    this.store = loadStore();
  }

  static getInstance(): AssociativeMemory {
    if (!AssociativeMemory.instance) {
      AssociativeMemory.instance = new AssociativeMemory();
    }
    return AssociativeMemory.instance;
  }

  /**
   * Link a memory to its surrounding context and auto-create associations
   * with other memories that share context channels.
   */
  buildAssociations(memoryId: string, context: AssociationContext): void {
    // Upsert node
    let node = this.store.nodes.find((n) => n.memoryId === memoryId);
    if (!node) {
      node = { memoryId, content: "", context, created: Date.now() };
      this.store.nodes.push(node);
    } else {
      node.context = context;
    }

    const now = Date.now();

    // Find previous memory (sequential association)
    const sorted = [...this.store.nodes]
      .filter((n) => n.memoryId !== memoryId)
      .sort((a, b) => b.created - a.created);
    const previous = sorted[0];
    if (previous && now - previous.created < 10 * 60 * 1000) {
      this.upsertAssociation(previous.memoryId, memoryId, "sequential", 0.8, now);
    }

    // Auto-link to existing nodes sharing context
    for (const other of this.store.nodes) {
      if (other.memoryId === memoryId) continue;
      const oc = other.context;

      // Temporal — similar time of day
      if (timeProximity(context.timeOfDay, oc.timeOfDay) > 0.8) {
        this.upsertAssociation(memoryId, other.memoryId, "temporal",
          timeProximity(context.timeOfDay, oc.timeOfDay) * 0.6, now);
      }

      // Topical — same session topic
      if (context.sessionTopic && oc.sessionTopic &&
          context.sessionTopic.toLowerCase() === oc.sessionTopic.toLowerCase()) {
        this.upsertAssociation(memoryId, other.memoryId, "topical", 0.7, now);
      }

      // Emotional — same emotional state
      if (context.emotionalState && oc.emotionalState &&
          context.emotionalState === oc.emotionalState) {
        this.upsertAssociation(memoryId, other.memoryId, "emotional", 0.5, now);
      }

      // Entity overlap
      const entityOvlp = overlapScore(context.entities, oc.entities);
      if (entityOvlp > 0.2) {
        this.upsertAssociation(memoryId, other.memoryId, "entity", entityOvlp, now);
      }

      // Project
      if (context.activeProject && oc.activeProject &&
          context.activeProject.toLowerCase() === oc.activeProject.toLowerCase()) {
        this.upsertAssociation(memoryId, other.memoryId, "project", 0.7, now);
      }

      // Tool overlap
      const toolOvlp = overlapScore(context.toolsUsed, oc.toolsUsed);
      if (toolOvlp > 0.2) {
        this.upsertAssociation(memoryId, other.memoryId, "tool", toolOvlp * 0.6, now);
      }
    }

    saveStore(this.store);
  }

  /**
   * Given a trigger phrase, find memories connected by multiple association types.
   * Score = number of matching association channels.
   */
  recall(trigger: string, context?: Partial<AssociationContext>): AssociativeResult[] {
    const candidates: Map<string, { score: number; types: { type: string; strength: number }[] }> = new Map();

    for (const node of this.store.nodes) {
      let score = 0;
      const matchedTypes: { type: string; strength: number }[] = [];

      // Content match
      if (textContains(node.content, trigger) ||
          textContains(node.context.sessionTopic || "", trigger) ||
          node.context.entities.some((e) => textContains(e, trigger))) {
        score += 1;
        matchedTypes.push({ type: "content", strength: 0.8 });
      }

      if (context) {
        if (context.timeOfDay !== undefined) {
          const tp = timeProximity(context.timeOfDay, node.context.timeOfDay);
          if (tp > 0.7) { score += 1; matchedTypes.push({ type: "temporal", strength: tp }); }
        }
        if (context.sessionTopic && node.context.sessionTopic &&
            context.sessionTopic.toLowerCase() === node.context.sessionTopic.toLowerCase()) {
          score += 1;
          matchedTypes.push({ type: "topical", strength: 0.8 });
        }
        if (context.emotionalState && node.context.emotionalState === context.emotionalState) {
          score += 1;
          matchedTypes.push({ type: "emotional", strength: 0.7 });
        }
        if (context.activeProject && node.context.activeProject &&
            context.activeProject.toLowerCase() === node.context.activeProject.toLowerCase()) {
          score += 1;
          matchedTypes.push({ type: "project", strength: 0.8 });
        }
        if (context.entities && context.entities.length > 0) {
          const ovlp = overlapScore(context.entities, node.context.entities);
          if (ovlp > 0.1) { score += 1; matchedTypes.push({ type: "entity", strength: ovlp }); }
        }
        if (context.toolsUsed && context.toolsUsed.length > 0) {
          const ovlp = overlapScore(context.toolsUsed, node.context.toolsUsed);
          if (ovlp > 0.1) { score += 1; matchedTypes.push({ type: "tool", strength: ovlp }); }
        }
      }

      if (score > 0) {
        candidates.set(node.memoryId, { score, types: matchedTypes });
      }
    }

    // Mark accessed
    const now = Date.now();
    const results: AssociativeResult[] = [];
    for (const [memoryId, { score, types }] of candidates.entries()) {
      const node = this.store.nodes.find((n) => n.memoryId === memoryId)!;
      results.push({
        memoryId,
        content: node.content,
        score,
        associations: types,
        context: node.context,
      });

      // Touch associations
      for (const assoc of this.store.associations) {
        if (assoc.from === memoryId || assoc.to === memoryId) {
          assoc.lastAccessed = now;
        }
      }
    }

    results.sort((a, b) => b.score - a.score);
    saveStore(this.store);
    return results;
  }

  /**
   * Return all memories connected to the given memory and how they connect —
   * a mind-map style web with the given memory at center.
   */
  getAssociationWeb(memoryId: string): AssociationWeb {
    const connections: AssociationWeb["connections"] = [];
    const seen = new Set<string>();

    for (const assoc of this.store.associations) {
      let connectedId: string | null = null;
      if (assoc.from === memoryId) connectedId = assoc.to;
      else if (assoc.to === memoryId) connectedId = assoc.from;
      if (!connectedId) continue;

      const key = `${connectedId}:${assoc.type}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const node = this.store.nodes.find((n) => n.memoryId === connectedId);
      connections.push({
        memoryId: connectedId,
        type: assoc.type,
        strength: assoc.strength,
        snippet: node ? node.content.slice(0, 120) : "",
      });
    }

    connections.sort((a, b) => b.strength - a.strength);
    return { center: memoryId, connections };
  }

  /**
   * Find everything matching a partial context — e.g. "everything from
   * when I was working on Agent X late at night".
   */
  findByContext(context: Partial<AssociationContext>): AssociativeResult[] {
    const results: AssociativeResult[] = [];

    for (const node of this.store.nodes) {
      let score = 0;
      const matchedTypes: { type: string; strength: number }[] = [];

      if (context.timeOfDay !== undefined) {
        const tp = timeProximity(context.timeOfDay, node.context.timeOfDay);
        if (tp > 0.6) { score += 1; matchedTypes.push({ type: "temporal", strength: tp }); }
      }
      if (context.dayOfWeek !== undefined && node.context.dayOfWeek === context.dayOfWeek) {
        score += 1;
        matchedTypes.push({ type: "temporal", strength: 0.9 });
      }
      if (context.sessionTopic && node.context.sessionTopic &&
          node.context.sessionTopic.toLowerCase().includes(context.sessionTopic.toLowerCase())) {
        score += 1;
        matchedTypes.push({ type: "topical", strength: 0.8 });
      }
      if (context.activeProject && node.context.activeProject &&
          node.context.activeProject.toLowerCase().includes(context.activeProject.toLowerCase())) {
        score += 1;
        matchedTypes.push({ type: "project", strength: 0.8 });
      }
      if (context.emotionalState && node.context.emotionalState === context.emotionalState) {
        score += 1;
        matchedTypes.push({ type: "emotional", strength: 0.7 });
      }
      if (context.entities && context.entities.length > 0) {
        const ovlp = overlapScore(context.entities, node.context.entities);
        if (ovlp > 0) { score += 1; matchedTypes.push({ type: "entity", strength: ovlp }); }
      }
      if (context.toolsUsed && context.toolsUsed.length > 0) {
        const ovlp = overlapScore(context.toolsUsed, node.context.toolsUsed);
        if (ovlp > 0) { score += 1; matchedTypes.push({ type: "tool", strength: ovlp }); }
      }

      if (score > 0) {
        results.push({
          memoryId: node.memoryId,
          content: node.content,
          score,
          associations: matchedTypes,
          context: node.context,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  /**
   * Manually create or strengthen an association between two memories.
   */
  learnAssociation(from: string, to: string, type: string, strength?: number): void {
    const assocType = ALL_ASSOCIATION_TYPES.includes(type as AssociationType)
      ? (type as AssociationType)
      : "topical";
    this.upsertAssociation(from, to, assocType, strength ?? 0.5, Date.now());
    saveStore(this.store);
  }

  /**
   * Weaken associations that haven't been accessed recently.
   * Half-life: 60 days. Associations below 0.05 strength are removed.
   */
  decayAssociations(): void {
    const now = Date.now();
    this.store.associations = this.store.associations.filter((assoc) => {
      const elapsed = now - assoc.lastAccessed;
      const halfLives = elapsed / HALF_LIFE_MS;
      assoc.strength *= Math.pow(0.5, halfLives);
      return assoc.strength >= 0.05;
    });
    saveStore(this.store);
  }

  /**
   * Set content for a memory node (used when building associations
   * for a memory whose content wasn't set at creation time).
   */
  setContent(memoryId: string, content: string): void {
    const node = this.store.nodes.find((n) => n.memoryId === memoryId);
    if (node) {
      node.content = content;
      saveStore(this.store);
    }
  }

  // ── Internal ────────────────────────────────────────────────

  private upsertAssociation(
    from: string,
    to: string,
    type: AssociationType,
    strength: number,
    now: number,
  ): void {
    const existing = this.store.associations.find(
      (a) => a.type === type &&
        ((a.from === from && a.to === to) || (a.from === to && a.to === from)),
    );
    if (existing) {
      // Strengthen — cap at 1.0
      existing.strength = Math.min(1, existing.strength + strength * 0.3);
      existing.lastAccessed = now;
    } else {
      this.store.associations.push({
        from,
        to,
        type,
        strength: Math.min(1, strength),
        lastAccessed: now,
        created: now,
      });
    }
  }
}
