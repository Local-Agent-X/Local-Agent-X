/**
 * Epistemic grounding guard for operational claims. A model may use memory as
 * a search lead, but it may not turn stale memory or prior assistant prose into
 * a definitive explanation of runtime/security/policy state.
 *
 * Gate → confirm → fail-open (same shape as instruction-ledger/extract.ts):
 * the regex guard is a cheap PREFILTER — negation- and paraphrase-blind by
 * construction ("the firewall did NOT block it" trips it). Because this
 * middleware's nudge reason is retract-grade (OPERATIONAL_CLAIM_REASON marks
 * the streamed answer for retraction), a regex hit alone is not allowed to
 * pull the trigger: an LLM confirm gets the flagged sentence and vetoes false
 * positives. LLM says NO → suppress entirely. YES / null / timeout / disabled
 * (LAX_LLM_OPERATIONAL_CLAIM=0) → fire exactly as before — the deterministic
 * regex verdict is the floor, so a downed classifier costs nothing.
 */
import { checkUnsupportedOperationalClaim, OPERATIONAL_CLAIM_REASON, findDefinitiveOperationalClaimSentence } from "../../agent-guards/index.js";
import { classifyYesNo } from "../../classifiers/classify-with-llm.js";
import { getMiddlewareState } from "./state.js";
import type { CanonicalMiddleware } from "./types.js";

interface FiredFlag { fired: boolean }

const CONFIRM_SYSTEM_PROMPT = `A regex prefilter flagged ONE sentence in an AI assistant's reply as a possible unhedged operational claim. You decide whether the flag is real before the reply is retracted.

A sentence deserves YES only when it is a DEFINITIVE claim about live system state or causality — it asserts as observed fact what a running system/service/policy did, why it did it, or its current status — WITHOUT hedging.

Reply NO when the flag is a false positive:
- The sentence is hedged or framed as a possibility, hypothesis, or inference.
- It is a question, a plan, a hypothetical, or a conditional.
- It quotes or reports the user's words, documentation, code comments, or tool output rather than asserting the assistant's own observation.
- It describes what code/config WOULD do by its logic, not what a live system was observed doing.
- It negates or corrects a premise in passing (e.g. noting something did NOT happen while the surrounding reply stays uncertain) rather than asserting definitive runtime fact.

Judge the sentence in the context of the full reply. Reply with EXACTLY one line, starting with YES or NO followed by a brief reason.
YES = genuine definitive unhedged operational claim, proceed.
NO = false positive, suppress.`;

type ConfirmOperationalClaimFn = (
  flaggedSentence: string,
  fullReply: string,
) => Promise<boolean | null>;

async function llmConfirm(flaggedSentence: string, fullReply: string): Promise<boolean | null> {
  return classifyYesNo({
    category: "operational-claim-confirm",
    systemPrompt: CONFIRM_SYSTEM_PROMPT,
    userPrompt:
      `Flagged sentence:\n"${flaggedSentence.slice(0, 600)}"\n\n` +
      `Full reply (context):\n"${fullReply.slice(0, 2500)}"\n\n` +
      `Is the flagged sentence a definitive claim about live system state/causality, asserted WITHOUT hedging? Reply YES or NO + one-line reason.`,
    timeoutMs: 4000,
    envDisableVar: "LAX_LLM_OPERATIONAL_CLAIM",
  });
}

/**
 * Factory with an injectable confirm so tests can pin the gate without a live
 * provider. The registry uses the default instance below.
 */
export function createOperationalClaimMiddleware(
  confirm: ConfirmOperationalClaimFn = llmConfirm,
): CanonicalMiddleware {
  return {
    name: "operational-claim",

    async afterModelCall(ctx) {
      // A mixed reasoning+tool turn is not the final answer yet. Let the
      // requested inspection run; the next model turn is checked against the
      // successful op-level evidence set. Blocking here would prevent the model
      // from gathering the very evidence this guard requires.
      if (ctx.toolCalls.length > 0) return { kind: "continue" };

      const flag = getMiddlewareState<FiredFlag>(
        ctx.op.id,
        "operational-claim",
        () => ({ fired: false }),
      );
      if (flag.fired) return { kind: "continue" };

      const nudge = checkUnsupportedOperationalClaim(
        ctx.assistantContent,
        ctx.toolsCalledThisOp,
      );
      if (!nudge) return { kind: "continue" };

      // Retract-grade consequence — require the LLM's second opinion on the
      // flagged sentence. Only an explicit NO suppresses; anything short of a
      // verdict falls back to the deterministic regex fire.
      const sentence =
        findDefinitiveOperationalClaimSentence(ctx.assistantContent) ?? ctx.assistantContent;
      let confirmed: boolean | null = null;
      try {
        confirmed = await confirm(sentence, ctx.assistantContent);
      } catch {
        confirmed = null; // fail open — treated exactly like an LLM timeout
      }
      if (confirmed === false) return { kind: "continue" };

      flag.fired = true;
      return { kind: "nudge", message: nudge, reason: OPERATIONAL_CLAIM_REASON };
    },
  };
}

export const operationalClaimMiddleware: CanonicalMiddleware = createOperationalClaimMiddleware();
