/**
 * Is a new email to someone saying the same thing as the one already sent to
 * them, or something new?
 *
 * Asked only by the repeat check before a send (src/tools/email-repeat-check.ts),
 * and only once code has found an email to the same person in the last two
 * days that they have not answered: back-and-forth never reaches here. "Same"
 * covers a reworded version of the same message, which is how a retried
 * request goes out twice (a voice chat restarted and asked again,
 * 2026-11-15); a follow-up, a correction or added information is "new".
 */
import { z, type ZodType, type ZodTypeDef } from "zod";
import { classifySchema } from "./schema-output.js";

const SYSTEM_PROMPT = `You compare two emails from the same sender to the same recipient: one ALREADY SENT, and a NEW draft about to be sent. The recipient has not replied in between.

Answer "same" when the new draft is the same message again: the same purpose and substance, even if reworded, reordered, shortened or lengthened. Sending it would make the recipient get the same email twice.

Answer "new" when the draft adds something the first did not: a follow-up or reminder the sender chose to send, a correction, an attachment or detail that was missing, an answer to a different question, a different topic.

"why" is one short sentence a person reads to decide.`;

export interface SameEmailVerdict {
  verdict: "same" | "new";
  why: string;
}

const SHAPE_HINT = `{"verdict":"same","why":"Both reply to the job offer accepting the Thursday interview."}`;

function verdictSchema(): ZodType<SameEmailVerdict, ZodTypeDef, unknown> {
  return z
    .custom<{ verdict?: unknown; why?: unknown }>((v) => typeof v === "object" && v !== null, { message: "reply must be a JSON object" })
    .refine((v) => v.verdict === "same" || v.verdict === "new", { message: "verdict must be same or new" })
    .transform((v): SameEmailVerdict => ({
      verdict: v.verdict as "same" | "new",
      why: typeof v.why === "string" ? v.why.trim().slice(0, 240) : "",
    }));
}

export interface EmailForComparison { subject: string; text: string }

/** Null when no model could answer (disabled, timed out, unusable reply). */
export async function sameEmailAgain(
  sent: EmailForComparison,
  draft: EmailForComparison,
  opts?: { timeoutMs?: number; _llm?: (systemPrompt: string, userPrompt: string) => Promise<string | null> },
): Promise<SameEmailVerdict | null> {
  const clip = (s: string) => s.trim().slice(0, 2000);
  return classifySchema<SameEmailVerdict>({
    category: "same-email-again",
    role: "routing",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `ALREADY SENT\nSubject: ${sent.subject}\n${clip(sent.text)}\n\nNEW DRAFT\nSubject: ${draft.subject}\n${clip(draft.text)}\n\nReply with the JSON object only.`,
    schema: verdictSchema(),
    shapeHint: SHAPE_HINT,
    timeoutMs: opts?.timeoutMs ?? 8000,
    envDisableVar: "LAX_LLM_SAME_EMAIL",
    _llm: opts?._llm,
  });
}
