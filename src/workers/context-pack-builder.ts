/**
 * Context Pack Builder.
 *
 * The single most important piece for sub-agent quality. Pre-bakes
 * everything a worker needs into one payload so the worker doesn't spin
 * up cold and act like a junior dev who's never seen the codebase.
 *
 * Per spec §8: a Context Pack contains
 *   - task: description, success criteria, constraints, "do not redo"
 *   - context: recent turns from parent session, referenced files (pre-
 *     loaded), memory hits (pre-fetched), AGENTS.md rules from scope
 *   - capabilities: which provider features are required
 *   - budget: maxIterations / maxTokens / maxWallTimeMs / maxSelfEditCalls
 *   - routing: lane + preferredProvider
 *   - secrets: names + access grants only, never values (§12)
 *
 * Workers spawn with maybe 8-15K tokens of pre-baked context vs the ~200
 * tokens they'd get with a naive "build the kraken bot" delegation.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, dirname, isAbsolute, resolve, relative } from "node:path";
import { homedir } from "node:os";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { ContextPack, FileSnapshot, MemoryHit, OpBudget, OpLane, ProviderCapabilityRequirement } from "./types.js";

import { createLogger } from "../logger.js";
const logger = createLogger("workers.context-pack");

// ── Public API ─────────────────────────────────────────────────────────────

export interface BuildPackInput {
  // Task definition (what the worker must do)
  description: string;
  successCriteria?: string[];
  constraints?: string[];
  notWhatToRedo?: string[];

  // Context inputs (what the worker should know)
  parentSessionMessages?: ChatCompletionMessageParam[];
  parentTurnsToInclude?: number;       // default 6 (3 user + 3 assistant)
  referencedFilePaths?: string[];      // absolute or workspace-relative
  scopeForAgentsRules?: string;        // file/dir to walk AGENTS.md from
  memoryQuery?: string;                // text to search memory for
  memoryHitsLimit?: number;            // default 5

  // Capabilities + routing
  capabilities?: ProviderCapabilityRequirement;
  lane?: OpLane;                        // default "build"
  preferredProvider?: string;
  budget?: Partial<OpBudget>;
  secretsAllowed?: string[];

  // Tuning
  maxFileBytes?: number;                // per file, default 12KB
  maxTotalContextTokens?: number;      // soft cap, default 12000
}

export async function buildContextPack(input: BuildPackInput): Promise<ContextPack> {
  const successCriteria = input.successCriteria ?? [];
  const constraints = input.constraints ?? [];
  const notWhatToRedo = input.notWhatToRedo ?? [];
  const lane = input.lane ?? "build";

  const recentTurns = sliceRecentTurns(input.parentSessionMessages || [], input.parentTurnsToInclude ?? 6);
  const referencedFiles = await loadReferencedFiles(input.referencedFilePaths || [], input.maxFileBytes ?? 12_000);
  const agentsRules = await collectAgentsRules(input.scopeForAgentsRules);
  const memoryHits = await fetchMemoryHits(input.memoryQuery, input.memoryHitsLimit ?? 5);

  const budget: OpBudget = {
    maxIterations: input.budget?.maxIterations ?? 30,
    maxTokens: input.budget?.maxTokens ?? 80_000,
    maxWallTimeMs: input.budget?.maxWallTimeMs ?? 15 * 60 * 1000,
    maxSelfEditCalls: input.budget?.maxSelfEditCalls ?? 5,
  };

  return {
    task: {
      description: input.description,
      successCriteria,
      constraints,
      notWhatToRedo,
    },
    context: {
      recentTurns,
      referencedFiles,
      memoryHits,
      agentsRules,
    },
    capabilities: input.capabilities ?? {},
    budget,
    routing: { lane, preferredProvider: input.preferredProvider },
    secrets: { allowed: input.secretsAllowed ?? [] },
  };
}

// ── Section 1: recent turns slice ──────────────────────────────────────────

/**
 * Take the most recent N user-or-assistant turns, ensuring we don't break
 * a tool_call/tool_result pairing (which would confuse the worker).
 */
function sliceRecentTurns(messages: ChatCompletionMessageParam[], n: number): ChatCompletionMessageParam[] {
  if (messages.length === 0 || n <= 0) return [];
  // Take the tail, skipping any leading 'tool' message (orphan tool result)
  const tail = messages.slice(-n);
  while (tail.length > 0 && tail[0].role === "tool") tail.shift();
  return tail;
}

