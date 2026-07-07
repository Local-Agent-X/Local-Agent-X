/**
 * Cleanup-verify middleware — the task is a removal/cleanup sweep and the model
 * is wrapping up by reporting it DONE, but no grep this op came back empty to
 * prove the target is actually gone. Accumulate clean-search evidence after each
 * dispatch; at wrap-up (model ends tool-lessly with text, the same signal
 * premature-completion keys on) nudge once to re-search, and set the verdict the
 * terminal-outcome label reads so an unconfirmed cleanup records `partial`,
 * never a rounded-up `clean`.
 *
 * The sibling of verify-gate (build verification) for SEARCH verification — a
 * removal is proven by an empty search, not a passing build. All lanes: a
 * "finish cleaning up X" instruction is most often interactive chat, so unlike
 * verify-gate this is NOT worker-only.
 *
 * Detection logic lives in src/agent-guards/cleanup-verify.ts; this is the thin
 * canonical wiring.
 *
 * Gate → confirm → fail-open (same shape as operational-claim): claimsCleanupDone
 * is a cheap regex PREFILTER — COMPLETION_CLAIM + NEGATION, so it is
 * paraphrase-blind by construction ("we got everything that mattered" reads as
 * done to a human but slips the regex the other way, and a phrasing the regex
 * DOES flag may not actually be a done-claim). Because the false-done branch is
 * retract-grade (CLEANUP_VERIFY_FALSE_DONE_REASON marks the streamed answer for
 * retraction), a regex hit alone is not allowed to pull that trigger: an LLM
 * confirm judges whether the wrap-up text actually CLAIMS the cleanup is
 * complete. NO → downgrade to the plain (non-retract) reason. YES / null /
 * timeout / disabled (LAX_LLM_CLEANUP_VERIFY=0) → retract exactly as before —
 * the deterministic regex verdict is the floor, so a downed classifier costs
 * nothing. The grep-evidence grounding is untouched: the LLM only judges the
 * DONE-CLAIM text, never whether the cleanup actually happened.
 */
import { type CanonicalLoopContext, type CanonicalMiddleware } from "./types.js";
import { getMiddlewareState } from "./state.js";
import {
  looksLikeCleanupSweep,
  noteCleanupEvidence,
  checkCleanupVerify,
  claimsCleanupDone,
  createCleanupVerifyState,
  CLEANUP_VERIFY_REASON,
  CLEANUP_VERIFY_FALSE_DONE_REASON,
  type CleanupToolResult,
  type CleanupVerifyState,
} from "../../agent-guards/index.js";
import { classifyYesNo } from "../../classifiers/classify-with-llm.js";
import { capabilityForbiddenForOp } from "../instruction-ledger/index.js";

/** Pair this turn's tool results with their calls (by id) so a grep result
 *  carries the pattern it searched — the gate tracks cleanliness per pattern. */
function buildCleanupEvidence(ctx: CanonicalLoopContext): CleanupToolResult[] {
  const patternById = new Map<string, string>();
  const commandById = new Map<string, string>();
  for (const tc of ctx.toolCalls) {
    const args = (tc.args ?? {}) as Record<string, unknown>;
    if (typeof args.pattern === "string") patternById.set(tc.toolCallId, args.pattern);
    if (typeof args.command === "string") commandById.set(tc.toolCallId, args.command);
  }
  return ctx.toolResults.map(tr => ({
    toolName: tr.toolName,
    content: tr.content,
    status: tr.status,
    pattern: patternById.get(tr.toolCallId),
    command: commandById.get(tr.toolCallId),
  }));
}

/**
 * The latest verdict this gate computed for the op, persisted so the
 * terminal-outcome label (decide-outcome.ts) can read it. A cleanup op that
 * ends without a confirming search records `partial`, not a rounded-up `clean`.
 * Defaults false — ops the gate never evaluated keep their prior labeling.
 */
export function opCleanupUnverified(opId: string): boolean {
  return getMiddlewareState<CleanupVerifyState>(
    opId, "cleanup-verify", createCleanupVerifyState,
  ).unverified;
}

const CONFIRM_SYSTEM_PROMPT = `A regex prefilter flagged an AI assistant's wrap-up message as possibly claiming a code-cleanup/removal task is COMPLETE. You decide whether that flag is real before the message is retracted.

Reply YES only when the wrap-up positively asserts, as a finished fact, that the removal/cleanup is DONE — the target is gone, all references removed, nothing remains. Paraphrases count: "we got everything that mattered", "that's cleared out now", "the codebase is free of it" are all done-claims even though they dodge the words "complete/finished".

Reply NO when the flag is a false positive:
- The wrap-up admits the work is NOT finished, is partial, or that references still remain.
- It is hedged, conditional, or asks the user how to proceed.
- The word that tripped the regex (e.g. "done", "complete") refers to something OTHER than the cleanup being finished (a sub-step, a build, a plan).
- It reports remaining hits and explains why they are intentionally kept, rather than claiming a clean sweep.

You are NOT judging whether the cleanup actually happened — only whether the TEXT claims it is complete. Reply with EXACTLY one line, starting with YES or NO followed by a brief reason.
YES = the text genuinely claims the cleanup is done, retract is warranted.
NO = false positive, do not retract.`;

