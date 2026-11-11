import { existsSync } from "node:fs";
import type { MemoryIndex } from "./index-core.js";
import { ensurePersonalityFiles, readPersonalityFile } from "./personality.js";
import { readProjectBrief, briefForContext } from "./project-brief.js";
import { isProjectId } from "./project-docs/paths.js";
import { projectDocsDir } from "./project-docs/folders.js";
import { safeReadTextFile } from "./utils.js";
import { scanMentionedEntities, renderKnownEntitiesBody } from "./entity-context.js";
import { logMemoryRecall } from "./recall-telemetry.js";
import { coreMemoryBody } from "./core-memory.js";

// autoSearchContext moved to its own module (task-start cross-session recall
// lives there). Re-exported so existing importers of context.js keep working.
export { autoSearchContext } from "./auto-search-context.js";
export type { AutoSearchOptions } from "./auto-search-context.js";

function sanitizeDailyLogForModeration(log: string): string {
  const lines = log.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const match = line.match(/^(\[[^\]]+\](?:\s*\[[^\]]+\])?\s*(?:User|Agent):\s*)(.*)$/);
    if (!match) { out.push(line); continue; }
    const prefix = match[1];
    const body = match[2];
    if (body.length <= 60) { out.push(line); continue; }
    out.push(`${prefix}[${body.length}-char entry, redacted from context for moderation safety]`);
  }
  return out.join("\n");
}

function provenanceHeader(
  source: string,
  sourceType: string,
  trust: string,
  taint: string,
  label: string,
): string {
  return `[provenance source=${source} source_type=${sourceType} trust=${trust} taint=${taint} label=${JSON.stringify(label)}]`;
}

/**
 * Filter today's daily log to timestamped blocks for the given session ID.
 * Untagged system/background events pass; legacy untagged User/Agent
 * transcript blocks fail closed — `today_context` must show THIS session's
 * earlier turns, never another chat's transcript in the same date file
 * (the May-2026 cross-session bleed fix). Tagged-line format:
 * `[session-id] [HH:MM:SS] text`.
 */
function filterDailyLogToSession(content: string, sessionId?: string): string {
  const lines = content.split("\n");
  const kept: string[] = [];
  const taggedEntry = /^\[([^\]]+)\]\s+\[(\d{2}:\d{2}:\d{2})\]\s*(.*)$/;
  const legacyEntry = /^\[(\d{2}:\d{2}:\d{2})\]\s*(.*)$/;
  let keepContinuation = true;
  for (const line of lines) {
    const tagged = line.match(taggedEntry);
    if (tagged) {
      keepContinuation = !!sessionId && tagged[1] === sessionId;
      if (keepContinuation) kept.push(line);
      continue;
    }

    const legacy = line.match(legacyEntry);
    if (legacy) {
      keepContinuation = !/^(?:User|Agent):\s*/i.test(legacy[2]);
      if (keepContinuation) kept.push(line);
      continue;
    }

    if (keepContinuation) kept.push(line);
  }
  return kept.join("\n");
}

/**
 * The memory context block split at the prompt-cache boundary: `stable`
 * renders byte-identically turn-to-turn within a session/day (personality,
 * project brief, core_memory); `volatile` changes intra-session (clock,
 * daily-log tail, per-message entities). buildContextBlock concatenates
 * them, so a cache breakpoint goes at `stable.length`.
 */
export interface ContextBlockParts { stable: string; volatile: string }

export interface ContextBlockOpts { skipDailyLog?: boolean; sanitizeDailyLog?: boolean; userMessage?: string; sessionId?: string; projectId?: string }

export async function buildContextBlock(memory: MemoryIndex, opts: ContextBlockOpts = {}): Promise<string> {
  const parts = await buildContextBlockParts(memory, opts);
  return parts.stable + parts.volatile;
}

async function profileSections(memDir: string): Promise<string[]> {
  const sections: string[] = [];
  ensurePersonalityFiles(memDir);

  const identity = await readPersonalityFile(memDir, "identity");
  if (identity) {
    sections.push(`<agent_identity>\n${provenanceHeader("personality", "memory-file", "unknown", "clean", "Agent identity profile")}\n${identity}\n</agent_identity>`);
  }

  const heart = await readPersonalityFile(memDir, "heart");
  if (heart) {
    sections.push(`<agent_heart>\n${provenanceHeader("personality", "memory-file", "unknown", "clean", "Agent behavior profile")}\n${heart}\n</agent_heart>`);
  }

  const user = await readPersonalityFile(memDir, "user");
  if (user) {
    sections.push(`<user_profile>\n${provenanceHeader("personality", "memory-file", "unknown", "clean", "User profile")}\n${user}\n</user_profile>`);
  }
  return sections;
}

