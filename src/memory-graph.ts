/**
 * Memory Graph — entity relationship graph for structured knowledge.
 *
 * Stores named entities and typed relationships between them,
 * supports path finding, pattern queries, and auto-extraction.
 *
 * Persists to ~/.lax/memory-graph.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { getLaxDir } from "./lax-data-dir.js";
import { GRAPH_STOP_WORDS, type ModuleSignal } from "./orchestrator/types.js";

// ── Types ────────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  type: string;
  metadata: Record<string, unknown>;
  createdAt: number;
}

export interface GraphEdge {
  from: string;
  relation: string;
  to: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  confidence: number; // 0–1
}

export interface SubGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface GraphData {
  nodes: Record<string, GraphNode>;
  edges: GraphEdge[];
}

// ── Relationship extraction patterns ────────────────────────

const RELATION_PATTERNS: Array<{
  regex: RegExp;
  relation: string;
  /** 1-indexed capture groups for from/to */
  fromGroup: number;
  toGroup: number;
}> = [
  { regex: /(\w[\w\s]*?)\s+works?\s+on\s+(\w[\w\s]*?)(?:\.|,|$)/gi, relation: "works-on", fromGroup: 1, toGroup: 2 },
  { regex: /(\w[\w\s]*?)\s+is\s+(\w[\w\s]*?)'s\s+(\w+)/gi, relation: "is-role-of", fromGroup: 1, toGroup: 2 },
  { regex: /(\w[\w\s]*?)\s+uses?\s+(\w[\w\s]*?)(?:\.|,|$)/gi, relation: "uses", fromGroup: 1, toGroup: 2 },
  { regex: /(\w[\w\s]*?)\s+competes?\s+with\s+(\w[\w\s]*?)(?:\.|,|$)/gi, relation: "competes-with", fromGroup: 1, toGroup: 2 },
  { regex: /(\w[\w\s]*?)\s+created?\s+(\w[\w\s]*?)(?:\.|,|$)/gi, relation: "created", fromGroup: 1, toGroup: 2 },
  { regex: /(\w[\w\s]*?)\s+depends?\s+on\s+(\w[\w\s]*?)(?:\.|,|$)/gi, relation: "depends-on", fromGroup: 1, toGroup: 2 },
  { regex: /(\w[\w\s]*?)\s+(?:is\s+part\s+of|belongs?\s+to)\s+(\w[\w\s]*?)(?:\.|,|$)/gi, relation: "part-of", fromGroup: 1, toGroup: 2 },
  { regex: /(\w[\w\s]*?)\s+(?:likes?|loves?|enjoys?)\s+(\w[\w\s]*?)(?:\.|,|$)/gi, relation: "likes", fromGroup: 1, toGroup: 2 },
  { regex: /(\w[\w\s]*?)\s+(?:manages?|leads?)\s+(\w[\w\s]*?)(?:\.|,|$)/gi, relation: "manages", fromGroup: 1, toGroup: 2 },
  { regex: /(\w[\w\s]*?)\s+(?:is\s+built\s+with|is\s+written\s+in)\s+(\w[\w\s]*?)(?:\.|,|$)/gi, relation: "built-with", fromGroup: 1, toGroup: 2 },
];

// ── Persistence ─────────────────────────────────────────────

const LAX_DIR = getLaxDir();
const GRAPH_FILE = join(LAX_DIR, "memory-graph.json");

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

function loadGraph(): GraphData {
  try {
    if (existsSync(GRAPH_FILE)) {
      const raw = readFileSync(GRAPH_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.nodes === "object" && Array.isArray(parsed.edges)) {
        return parsed as GraphData;
      }
    }
  } catch {}
  return { nodes: {}, edges: [] };
}

function saveGraph(data: GraphData): void {
  ensureDir();
  atomicWrite(GRAPH_FILE, JSON.stringify(data, null, 2));
}

// ── MemoryGraph class ───────────────────────────────────────

class MemoryGraphImpl {
  private data: GraphData;

  constructor() {
    this.data = loadGraph();
  }

  private persist(): void {
    saveGraph(this.data);
  }

  private normalizeId(entity: string): string {
    return entity.trim().toLowerCase();
  }

  /** Add or update a node. */
  addNode(entity: string, type: string, metadata: Record<string, unknown> = {}): void {
    const id = this.normalizeId(entity);
    if (this.data.nodes[id]) {
      // Merge metadata
      Object.assign(this.data.nodes[id].metadata, metadata);
      this.data.nodes[id].type = type;
    } else {
      this.data.nodes[id] = { id, type, metadata, createdAt: Date.now() };
    }
    this.persist();
  }

  /** Add a directed edge. Deduplicates by (from, relation, to). */
  addEdge(from: string, relation: string, to: string, metadata: Record<string, unknown> = {}): void {
    const fromId = this.normalizeId(from);
    const toId = this.normalizeId(to);
    const rel = relation.toLowerCase().trim();

    // Ensure both nodes exist
    if (!this.data.nodes[fromId]) {
      this.data.nodes[fromId] = { id: fromId, type: "unknown", metadata: {}, createdAt: Date.now() };
    }
    if (!this.data.nodes[toId]) {
      this.data.nodes[toId] = { id: toId, type: "unknown", metadata: {}, createdAt: Date.now() };
    }

    // Deduplicate
    const existing = this.data.edges.find(
      (e) => e.from === fromId && e.relation === rel && e.to === toId,
    );
    if (existing) {
      Object.assign(existing.metadata, metadata);
      existing.confidence = Math.min(1, existing.confidence + 0.1);
    } else {
      this.data.edges.push({
        from: fromId,
        relation: rel,
        to: toId,
        metadata,
        createdAt: Date.now(),
        confidence: 0.7,
      });
    }
    this.persist();
  }

  /** Remove a node and all its edges. */
  removeNode(entity: string): void {
    const id = this.normalizeId(entity);
    delete this.data.nodes[id];
    this.data.edges = this.data.edges.filter((e) => e.from !== id && e.to !== id);
    this.persist();
  }

  /** Remove a specific edge. */
  removeEdge(from: string, relation: string, to: string): void {
    const fromId = this.normalizeId(from);
    const toId = this.normalizeId(to);
    const rel = relation.toLowerCase().trim();
    this.data.edges = this.data.edges.filter(
      (e) => !(e.from === fromId && e.relation === rel && e.to === toId),
    );
    this.persist();
  }

  /** Get a node by entity name. */
  getNode(entity: string): GraphNode | null {
    return this.data.nodes[this.normalizeId(entity)] ?? null;
  }

  /** Get edges connected to an entity. */
  getEdges(entity: string, direction: "in" | "out" | "both" = "both"): GraphEdge[] {
    const id = this.normalizeId(entity);
    return this.data.edges.filter((e) => {
      if (direction === "out") return e.from === id;
      if (direction === "in") return e.to === id;
      return e.from === id || e.to === id;
    });
  }

  /**
   * Find all paths between two entities up to maxDepth hops.
   * Returns arrays of entity IDs representing each path.
   */
  findPath(from: string, to: string, maxDepth = 5): string[][] {
    const fromId = this.normalizeId(from);
    const toId = this.normalizeId(to);
    const results: string[][] = [];

    const dfs = (current: string, target: string, visited: Set<string>, path: string[]): void => {
      if (path.length > maxDepth + 1) return;
      if (current === target) {
        results.push([...path]);
        return;
      }

      // Get all neighbors (both directions)
      for (const edge of this.data.edges) {
        let next: string | null = null;
        if (edge.from === current && !visited.has(edge.to)) next = edge.to;
        if (edge.to === current && !visited.has(edge.from)) next = edge.from;
        if (next) {
          visited.add(next);
          path.push(next);
          dfs(next, target, visited, path);
          path.pop();
          visited.delete(next);
        }
      }
    };

    const visited = new Set<string>([fromId]);
    dfs(fromId, toId, visited, [fromId]);
    return results;
  }

  /**
   * Pattern-matching query on edges.
   * Each field is optional; omitted fields match anything.
   */
  query(pattern: { from?: string; relation?: string; to?: string }): GraphEdge[] {
    const fromId = pattern.from ? this.normalizeId(pattern.from) : undefined;
    const rel = pattern.relation?.toLowerCase().trim();
    const toId = pattern.to ? this.normalizeId(pattern.to) : undefined;

    return this.data.edges.filter((e) => {
      if (fromId && e.from !== fromId) return false;
      if (rel && e.relation !== rel) return false;
      if (toId && e.to !== toId) return false;
      return true;
    });
  }

  /**
   * Get an entity and all nodes/edges within N hops.
   */
  getNeighborhood(entity: string, depth = 1): SubGraph {
    const startId = this.normalizeId(entity);
    const visitedNodes = new Set<string>();
    let frontier = new Set<string>([startId]);

    for (let d = 0; d < depth; d++) {
      const nextFrontier = new Set<string>();
      for (const nodeId of frontier) {
        visitedNodes.add(nodeId);
        for (const edge of this.data.edges) {
          if (edge.from === nodeId && !visitedNodes.has(edge.to)) nextFrontier.add(edge.to);
          if (edge.to === nodeId && !visitedNodes.has(edge.from)) nextFrontier.add(edge.from);
        }
      }
      frontier = nextFrontier;
    }
    // Include the last frontier
    for (const id of frontier) visitedNodes.add(id);

    const nodes = [...visitedNodes]
      .map((id) => this.data.nodes[id])
      .filter(Boolean) as GraphNode[];

    const edges = this.data.edges.filter(
      (e) => visitedNodes.has(e.from) && visitedNodes.has(e.to),
    );

    return { nodes, edges };
  }

  /** Human-readable markdown summary of the graph. */
  toMarkdown(): string {
    const nodeCount = Object.keys(this.data.nodes).length;
    const edgeCount = this.data.edges.length;

    if (nodeCount === 0) return "# Memory Graph\n\nEmpty graph — no entities recorded yet.";

    const lines: string[] = [
      `# Memory Graph`,
      ``,
      `**${nodeCount}** entities, **${edgeCount}** relationships`,
      ``,
      `## Entities`,
      ``,
    ];

    // Group nodes by type
    const byType: Record<string, GraphNode[]> = {};
    for (const node of Object.values(this.data.nodes)) {
      if (!byType[node.type]) byType[node.type] = [];
      byType[node.type].push(node);
    }
    for (const [type, nodes] of Object.entries(byType).sort()) {
      lines.push(`### ${type}`);
      for (const n of nodes.sort((a, b) => a.id.localeCompare(b.id))) {
        lines.push(`- ${n.id}`);
      }
      lines.push(``);
    }

    lines.push(`## Relationships`, ``);
    for (const e of this.data.edges) {
      const conf = Math.round(e.confidence * 100);
      lines.push(`- **${e.from}** —[${e.relation}]→ **${e.to}** (${conf}%)`);
    }

    return lines.join("\n");
  }

  /**
   * Auto-extract relationships from text given a list of known entities.
   */
  autoExtractRelationships(text: string, entities: string[]): GraphEdge[] {
    const extracted: GraphEdge[] = [];
    const entitySet = new Set(entities.map((e) => e.toLowerCase().trim()));

    // First, try structured regex patterns
    for (const pattern of RELATION_PATTERNS) {
      // Reset lastIndex for global regex
      pattern.regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.regex.exec(text)) !== null) {
        const fromRaw = match[pattern.fromGroup]?.trim();
        const toRaw = match[pattern.toGroup]?.trim();
        if (!fromRaw || !toRaw) continue;
        // Only include if both entities are in the known set
        if (entitySet.has(fromRaw.toLowerCase()) && entitySet.has(toRaw.toLowerCase())) {
          extracted.push({
            from: fromRaw.toLowerCase(),
            relation: pattern.relation,
            to: toRaw.toLowerCase(),
            metadata: { source: "auto-extracted" },
            createdAt: Date.now(),
            confidence: 0.5,
          });
        }
      }
    }

    // Second, co-occurrence: if two entities appear in the same sentence,
    // create a weak "related-to" edge
    const sentences = text.split(/[.!?]+/).map((s) => s.toLowerCase());
    for (const sentence of sentences) {
      const found: string[] = [];
      for (const entity of entitySet) {
        if (sentence.includes(entity)) found.push(entity);
      }
      // Create pairs for co-occurring entities (skip if already extracted)
      for (let i = 0; i < found.length; i++) {
        for (let j = i + 1; j < found.length; j++) {
          const alreadyExtracted = extracted.some(
            (e) =>
              (e.from === found[i] && e.to === found[j]) ||
              (e.from === found[j] && e.to === found[i]),
          );
          if (!alreadyExtracted) {
            extracted.push({
              from: found[i],
              relation: "related-to",
              to: found[j],
              metadata: { source: "co-occurrence" },
              createdAt: Date.now(),
              confidence: 0.3,
            });
          }
        }
      }
    }

    return extracted;
  }

  private extractEntities(message: string): string[] {
    return [...new Set(
      (message.match(/\b[A-Z][a-zA-Z]{2,}\b/g) || [])
        .filter(w => !GRAPH_STOP_WORDS.has(w.toLowerCase())),
    )];
  }

  /** Orchestrator signal: known relationships for entities mentioned in the message. */
  signalsFor(message: string): ModuleSignal[] {
    const entities = this.extractEntities(message);
    if (entities.length === 0) return [];
    const relationships: string[] = [];
    for (const entity of entities.slice(0, 5)) {
      for (const edge of this.getEdges(entity, "out").slice(0, 3)) {
        relationships.push(`${edge.from} ${edge.relation} ${edge.to}`);
      }
    }
    if (relationships.length === 0) return [];
    return [{ source: "memory-graph", signal: `Known relationships: ${relationships.slice(0, 5).join("; ")}`, priority: 3, category: "knowledge-graph", confidence: 0.6 }];
  }

  /** Extract and persist entity relationships from a substantial message. */
  recordFrom(message: string): void {
    if (message.length < 40) return;
    const entities = this.extractEntities(message);
    if (entities.length < 2) return;
    for (const edge of this.autoExtractRelationships(message, entities)) {
      this.addEdge(edge.from, edge.relation, edge.to, edge.metadata);
    }
  }
}

export const MemoryGraph = new MemoryGraphImpl();