type ConfirmCleanupDoneFn = (wrapUpText: string) => Promise<boolean | null>;

async function llmConfirm(wrapUpText: string): Promise<boolean | null> {
  return classifyYesNo({
    category: "cleanup-verify-confirm",
    systemPrompt: CONFIRM_SYSTEM_PROMPT,
    userPrompt:
      `Wrap-up message:\n"${wrapUpText.slice(0, 2500)}"\n\n` +
      `Does this message claim the cleanup/removal task is COMPLETE/DONE? Reply YES or NO + one-line reason.`,
    timeoutMs: 4000,
    envDisableVar: "LAX_LLM_CLEANUP_VERIFY",
  });
}

/**
 * Factory with an injectable confirm so tests can pin the gate without a live
 * provider. The registry uses the default instance below.
 */
export function createCleanupVerifyMiddleware(
  confirm: ConfirmCleanupDoneFn = llmConfirm,
): CanonicalMiddleware {
  return {
    name: "cleanup-verify",

    afterToolExecution(ctx) {
      if (!looksLikeCleanupSweep(ctx.userMessage)) return { kind: "continue" };
      const state = getMiddlewareState<CleanupVerifyState>(
        ctx.op.id, "cleanup-verify", createCleanupVerifyState,
      );
      noteCleanupEvidence(buildCleanupEvidence(ctx), state);
      return { kind: "continue" };
    },

    async afterModelCall(ctx) {
      // Only at wrap-up: model ended the turn with text and no tool calls.
      if (ctx.toolCalls.length > 0) return { kind: "continue" };
      if (ctx.assistantContent.trim().length === 0) return { kind: "continue" };
      if (!looksLikeCleanupSweep(ctx.userMessage)) return { kind: "continue" };

      const state = getMiddlewareState<CleanupVerifyState>(
        ctx.op.id, "cleanup-verify", createCleanupVerifyState,
      );
      // Compute the verdict FIRST. checkCleanupVerify sets state.unverified, which
      // the terminal-outcome label reads (opCleanupUnverified in terminal-epilogue).
      // Doing this BEFORE the ledger gate below keeps the label honest even when we
      // suppress the nudge: a read-only cleanup that claims done without a
      // confirming search still records `partial`, never a rounded-up `clean`.
      const r = checkCleanupVerify(state);
      if (!r.nudge) return { kind: "continue" };

      // When the wrap-up positively claims the cleanup is finished but no search
      // confirmed it, that bubble is a confirmed-false claim the next turn
      // supersedes — flag it for retraction (decide-outcome strips it) so the user
      // never reads a "Cleanup complete" that the loop is about to walk back. An
      // honest "not done / still remain" wrap-up keeps the plain reason and stands.
      //
      // The regex prefilter is paraphrase-blind and this branch is retract-grade,
      // so a claimsCleanupDone hit alone is not allowed to retract: an LLM confirm
      // judges the wrap-up text. Only an explicit NO downgrades to the plain
      // (non-retract) reason; YES / null / timeout / disabled retract exactly as
      // before. The grep-evidence verdict above is untouched either way — the LLM
      // never judges whether the cleanup happened, only whether the text claims it.
      let reason = CLEANUP_VERIFY_REASON;
      if (claimsCleanupDone(ctx.assistantContent)) {
        let confirmed: boolean | null = null;
        try {
          confirmed = await confirm(ctx.assistantContent);
        } catch {
          confirmed = null; // fail open — treated exactly like an LLM timeout
        }
        if (confirmed !== false) reason = CLEANUP_VERIFY_FALSE_DONE_REASON;
      }

      // Ledger gate (same as the six persistence guards): the "finish the hits,
      // then re-grep" nudge pushes exactly the edits a workspace-write ban forbids,
      // so suppress the NUDGE — but the honest verdict above already stands, so the
      // outcome label is unaffected by the suppression.
      if (capabilityForbiddenForOp(ctx.op, "workspace-write")) return { kind: "continue" };

      return { kind: "nudge", message: r.nudge, reason };
    },
  };
}

export const cleanupVerifyMiddleware: CanonicalMiddleware = createCleanupVerifyMiddleware();