/**
 * What a project chat knows about its project: the living brief (the shared,
 * evolving narrative every agent on the project reads; updates flow back
 * through project_brief_update) and where its documents are.
 */
async function projectSections(projectId: string, memDir: string): Promise<string[]> {
  const sections: string[] = [];
  const brief = await readProjectBrief(projectId, memDir);
  if (brief) {
    sections.push(
      `<project_brief>\n${provenanceHeader("project-brief", "memory-file", "unknown", "clean", "Active project brief")}\n` +
      `(the current state of this project. Weave it in naturally; ` +
      `record changes via project_brief_update — do not repeat this block verbatim.)\n\n${briefForContext(projectId, brief)}\n</project_brief>`,
    );
  }
  // The documents folder exists once the project-docs index has seen a chat
  // project (never for a code folder).
  const docsDir = isProjectId(projectId) ? projectDocsDir(projectId) : null;
  if (docsDir && existsSync(docsDir)) {
    sections.push(
      `<project_documents>\nThis project's documents folder: ${docsDir}\n` +
      `Its files, and those in a folder the user linked to the project, are indexed: memory_search returns their most relevant passages ` +
      `with the file each came from, and relevant ones can appear among recalled memories. Save documents made for this project there.\n</project_documents>`,
    );
  }
  return sections;
}

/**
 * Only the three profile files (identity / heart / user) — local reads, no
 * retrieval. The turn-context wallclock ships this when the full build is
 * wedged on a retrieval dependency, so a slow embedder can't make the agent
 * forget its own name and the user's.
 */
export async function buildProfileBlock(memory: MemoryIndex): Promise<string> {
  const sections = await profileSections(memory["memoryDir"]);
  if (sections.length === 0) return "";
  return "\n\n--- MEMORY CONTEXT (auto-loaded, do not repeat verbatim to user) ---\n" + sections.join("\n\n") + "\n--- END MEMORY CONTEXT ---";
}