// ── Section 2: referenced files (pre-loaded) ───────────────────────────────

const LAX_REPO_ROOT = resolveLAXRepoRoot();

function resolveLAXRepoRoot(): string {
  // Same heuristic as self-edit-tool — module URL → repo root
  try {
    return resolve(new URL("..", new URL("../../", import.meta.url)).pathname.replace(/^\//, "").replace(/\/$/, ""));
  } catch {
    return process.cwd();
  }
}

async function loadReferencedFiles(paths: string[], maxBytes: number): Promise<FileSnapshot[]> {
  const out: FileSnapshot[] = [];
  for (const p of paths) {
    const abs = isAbsolute(p) ? p : resolve(LAX_REPO_ROOT, p);
    try {
      if (!existsSync(abs)) {
        logger.info(`[pack] referenced file missing: ${p}`);
        continue;
      }
      const stat = statSync(abs);
      if (stat.isDirectory()) {
        logger.info(`[pack] referenced path is a directory, skipped: ${p}`);
        continue;
      }
      const raw = readFileSync(abs, "utf-8");
      const truncated = raw.length > maxBytes;
      out.push({
        path: relativeFromRoot(abs),
        content: truncated ? raw.slice(0, maxBytes) : raw,
        truncated,
      });
    } catch (e) {
      logger.warn(`[pack] failed to read ${p}: ${(e as Error).message}`);
    }
  }
  return out;
}

function relativeFromRoot(abs: string): string {
  try {
    const rel = relative(LAX_REPO_ROOT, abs).replace(/\\/g, "/");
    return rel.startsWith("..") ? abs : rel;
  } catch {
    return abs;
  }
}

// ── Section 3: AGENTS.md rules ─────────────────────────────────────────────

/**
 * Walk up from scopeHint looking for AGENTS.md files; concatenate them
 * root-first so subtree rules listed last visually override. Same shape
 * as self-edit-tool's collectSubtreeRules so workers see identical
 * architectural guidance.
 */
async function collectAgentsRules(scopeHint?: string): Promise<string> {
  try {
    const startPath = scopeHint
      ? (isAbsolute(scopeHint) ? scopeHint : resolve(LAX_REPO_ROOT, scopeHint))
      : LAX_REPO_ROOT;

    const dirs: string[] = [];
    let cur = existsSync(startPath) ? startPath : dirname(startPath);
    if (existsSync(startPath) && !statSync(startPath).isDirectory()) cur = dirname(startPath);

    while (true) {
      dirs.push(cur);
      if (cur === LAX_REPO_ROOT || !cur.startsWith(LAX_REPO_ROOT)) break;
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    if (!dirs.includes(LAX_REPO_ROOT)) dirs.push(LAX_REPO_ROOT);

    const parts: string[] = [];
    for (const d of dirs.reverse()) {
      const p = join(d, "AGENTS.md");
      if (existsSync(p)) {
        const rel = relativeFromRoot(p);
        const body = readFileSync(p, "utf-8").trim();
        parts.push(`--- ${rel} ---\n${body}`);
      }
    }
    return parts.join("\n\n");
  } catch (e) {
    logger.warn(`[pack] failed to collect AGENTS.md: ${(e as Error).message}`);
    return "";
  }
}

// ── Section 4: memory hits ────────────────────────────────────────────────

/**
 * Pre-fetch memory matches for the worker. Best-effort: if the memory
 * index isn't reachable from this process, returns empty. The worker
 * still has memory_search tools at runtime; pre-fetching is a perf hint
 * and a way to ensure key facts are in the system prompt unconditionally.
 */
async function fetchMemoryHits(query: string | undefined, limit: number): Promise<MemoryHit[]> {
  if (!query || !query.trim()) return [];
  try {
    const dataDir = join(homedir(), ".lax");
    // Lazy import — memory module is heavy
    const { MemoryIndex } = await import("../memory.js");
    const idx = new MemoryIndex(dataDir);
    const results = await idx.search(query, { maxResults: limit });
    return results.map(r => ({
      source: r.source || "memory",
      snippet: (r.snippet || "").slice(0, 400),
      score: r.score,
    }));
  } catch (e) {
    logger.info(`[pack] memory pre-fetch skipped: ${(e as Error).message}`);
    return [];
  }
}
