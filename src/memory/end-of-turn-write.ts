/**
 * End-of-turn memory write — fire-and-forget post-response pass.
 *
 * Architectural problem this solves: injecting a "go write to memory" nudge
 * into the live system prompt puts memory writes in direct competition with
 * task completion. Live testing on Codex showed the model paralyzed dividing
 * attention — turn ended with neither a useful answer NOR a memory write.
 *
 * The fix: decouple the two passes. The model finishes its main reply, the
 * user sees the response immediately, THEN a separate small LLM call decides
 * whether anything memory-worthy happened and what to write. The classifier
 * call runs in the background and the write tool is invoked server-side
 * directly (not via the model). No latency for the user, no attention split
 * during the in-flight turn, no hollow promises.
 *
 * Trigger gate: only run for sessions that had a classifier boost OR a
 * cadence-driven nudge during the turn. Don't run end-of-turn writes on
 * every turn — that's wasteful and will produce noise writes.
 *
 * Cost: one Haiku-class call (~$0.0004) only on turns flagged as memory-
 * worthy. For an active 50-turn-day user, fewer than 10 fire — < $0.01/day.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../logger.js";
import { redactKnownSecrets } from "../sanitize.js";
import { resetSession as resetCurateNudge } from "./curate-nudge.js";
import { classifyWithLLM } from "../classifiers/classify-with-llm.js";
import { PERSONALITY_FILES, dedupeProfileMarkdown } from "./personality.js";
import { writeMemorySafely, MemoryWriteBlocked } from "./write-safely.js";
import type { MemoryIndex } from "./index-core.js";

const logger = createLogger("memory.end-of-turn-write");

const TIMEOUT_MS = 8000; // generous — runs in background, no user blocking

const WRITE_DECISION_PROMPT = `You decide whether the user/agent exchange just finished revealed something durable about the USER (preferences, workflow rules, communication style, identity) that belongs in their narrative profile (USER.md).

OUTPUT EXACTLY ONE JSON LINE, no prose, no code fences:
{"write": false} | {"write": true, "action": "append"|"replace_section", "section_heading": "string or null", "content": "string"}

DECISION RULES:
- write=false unless the exchange revealed something durable about the USER's preferences, workflow, or identity.
- This pass only writes to USER.md (the narrative profile). Cap 2000 chars total.
- Standalone facts (names of family, project conventions, multi-step workflows, dates, things-that-happened) are NOT for this pass — the agent has a separate \`remember\` tool that saves those into the Facts DB during the turn. Do NOT try to capture them here.
- action="replace_section" if the topic likely already has a section (use the section_heading you'd use); "append" only for genuinely new topics.
- content: write the GENERALIZED rule, not the verbatim correction. Bad: "user said use facebook dashboard for that one query." Good: "User prefers Meta Business Suite over per-app dashboards for analytics across Meta properties — has richer aggregate data."
- Keep content tight (1-3 sentences max for replace_section, 1-2 for append). USER.md is bounded — bloat costs every future turn.
- If the exchange was routine (q&a, casual chat, in-task work without preference signal), write=false.

Examples (input → output):
- "user: always sort my reports by date / agent: got it, sorting now" → {"write": true, "action": "append", "section_heading": null, "content": "Reports default to sort-by-date (most recent first) — applies to any report request unless user overrides."}
- "user: that's facebook stats, I want instagram, switch the dropdown / agent: switched, here are the IG numbers" → {"write": true, "action": "replace_section", "section_heading": "Analytics workflow", "content": "Analytics workflow: For Instagram analytics, use Meta Business Suite (business.facebook.com/latest/insights) and toggle the asset dropdown to Instagram — user prefers it over the IG app for richer aggregate data."}
- "user: what's my follower count / agent: you have N followers" → {"write": false}
- "user: my sister's name is Alex / agent: noted" → {"write": false}`;

export interface EndOfTurnContext {
  sessionId: string;
  userMessage: string;
  assistantReply: string;
  memory: MemoryIndex;
}

/**
 * Fire-and-forget. Caller does NOT await this — it should run in the
 * background after the user has already received the assistant's reply.
 *
 * Returns nothing (void promise). All errors swallowed (logged) — the
 * memory pass failing silently is correct UX; we don't want to surface
 * post-turn errors to the user who already got their answer.
 */