export async function buildContextBlockParts(
  memory: MemoryIndex,
  opts: ContextBlockOpts = {},
): Promise<ContextBlockParts> {
  // ── STABLE sections (cache-friendly prefix) ──
  const memDir = memory["memoryDir"];
  const cfg = memory.getConfig();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  const stableSections = await profileSections(memDir);

  // Only when this turn is scoped to a project (set via the session→project map).
  if (opts.projectId) stableSections.push(...await projectSections(opts.projectId, memDir));

  // Entities mentioned in this turn's user message. Run BEFORE core_memory
  // rendering so cold facts about those entities get reinforced (last_updated
  // bumped) — their hot-score jumps, so they make the selection cut this turn
  // AND stay warm for the next session. The "human memory" pattern: a fact
  // untouched for months returns to hot context the moment it's relevant.
  // The fetched facts are kept and rendered inline in <known_entities> below.
  const entityScan = scanMentionedEntities(memory, opts.userMessage);

  // <core_memory> — unified, read-only projection of the Facts DB grouped by
  // kind (replaced <user_preferences> + <learned_facts>). A live view is
  // load-bearing: without one, grok-4 and gpt-5.5 ack-and-skipped `remember`
  // on durable statements (verified May 2026). Rendering from the DB (not a
  // file) keeps the affordance without append-only growth. Which facts, and
  // in what order: core-memory.ts.
  const core = coreMemoryBody(memory, tz);
  const renderedCoreFactIds = core.renderedIds;
  if (core.body) {
    stableSections.push(
      `<core_memory>\n${provenanceHeader("retained-fact", "fact-db", "mixed", "unknown", "Retained fact memory")}\n` +
      `(long-term context, not proof. It may be stale, mistaken, inferred, or copied from prior assistant prose. ` +
      `Use it naturally for personal continuity, but NEVER use it as evidence for current runtime, security, policy, ` +
      `permission, service, or project state. Verify those with fresh tools. Legacy entries are unverified. ` +
      `Do NOT narrate that you're using memory, and do NOT edit this block. Extend via remember/update_fact/forget.)\n\n${core.body}\n</core_memory>`
    );
  }

  // ── STABLE/VOLATILE BOUNDARY: everything above renders byte-identically
  // turn-to-turn; everything below changes intra-session. A prompt-cache
  // breakpoint belongs exactly here (exposed as `stable.length`). ──
  const volatileSections: string[] = [];

  // Current date at DAY granularity — the model's fresh clock signal
  // (daily-log timestamps freeze when nothing is written). Deliberately no
  // hours/minutes/seconds: a to-the-second clock re-rendered every turn
  // defeated prompt caching; precise "now" belongs to per-turn tail
  // injection, not the system prompt. Changes once per local calendar day.
  const _now = new Date();
  const _dayStr = _now.toLocaleDateString("en-US", {
    timeZone: tz, weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  // en-CA renders the LOCAL date as YYYY-MM-DD (toISOString would be UTC).
  volatileSections.push(
    `<current_datetime>\nToday is ${_dayStr}\nISO date: ${_now.toLocaleDateString("en-CA", { timeZone: tz })}\nTimezone: ${tz}\n</current_datetime>`
  );

  if (!opts.skipDailyLog) {
    const todayLog = memory.getDailyLogPath();
    if (existsSync(todayLog)) {
      const content = safeReadTextFile(todayLog);
      if (content && content.trim()) {
        // Cross-session bleed fix (May 2026): filter to this session's
        // tagged lines BEFORE the tail slice. Legacy untagged transcript
        // blocks fail closed; untagged system events remain available.
        const filtered = filterDailyLogToSession(content, opts.sessionId);
        const recent = filtered.trim().slice(-cfg.dailyLogTailChars);
        if (recent) {
          const displayed = opts.sanitizeDailyLog ? sanitizeDailyLogForModeration(recent) : recent;
          volatileSections.push(
            `<today_context>\n${provenanceHeader("daily-log", "memory-file", "mixed", "unknown", "Current-session daily log")}\n` +
            `${displayed}\n</today_context>`,
          );
        }
      }
    }
  }

  if (entityScan.mentionedEntities.length > 0) {
    // Inline recall: render the matched entities' facts (already fetched
    // for reinforcement above) instead of a bare name list, so a one-word
    // mention is answered from context instead of a memory_search tool
    // round-trip. Facts <core_memory> already rendered are not repeated.
    const render = renderKnownEntitiesBody(entityScan, renderedCoreFactIds, cfg.entityFactsMaxBytes);
    const guidance = render.factsRendered > 0
      ? "(facts you already hold about entities named in this message — recall, not proof; verify current runtime/project state with fresh tools)\n"
      : "";
    volatileSections.push(
      `<known_entities>\n${provenanceHeader("entity", "entity-page", "unknown", "unknown", "Mentioned known entities")}\n` +
      `${guidance}${render.body}\n</known_entities>`,
    );
    logMemoryRecall({
      sessionId: opts.sessionId,
      matched: entityScan.mentionedEntities,
      factsRendered: render.factsRendered,
      factsDeduped: render.factsDeduped,
      bytesInjected: render.bytes,
      totalEntities: entityScan.totalEntities,
      scannedEntities: entityScan.scannedEntities,
    });
  } else if (entityScan.scannedEntities > 0) {
    // Zero matches is the interesting datapoint — log it.
    logMemoryRecall({
      sessionId: opts.sessionId,
      matched: [],
      factsRendered: 0,
      factsDeduped: 0,
      bytesInjected: 0,
      totalEntities: entityScan.totalEntities,
      scannedEntities: entityScan.scannedEntities,
    });
  }

  if (stableSections.length === 0 && volatileSections.length === 0) return { stable: "", volatile: "" };

  // stable + volatile concatenates to exactly the legacy single-string block.
  const sep = stableSections.length > 0 && volatileSections.length > 0 ? "\n\n" : "";
  return {
    stable: "\n\n--- MEMORY CONTEXT (auto-loaded, do not repeat verbatim to user) ---\n" + stableSections.join("\n\n"),
    volatile: sep + volatileSections.join("\n\n") + "\n--- END MEMORY CONTEXT ---",
  };
}

