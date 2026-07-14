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
import { z } from "zod";
import { createLogger } from "../logger.js";
import { redactKnownSecrets } from "../sanitize.js";
import { resetSession as resetCurateNudge } from "./curate-nudge.js";
import { classifySchema } from "../classifiers/schema-output.js";
import { resolveProviderContext } from "../providers/resolve-provider-context.js";
import { PERSONALITY_FILES } from "./personality.js";
import { dedupeProfileMarkdownConfirmed } from "./personality-confirmed.js";
import { writeMemorySafely, MemoryWriteBlocked, MAX_PROFILE_CHARS } from "./write-safely.js";
import type { MemoryIndex } from "./index-core.js";

const logger = createLogger("memory.end-of-turn-write");

const TIMEOUT_MS = 8000; // generous — runs in background, no user blocking

/** Env kill switch — checked here (before the curate signal is consumed) AND
 *  passed to classifyWithLLM as its envDisableVar. Keep the two in sync. */
const ENV_DISABLE_VAR = "LAX_MEMORY_END_OF_TURN";

const SHAPE_HINT = `{"write": false} | {"write": true, "action": "append"|"replace_section", "section_heading": "string or null", "content": "string"}`;

const WRITE_DECISION_PROMPT = `You decide whether the user/agent exchange just finished revealed something durable about the USER (preferences, workflow rules, communication style, identity) that belongs in their narrative profile (USER.md).

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
 * Outcome of one end-of-turn pass, surfaced to the extraction coalescer:
 *   - "completed"   — the pass ran (a decision came back, or it failed after
 *                     the classifier was reachable). The curate signal was
 *                     consumed; the coalescer advances its cursor.
 *   - "unavailable" — the classifier could not run AT ALL (env-disabled, or
 *                     no credentialed provider). The curate signal was NOT
 *                     consumed and the coalescer must NOT advance its cursor,
 *                     so the next curate turn retries once a provider is back.
 */
export type EndOfTurnWriteOutcome = "completed" | "unavailable";

/**
 * Fire-and-forget. Caller does NOT await this for the turn — it runs in the
 * background after the user has already received the assistant's reply.
 *
 * Returns an {@link EndOfTurnWriteOutcome} for the coalescer's cursor/retry
 * bookkeeping. All errors swallowed (logged) — the memory pass failing
 * silently is correct UX; we don't want to surface post-turn errors to the
 * user who already got their answer.
 */
export async function runEndOfTurnMemoryWrite(ctx: EndOfTurnContext): Promise<EndOfTurnWriteOutcome> {
  if (!ctx.sessionId || !ctx.userMessage || !ctx.assistantReply) return "completed";

  // Availability gate BEFORE the curate signal is consumed. The signal
  // (curate-nudge session state) is the trigger for this whole pass; consuming
  // it and then discovering the classifier can't run would permanently destroy
  // the extraction trigger while e.g. settings.json points at a provider with
  // no credential. Unavailable → signal and coalescer cursor survive for retry.
  if (process.env[ENV_DISABLE_VAR] === "0") {
    logger.debug(`[end-of-turn] disabled via ${ENV_DISABLE_VAR}=0 — signal preserved sess=${ctx.sessionId}`);
    return "unavailable";
  }
  const providerCtx = await resolveProviderContext();
  if (!providerCtx) {
    logger.debug(`[end-of-turn] no credentialed provider — signal preserved for retry sess=${ctx.sessionId}`);
    return "unavailable";
  }

  // Reset the curate-nudge per-session counter (consumes the curate signal) —
  // the in-prompt nudge is being phased out in favor of this pass, but
  // resetting keeps the safety net from double-firing during the transition.
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

  const decision = await classifySchema<WriteDecision>({
    category: "end-of-turn-write",
    systemPrompt: WRITE_DECISION_PROMPT,
    userPrompt: userBlock,
    schema: WriteDecisionSchema,
    shapeHint: SHAPE_HINT,
    timeoutMs: TIMEOUT_MS,
    maxResponseChars: 1500,
    envDisableVar: ENV_DISABLE_VAR,
  });
  if (!decision) {
    // Classifier was reachable but returned no decision (timeout, transport
    // error, unparseable reply). The signal was already consumed — this is a
    // transient failure, not unavailability; don't hold the cursor for it.
    logger.debug(`[end-of-turn] classifier returned no decision sess=${ctx.sessionId}`);
    return "completed";
  }
  if (!decision.write) return "completed";

  // Execute the write server-side via the same memory_update_profile path
  // the model would have used. Don't go through the tool registry — call
  // the underlying MemoryIndex directly to avoid nested tool dispatch.
  try {
    const writeResult = await applyWrite(decision, ctx.memory);
    if (writeResult.ok) {
      logger.info(
        `[end-of-turn] wrote to USER.md ` +
        `(action=${decision.action}, section=${decision.section_heading || "—"}, ` +
        `${decision.content.length}ch) sess=${ctx.sessionId}`,
      );
    } else if (writeResult.blocked) {
      logger.warn(
        `[end-of-turn] write BLOCKED by taint gate sess=${ctx.sessionId}: ${writeResult.reason}`,
      );
    } else {
      logger.warn(`[end-of-turn] write skipped sess=${ctx.sessionId}: ${writeResult.reason}`);
    }
  } catch (e) {
    logger.warn(`[end-of-turn] write failed: ${(e as Error).message}`);
  }
  return "completed";
}

export type ApplyWriteResult =
  | { ok: true }
  | { ok: false; blocked: true; reason: string }
  | { ok: false; blocked?: false; reason: string };

// ── Decision parsing + apply ──

export interface WriteDecisionPayload {
  write: true;
  action: "append" | "replace_section";
  section_heading: string | null;
  content: string;
}

/**
 * A parsed decision is either "write this" or an explicit "nothing to write".
 * `{"write": false}` is the classifier's most common (and perfectly valid)
 * verdict — it validates successfully rather than surfacing as null. null
 * means only: the reply was garbage twice (classifySchema's single
 * self-correction retry included).
 */
export type WriteDecision = { write: false } | WriteDecisionPayload;

/**
 * Reply schema. Notes mirrored from the hand-rolled parser this replaced:
 * - Legacy classifiers may still emit `file: "user"` or `file: "mind"`.
 *   Accept "user" or absent (default), reject anything else — "mind" is retired.
 * - content is trimmed, must be non-empty, and capped at 800 chars (a single
 *   write should never be huge).
 * - replace_section requires a section_heading; a blank/whitespace heading
 *   normalizes to null and is rejected for replace_section.
 */
const WriteDecisionSchema = z.union([
  z.object({ write: z.literal(false) }).transform((): WriteDecision => ({ write: false })),
  z
    .object({
      write: z.literal(true),
      file: z.literal("user").optional(),
      action: z.enum(["append", "replace_section"]),
      section_heading: z.unknown().optional(),
      content: z.string(),
    })
    .transform((obj): WriteDecisionPayload => ({
      write: true,
      action: obj.action,
      section_heading: typeof obj.section_heading === "string" && obj.section_heading.trim()
        ? obj.section_heading.trim()
        : null,
      content: obj.content.trim(),
    }))
    .refine((d) => d.content.length > 0 && d.content.length <= 800, {
      message: "content must be 1-800 chars",
    })
    .refine((d) => d.action !== "replace_section" || d.section_heading !== null, {
      message: "replace_section requires a section_heading",
    }),
]);

export async function applyWrite(d: WriteDecisionPayload, memory: MemoryIndex): Promise<ApplyWriteResult> {
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
    updated = await dedupeProfileMarkdownConfirmed(updated);
  }

  // Char-limit pre-check (graceful skip); the write gate enforces the same cap
  // as a hard backstop for writers that bypass this path.
  if (filename === "USER.md" && updated.length > MAX_PROFILE_CHARS) {
    const reason = `${filename} would be ${updated.length}/${MAX_PROFILE_CHARS}`;
    logger.warn(`[end-of-turn] skipped write — ${reason}`);
    return { ok: false, reason };
  }

  try {
    writeMemorySafely({
      content: updated,
      source: "eot",
      target: filePath,
      mode: "overwrite",
      promotion: {
        origin: "assistant",
        source: "end-of-turn-classifier",
        evidenceContent: d.content,
      },
    });
    return { ok: true };
  } catch (e) {
    if (e instanceof MemoryWriteBlocked) {
      return { ok: false, blocked: true, reason: e.reason };
    }
    throw e;
  }
}

/** @internal — exported for tests */
export const _internals = { WRITE_DECISION_PROMPT, WriteDecisionSchema };