export async function runEndOfTurnMemoryWrite(ctx: EndOfTurnContext): Promise<void> {
  if (!ctx.sessionId || !ctx.userMessage || !ctx.assistantReply) return;

  // Always reset the curate-nudge per-session counter at end-of-turn — the
  // in-prompt nudge is being phased out in favor of this pass, but resetting
  // keeps the safety net from double-firing during the transition.
  try { resetCurateNudge(ctx.sessionId); } catch {}

  // Sanitize before sending to the classifier — the user's message and
  // assistant reply may contain credentials or other secrets registered
  // with the secrets vault.
  const safeUser = redactKnownSecrets(ctx.userMessage).slice(0, 2000);
  const safeReply = redactKnownSecrets(ctx.assistantReply).slice(0, 2000);

  const userBlock =
    `EXCHANGE JUST COMPLETED:\n\n` +
    `[USER]\n"""${safeUser}"""\n\n` +
    `[AGENT FINAL REPLY]\n"""${safeReply}"""\n\n` +
    `Decide whether to write to memory. JSON only.`;

  const decision = await classifyWithLLM<WriteDecision>({
    category: "end-of-turn-write",
    systemPrompt: WRITE_DECISION_PROMPT,
    userPrompt: userBlock,
    parse: parseWriteDecision,
    timeoutMs: TIMEOUT_MS,
    maxResponseChars: 1500,
    envDisableVar: "LAX_MEMORY_END_OF_TURN",
  });
  if (!decision || !decision.write) return;

  // Execute the write server-side via the same memory_update_profile path
  // the model would have used. Don't go through the tool registry — call
  // the underlying MemoryIndex directly to avoid nested tool dispatch.
  try {
    await applyWrite(decision, ctx.memory);
    logger.info(
      `[end-of-turn] wrote to USER.md ` +
      `(action=${decision.action}, section=${decision.section_heading || "—"}, ` +
      `${decision.content.length}ch) sess=${ctx.sessionId}`,
    );
  } catch (e) {
    logger.warn(`[end-of-turn] write failed: ${(e as Error).message}`);
  }
}

// ── Decision parsing + apply ──

interface WriteDecision {
  write: true;
  action: "append" | "replace_section";
  section_heading: string | null;
  content: string;
}

export function parseWriteDecision(raw: string): WriteDecision | null {
  if (!raw) return null;
  let cleaned = raw.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.write !== true) return null;
  // Legacy classifiers may still emit `file: "user"` or `file: "mind"`. Accept
  // "user" or absent (default), reject anything else — "mind" is retired.
  if (obj.file !== undefined && obj.file !== "user") return null;
  const action = obj.action === "append" || obj.action === "replace_section" ? obj.action : null;
  const content = typeof obj.content === "string" ? obj.content.trim() : "";
  if (!action || !content) return null;
  if (content.length > 800) return null; // sanity cap — single write should never be huge
  const section_heading = typeof obj.section_heading === "string" && obj.section_heading.trim()
    ? obj.section_heading.trim()
    : null;
  if (action === "replace_section" && !section_heading) return null;
  return { write: true, action, section_heading, content };
}

async function applyWrite(d: WriteDecision, memory: MemoryIndex): Promise<void> {
  // Mirrors memory_update_profile's write path with the same char caps.
  // End-of-turn only writes USER.md — facts go through the agent's `remember`
  // tool during the turn, not this classifier.
  const filename = PERSONALITY_FILES.user;
  const filePath = join(memory.getMemoryDir(), filename);
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";

  let updated: string;
  if (d.action === "append") {
    updated = existing + (existing.endsWith("\n") ? "" : "\n") + "\n" + d.content + "\n";
  } else {
    // replace_section
    const heading = d.section_heading!;
    const headingPattern = new RegExp(
      `(^|\\n)(##?\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]*)([\\s\\S]*?)(?=\\n##?\\s|$)`,
      "i",
    );
    const match = existing.match(headingPattern);
    if (match) {
      updated = existing.replace(headingPattern, `$1$2\n${d.content}\n`);
    } else {
      // Section doesn't exist yet — append as new section
      updated = existing + (existing.endsWith("\n") ? "" : "\n") + `\n## ${heading}\n${d.content}\n`;
    }
  }

  // Profile-file safety net: collapse duplicate top-level blocks before
  // persisting. Mirrors the funnel in memory_update_profile so both write
  // paths land on the same canonical shape.
  if (filename === "USER.md" || filename === "IDENTITY.md" || filename === "HEART.md") {
    updated = dedupeProfileMarkdown(updated);
  }

  // Char-limit check — same caps as memory_update_profile tool.
  const LIMITS: Record<string, number> = { "USER.md": 2000 };
  const limit = LIMITS[filename];
  if (limit !== undefined && updated.length > limit) {
    logger.warn(`[end-of-turn] skipped write — ${filename} would be ${updated.length}/${limit}`);
    return;
  }

  try {
    writeMemorySafely({
      content: updated,
      source: "eot",
      target: filePath,
      mode: "overwrite",
    });
  } catch (e) {
    if (e instanceof MemoryWriteBlocked) {
      logger.warn(`[end-of-turn] write blocked by taint gate: ${e.reason}`);
      return;
    }
    throw e;
  }
}

/** @internal — exported for tests */
export const _internals = { WRITE_DECISION_PROMPT, parseWriteDecision };
