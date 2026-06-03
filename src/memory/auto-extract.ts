import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryIndex } from "./index-core.js";
import type { FactKind } from "./types.js";
import { extractIdentityFactsWithLLM, type IdentityFacts } from "../classifiers/identity-extract.js";
import {
  writeMemorySafely,
  appendToDailyLogSafely,
  MemoryWriteBlocked,
} from "./write-safely.js";
import { stripHarnessScaffolding } from "../sanitize.js";

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
  // Strip harness scaffolding (system-reminder blocks, anti-loop / self-check
  // nudges) BEFORE the taint check and classifier — it's injected by the
  // harness, not user-authored, and must never become a durable fact.
  userMessage = stripHarnessScaffolding(userMessage);
  assistantResponse = stripHarnessScaffolding(assistantResponse);
  if (!userMessage.trim()) {
    logger.info("[memory] Auto-extract skipped: no user-authored content after scaffolding strip");
    return;
  }

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
      if (content.includes("- Name:")) {
        content = content.replace(/^- Name:.*$/m, `- Name: ${facts.agent_name}`);
      } else {
        content += `\n- Name: ${facts.agent_name}`;
      }
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
  // Writes go through saveFactSmart → memory.retainSmart (NOT writeMemorySafely)
  // because they target the bitemporal Facts DB, not a markdown file. The
  // UNIQUE constraint on (kind, content, entities) handles the no-double-write
  // case if the model ALSO called `remember` this turn. retainSmart adds
  // semantic dedup on top: paraphrased restatements ("likes dark mode" vs
  // "prefers dark mode") are merged/superseded by the resolver rather than
  // piling up as separate rows the way the prior exact-match rememberFact did.
  // See saveFactSmart for the cost gate (resolver skips the LLM when there's
  // no near-duplicate candidate).
  if (facts.preference_rule) {
    if (await saveFactSmart(memory, facts.preference_rule, "opinion", 0.85)) {
      safeAppendDaily(memory, `Captured preference: ${facts.preference_rule}`, sessionId);
      logger.info(`[memory] Auto-saved preference: ${facts.preference_rule}`);
    }
  }
  if (facts.biographical_event) {
    if (await saveFactSmart(memory, facts.biographical_event, "experience", 0.9)) {
      safeAppendDaily(memory, `Captured event: ${facts.biographical_event}`, sessionId);
      logger.info(`[memory] Auto-saved biographical event: ${facts.biographical_event}`);
    }
  }
  // Named family / close relationships. "my wife's name is X" was
  // hitting Phase 3's long-tail remember() path because the classifier
  // only knew family_count (a number), not names. Capturing relation+
  // name pairs server-side puts these durable identity facts on the
  // same silent path as user_name / user_location. Phrasing puts the
  // name as the @-entity so recallByEntity surfaces the fact later.
  if (facts.relationships) {
    for (const rel of facts.relationships) {
      const content = `@${rel.name} is the user's ${rel.relation}`;
      if (await saveFactSmart(memory, content, "world", 0.95)) {
        safeAppendDaily(memory, `Captured relationship: ${rel.relation} = ${rel.name}`, sessionId);
        logger.info(`[memory] Auto-saved relationship: ${rel.relation} = ${rel.name}`);
      }
    }
  }
  // Personal affinities — favorites, loves, hates about foods, places,
  // brands, hobbies, etc. The model on its own often skips these because
  // they don't fit the "never X / always Y / I prefer Z" instruction-
  // shape it associates with preference_rule. Verified May 2026:
  // affinity statements like "I love pizza, X is my favorite spot"
  // produced zero remember() calls and zero classifier writes (xAI was
  // bypassing the classifier; both failures lifted now). Kind=opinion
  // because affinities are stable user preferences, conf=0.85 matches
  // preference_rule.
  if (facts.personal_affinity) {
    for (const affinity of facts.personal_affinity) {
      if (await saveFactSmart(memory, affinity, "opinion", 0.85)) {
        safeAppendDaily(memory, `Captured affinity: ${affinity}`, sessionId);
        logger.info(`[memory] Auto-saved affinity: ${affinity}`);
      }
    }
  }
  // Ongoing states — any durable present-tense fact about the user
  // (current medications, diets, fitness routines, possessions, habits,
  // active projects, learning, living situation, etc). Distinct from
  // biographical_event (point-in-time) because these are present-tense
  // states that should still be true tomorrow. Verified May 2026: model
  // saved "I'm taking <med>" via remember() but skipped "I'm also taking
  // <med2>" two turns later — same shape, different model judgment. The
  // classifier closes the variance. Kind=observation because they're
  // factual statements about the user's current state, conf=0.9 (high —
  // these are explicit user claims about their own life).
  if (facts.ongoing_state) {
    for (const state of facts.ongoing_state) {
      if (await saveFactSmart(memory, state, "observation", 0.9)) {
        safeAppendDaily(memory, `Captured ongoing state: ${state}`, sessionId);
        logger.info(`[memory] Auto-saved ongoing state: ${state}`);
      }
    }
  }
}

// Letter prefixes parseFactLine expects (mirrors KIND_PREFIX in
// index-facts-mutate.ts — kept local to avoid a cross-module dep just for a
// 4-entry map). retainSmart parses the bullet back into kind/content/entities,
// so emitting the same `- <prefix>(c=<conf>) <content>` shape rememberFact
// used preserves every existing call site's kind + confidence exactly.
const KIND_LETTER: Record<FactKind, string> = {
  world: "W",
  experience: "E",
  opinion: "O",
  observation: "S",
};

// Route a single auto-extracted fact through semantic dedup.
//
// COST: retainSmart's resolver only calls an LLM when findResolverCandidates
// returns ≥1 near-duplicate (same entity, or FTS keyword overlap when there's
// no entity). resolveFact short-circuits to a side-effect-free ADD with zero
// LLM calls when the candidate set is empty — the common case for a genuinely
// new fact. So the added cost is bounded to turns that actually restate
// something already stored, which is exactly when we want the merge. The
// resolver also uses a cheap local model (qwen2.5:3b) at temp 0 / 80 max
// tokens, so even the worst case (several near-dup facts in one turn) is a
// handful of tiny local completions, not a latency cliff. No gating beyond the
// resolver's built-in candidate check was needed.
//
// Returns true when the fact was written or merged (caller logs + daily-log),
// false on failure so the caller skips its bookkeeping. Errors are logged, not
// thrown — one bad fact must not abort the rest of the extraction pass.
async function saveFactSmart(
  memory: MemoryIndex,
  content: string,
  kind: FactKind,
  confidence: number,
): Promise<boolean> {
  const bullet = `- ${KIND_LETTER[kind]}(c=${confidence.toFixed(2)}) ${content.trim()}`;
  try {
    await memory.retainSmart(bullet, "auto-extract");
    return true;
  } catch (e) {
    logger.warn(`[memory] ${kind} write failed: ${(e as Error).message}`);
    return false;
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
