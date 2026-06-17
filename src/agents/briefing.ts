/**
 * Spawned-agent briefing assembly.
 *
 * A spawned agent starts with no conversation history — its only context is
 * the system prompt the driver hands it. This builds the context block that
 * makes a spawned agent situationally aware: who the user is, the durable
 * facts, the memory most relevant to THIS task, the project it belongs to,
 * and what secrets exist.
 *
 * Lifted out of server/handler-events.ts so the driver stays under the file
 * budget and the briefing has one testable seam (memory + project-brief →
 * prompt string).
 *
 * Sources, in order:
 *  - USER.md head (who the user is)
 *  - recent durable facts (recency-ranked, from the Facts DB)
 *  - task-relevant memory (semantic search keyed on the task — NEW; this is
 *    what turns a generic agent into one that knows the project's specifics)
 *  - project brief (PROJECT.md for the agent's resolved project — NEW)
 *  - secret names (so the agent knows what credentials it can reference)
 *
 * Every source is best-effort: a failure in any one degrades that section to
 * a default and never blocks the spawn.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { MemoryIndex } from "../memory/index.js";
import type { SecretsStore } from "../secrets.js";
import { readProjectBrief } from "../memory/project-brief.js";
import { createLogger } from "../logger.js";

const logger = createLogger("agents.briefing");

const MAX_USER_CHARS = 500;
const MAX_FACTS_CHARS = 500;
const MAX_RELEVANT_CHARS = 700;
const MAX_BRIEF_CHARS = 800;
const MIN_RELEVANT_SCORE = 0.5;
const MAX_RELEVANT_HITS = 4;

export interface BriefingDeps {
  dataDir: string;
  memoryIndex: MemoryIndex;
  secretsStore: SecretsStore;
  /** The task the agent was spawned to do — keys the task-relevant search. */
  task: string;
  /** The agent's resolved project (from the roster), or null for ungrouped. */
  project?: { id: string; name: string } | null;
}

function cap(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 3) + "..." : text;
}

/**
 * Assemble the briefing block appended to a spawned agent's system prompt.
 * Async because both the semantic search and the project-brief read hit
 * disk / the index.
 */
export async function buildBriefing(deps: BriefingDeps): Promise<string> {
  const { dataDir, memoryIndex, secretsStore, task, project } = deps;

  let userBlock = "(none)";
  try {
    const uMd = join(dataDir, "memory", "USER.md");
    if (existsSync(uMd)) {
      const u = readFileSync(uMd, "utf-8").slice(0, MAX_USER_CHARS).trim();
      if (u) userBlock = u;
    }
  } catch { /* USER.md unreadable — leave default */ }

  let factsBlock = "(none)";
  try {
    const facts = memoryIndex.recallRecentFacts({ limit: 10, minConfidence: 0.6 });
    if (facts.length > 0) {
      factsBlock = cap(facts.map(f => `- ${f.content}`).join("\n"), MAX_FACTS_CHARS);
    }
  } catch { /* facts DB unavailable — leave default */ }

  // Task-relevant memory — the load-bearing addition. recallRecentFacts is
  // recency-ranked and task-blind; this pulls the chunks actually about what
  // the agent was asked to do. Scored floor keeps noise out on a thin index.
  let relevantBlock = "";
  try {
    const hits = await memoryIndex.search(task, {
      maxResults: MAX_RELEVANT_HITS,
      minScore: MIN_RELEVANT_SCORE,
    });
    if (hits.length > 0) {
      const rendered = hits
        .map(h => `- ${h.snippet.replace(/\s+/g, " ").trim().slice(0, 160)}`)
        .join("\n");
      relevantBlock = `\nRelevant to this task:\n${cap(rendered, MAX_RELEVANT_CHARS)}`;
    }
  } catch (e) {
    logger.warn(`task-relevant memory search failed: ${(e as Error).message}`);
  }

  // Project brief — resolved at the call site but historically never read.
  // The brief is the shared, evolving source of truth for the project the
  // agent belongs to; without it a project agent re-discovers context every run.
  let projectBlock = "";
  if (project?.id) {
    try {
      const brief = await readProjectBrief(project.id);
      if (brief) {
        projectBlock = `\n\n--- PROJECT BRIEF (${project.name}) ---\n${cap(brief, MAX_BRIEF_CHARS)}\n--- END PROJECT BRIEF ---\n`;
      }
    } catch (e) {
      logger.warn(`project brief read failed for ${project.id}: ${(e as Error).message}`);
    }
  }

  const secrets = secretsStore.list().map(s => s.name).join(", ") || "(none)";

  return `\n\n--- BRIEFING ---\nUser: ${userBlock}\nFacts: ${factsBlock}${relevantBlock}\nSecrets: ${secrets}\n--- END ---\n${projectBlock}`;
}
