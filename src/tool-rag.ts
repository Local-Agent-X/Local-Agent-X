/**
 * Tool RAG — semantic retrieval for tool selection.
 *
 * Problem: we ship 40+ tools. Putting all schemas in the LLM context hurts
 * models (Codex returns empty, smaller Ollama models hallucinate tools).
 * Current solution is keyword regex matching, which is brittle: "can you
 * set up a reminder" doesn't match /schedule|cron/.
 *
 * Tool RAG fix: embed every tool's (name + description) at startup. Per user
 * message, embed the message and cosine-similarity rank tools. Return top-K
 * most semantically relevant, always including a pinned core set.
 *
 * Design:
 *   - Build index ONCE per tool set (hashed so we can rebuild on tool changes)
 *   - Graceful fallback: if no embedding provider, return all tools unchanged
 *   - No behavioral change without opt-in (filterToolsSemanticFor must be called)
 */
import type { ToolDefinition } from "./types.js";
import { createHash } from "node:crypto";

import { createLogger } from "./logger.js";
const logger = createLogger("tool-rag");

export interface EmbedFn {
  embed(text: string): Promise<number[]>;
}

export interface ToolRAGOptions {
  topK?: number;        // default 20 — plenty for most requests
  minScore?: number;    // default 0.25 — filter out totally unrelated tools
  corePinned?: string[]; // tools always included regardless of similarity
  includeMCP?: boolean; // always include mcp_* tools (can be noisy if many)
}

interface ToolVector {
  name: string;
  vec: number[];
}

export class ToolRAG {
  private vectors: ToolVector[] = [];
  private toolsHash = "";
  private ready = false;
  private embedFn: EmbedFn | null = null;

  /** Set or update the embedding provider. Rebuild is triggered on next build(). */
  setEmbedder(embed: EmbedFn | null): void {
    this.embedFn = embed;
    this.ready = false;
  }

  /**
   * Index a tool set. Returns immediately if the same tool set was already indexed.
   * Safe to call repeatedly; rebuilds only when the tool list changes.
   */
  async build(tools: ToolDefinition[]): Promise<void> {
    if (!this.embedFn) return;
    const hash = computeToolsHash(tools);
    if (hash === this.toolsHash && this.ready) return;

    const texts = tools.map(t => `${t.name}: ${t.description || t.name}`);
    try {
      const vectors: ToolVector[] = [];
      // Embed one at a time to avoid batch-timeout issues on slow providers
      for (let i = 0; i < tools.length; i++) {
        const v = await this.embedFn.embed(texts[i]);
        vectors.push({ name: tools[i].name, vec: v });
      }
      this.vectors = vectors;
      this.toolsHash = hash;
      this.ready = true;
    } catch (e) {
      logger.warn(`[tool-rag] Index build failed: ${(e as Error).message}. Falling back to keyword filter.`);
      this.ready = false;
    }
  }

  /**
   * Select the most relevant tools for a user message.
   * Returns ALL tools if index isn't built (safe fallback).
   */
  async select(message: string, allTools: ToolDefinition[], opts: ToolRAGOptions = {}): Promise<ToolDefinition[]> {
    if (!this.ready || !this.embedFn || this.vectors.length === 0) return allTools;

    const topK = opts.topK ?? 20;
    const minScore = opts.minScore ?? 0.25;
    const pinned = new Set(opts.corePinned || []);

    let queryVec: number[];
    try {
      queryVec = await this.embedFn.embed(message);
    } catch {
      return allTools;
    }

    // Score every tool. Pinned/MCP tools always make the cut.
    const scored: Array<{ name: string; score: number; pinned: boolean }> = [];
    const vecByName = new Map(this.vectors.map(v => [v.name, v.vec]));
    for (const t of allTools) {
      const v = vecByName.get(t.name);
      const isPinned = pinned.has(t.name) || (opts.includeMCP === true && t.name.startsWith("mcp_"));
      if (!v) {
        // Tool not in index (e.g., added after build) — include by default to be safe
        scored.push({ name: t.name, score: isPinned ? 1.0 : 0.5, pinned: isPinned });
        continue;
      }
      const sim = cosine(queryVec, v);
      scored.push({ name: t.name, score: isPinned ? Math.max(sim, 1.0) : sim, pinned: isPinned });
    }

    // Sort by score desc, take topK (pinned always included first)
    scored.sort((a, b) => b.score - a.score);
    const keep = new Set<string>();
    for (const s of scored) {
      if (s.pinned) { keep.add(s.name); continue; }
      if (keep.size >= topK) break;
      if (s.score < minScore) break;
      keep.add(s.name);
    }

    return allTools.filter(t => keep.has(t.name));
  }

  get isReady(): boolean { return this.ready; }
  get size(): number { return this.vectors.length; }
}

// ── Singleton convenience ─────────────────────────────────

let instance: ToolRAG | null = null;
export function getToolRAG(): ToolRAG {
  if (!instance) instance = new ToolRAG();
  return instance;
}

// ── Helpers ───────────────────────────────────────────────

function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function computeToolsHash(tools: ToolDefinition[]): string {
  const h = createHash("sha1");
  for (const t of tools) h.update(`${t.name}::${t.description || ""}\n`);
  return h.digest("hex").slice(0, 16);
}
