import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryIndex } from "./index-core.js";
import { extractIdentityFactsWithLLM, type IdentityFacts } from "../classifiers/identity-extract.js";
import {
  writeMemorySafely,
  appendToDailyLogSafely,
  MemoryWriteBlocked,
} from "./write-safely.js";

import { createLogger } from "../logger.js";
const logger = createLogger("memory.auto-extract");

/**
 * Auto-extract durable identity facts from a user message and persist to
 * IDENTITY.md / USER.md.
 *
 * Replaced the prior regex-driven extraction in May 2026 because the rename
 * regex `^([A-Z][a-zA-Z]{1,15})(?:\.|!|\s*$)` was misfiring on every short
 * capitalized message ending in a period — "Done." / "Cool." / "Welcome."
 * tried to rename the agent. STOP_WORDS gated some but not all. Now an LLM
 * classifier handles extraction; if it returns null the regex path is NOT
 * used as a fallback (no extraction is safer than a wrong durable write).
 */
export async function autoExtractAndSave(
  memory: MemoryIndex,
  userMessage: string,
  assistantResponse: string,
  sessionId?: string,
): Promise<void> {
  // Pre-flight skip on tainted inputs — keeps the LLM classifier from
  // even seeing obvious injection material. The per-write gate inside
  // writeMemorySafely / appendToDailyLogSafely is the load-bearing
  // safety: it blocks on threshold instead of just warning.
  try {
    const { checkMemoryTaint } = await import("../sanitize.js");
    const taint = checkMemoryTaint(userMessage);
    if (!taint.safe) {
      logger.info(`[memory] Auto-extract skipped: ${taint.reason}`);
      return;
    }
    const taintReply = checkMemoryTaint(assistantResponse);
    if (!taintReply.safe) {
      logger.info(`[memory] Auto-extract skipped (assistant): ${taintReply.reason}`);
      return;
    }
  } catch {
  }

  let facts: IdentityFacts | null = null;
  try {
    facts = await extractIdentityFactsWithLLM(userMessage);
  } catch (e) {
    logger.warn(`[memory] identity classifier failed: ${(e as Error).message}`);
    return;
  }
  if (!facts) return;

  if (facts.agent_name) {
    const identityPath = join(memory["memoryDir"], "IDENTITY.md");
    if (existsSync(identityPath)) {
      let content = readFileSync(identityPath, "utf-8");
      content = content.replace(/^- Name:.*$/m, `- Name: ${facts.agent_name}`);
      try {
        writeMemorySafely({
          content,
          source: "auto-extract",
          target: identityPath,
          mode: "overwrite",
        });
        memory.markDirty();
        logger.info(`[memory] Auto-updated agent name to: ${facts.agent_name}`);
      } catch (e) {
        if (e instanceof MemoryWriteBlocked) {
          logger.warn(`[memory] Auto-extract IDENTITY write blocked: ${e.reason}`);
          return;
        }
        throw e;
      }
    }
    safeAppendDaily(memory, `Agent renamed to "${facts.agent_name}" by user`, sessionId);
  }

  if (facts.user_name) {
    const userPath = join(memory["memoryDir"], "USER.md");
    if (existsSync(userPath)) {
      let content = readFileSync(userPath, "utf-8");
      if (content.includes("- Name:")) {
        content = content.replace(/^- Name:.*$/m, `- Name: ${facts.user_name}`);
      } else {
        content += `\n- Name: ${facts.user_name}`;
      }
      try {
        writeMemorySafely({
          content,
          source: "auto-extract",
          target: userPath,
          mode: "overwrite",
        });
        memory.markDirty();
        logger.info(`[memory] Auto-saved user name: ${facts.user_name}`);
      } catch (e) {
        if (e instanceof MemoryWriteBlocked) {
          logger.warn(`[memory] Auto-extract USER write blocked: ${e.reason}`);
          return;
        }
        throw e;
      }
    }
    safeAppendDaily(memory, `User introduced themselves as "${facts.user_name}"`, sessionId);
  }

  if (facts.user_location || facts.user_employer || facts.user_role || facts.family_count) {
    const summary: string[] = [];
    if (facts.user_role) summary.push(`role: ${facts.user_role}`);
    if (facts.user_employer) summary.push(`employer: ${facts.user_employer}`);
    if (facts.user_location) summary.push(`location: ${facts.user_location}`);
    if (facts.family_count) summary.push(`family: ${facts.family_count.n} ${facts.family_count.relation}`);
    safeAppendDaily(memory, `User shared identity facts — ${summary.join(", ")}`, sessionId);
  }

  // Phase 2 (May 2026) — auto-write durable preferences and biographical
  // events into the Facts DB. Both grok-4 and gpt-5.5 freeze on these:
  // "never greet me in Spanish" reads as command-to-agent → no `remember`
  // call; "my dog passed away" triggers empathy training → no `remember`
  // call. Server-side extraction makes capture model-agnostic.
  //
  // Writes go through memory.rememberFact (NOT writeMemorySafely) because
  // they target the bitemporal Facts DB, not a markdown file. The UNIQUE
  // constraint on (kind, content, entities) handles the no-double-write
  // case if the model ALSO called `remember` this turn. autoInvalidate
  // supersedes older contradicting facts.
  if (facts.preference_rule) {
    try {
      memory.rememberFact(facts.preference_rule, { kind: "opinion", confidence: 0.85 });
      safeAppendDaily(memory, `Captured preference: ${facts.preference_rule}`, sessionId);
      logger.info(`[memory] Auto-saved preference: ${facts.preference_rule}`);
    } catch (e) {
      logger.warn(`[memory] preference write failed: ${(e as Error).message}`);
    }
  }
  if (facts.biographical_event) {
    try {
      memory.rememberFact(facts.biographical_event, { kind: "experience", confidence: 0.9 });
      safeAppendDaily(memory, `Captured event: ${facts.biographical_event}`, sessionId);
      logger.info(`[memory] Auto-saved biographical event: ${facts.biographical_event}`);
    } catch (e) {
      logger.warn(`[memory] biographical_event write failed: ${(e as Error).message}`);
    }
  }
  // Named family / close relationships. "my wife's name is Sam" was
  // hitting Phase 3's long-tail remember() path because the classifier
  // only knew family_count (a number), not names. Capturing relation+
  // name pairs server-side puts these durable identity facts on the
  // same silent path as user_name / user_location. Phrasing puts the
  // name as the @-entity so recallByEntity('jenny') surfaces the fact.
  if (facts.relationships) {
    for (const rel of facts.relationships) {
      try {
        const content = `@${rel.name} is the user's ${rel.relation}`;
        memory.rememberFact(content, { kind: "world", confidence: 0.95 });
        safeAppendDaily(memory, `Captured relationship: ${rel.relation} = ${rel.name}`, sessionId);
        logger.info(`[memory] Auto-saved relationship: ${rel.relation} = ${rel.name}`);
      } catch (e) {
        logger.warn(`[memory] relationship write failed: ${(e as Error).message}`);
      }
    }
  }
}

function safeAppendDaily(memory: MemoryIndex, content: string, sessionId?: string): void {
  try {
    appendToDailyLogSafely({ memory, source: "auto-extract", content, sessionId });
  } catch (e) {
    if (e instanceof MemoryWriteBlocked) {
      logger.warn(`[memory] Auto-extract daily-log entry blocked: ${e.reason}`);
      return;
    }
    throw e;
  }
}
