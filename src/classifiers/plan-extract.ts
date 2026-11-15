/**
 * Plans with a time, pulled out of one chat exchange: "5:00 with Greg works",
 * "book me the dentist Tuesday at 10", "dinner at Mia's Friday 7pm".
 *
 * Runs after a turn (memory/manager.ts persistTurn), on every channel, and
 * only when the exchange mentions a time at all (mentionsTime), so most turns
 * cost nothing. The model resolves "tomorrow at 5" against the moment it is
 * given; a plan counts only when it was agreed or stated as happening, never
 * a proposal still in the air ("how about 5?"), and only with a verbatim span
 * from the exchange that says so. What it returns is recorded and checked for
 * clashes by src/calendar/plans.ts.
 */
import { z, type ZodType, type ZodTypeDef } from "zod";
import { classifySchema } from "./schema-output.js";

const SYSTEM_PROMPT = `You find PLANS WITH A TIME in one exchange between a person and their assistant: things the person will do or attend at a specific time (a meeting, a call, dinner, an appointment, a flight, a deadline they must meet).

Only include a plan that is AGREED or STATED as happening: "5 works, see you then", "I'm meeting Greg at 5", "book it for Tuesday 10am" (once booked), "my dentist is Friday at 9". Do NOT include:
- proposals or questions not yet agreed ("how about 5?", "are you free Friday?"),
- hypotheticals, examples, other people's plans that do not involve the person,
- times in the past, recurring habits ("I run every morning"), vague times ("sometime next week").

Resolve each time against NOW (given below) to an ISO 8601 local date-time without an offset, e.g. "2026-11-14T17:00:00". If no end is said, leave end null.

Each plan needs "evidence": an exact, verbatim substring of the exchange that states it.`;

export interface ExtractedPlan {
  what: string;
  start: string;
  end: string | null;
  where: string | null;
  who: string[] | null;
  evidence: string;
}

const SHAPE_HINT = `{"plans":[{"what":"Dinner with Greg","start":"2026-11-14T17:00:00","end":null,"where":null,"who":["Greg"],"evidence":"5:00 with Greg works"}]}`;

/** Times and dates a plan needs: a clock time, a day word, a weekday, a date. */
const TIME_HINT = /\b(\d{1,2}(:\d{2})?\s?(am|pm|a\.m\.|p\.m\.)|\d{1,2}:\d{2}|noon|midnight|tonight|tomorrow|today|this (morning|afternoon|evening|weekend)|next (week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(tember)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/i;

/** Cheap gate before any model call: does the text mention a time at all? */
export function mentionsTime(text: string): boolean {
  return TIME_HINT.test(text);
}

function plansSchema(exchange: string): ZodType<ExtractedPlan[], ZodTypeDef, unknown> {
  return z
    .custom<{ plans?: unknown }>((v) => typeof v === "object" && v !== null, { message: "reply must be a JSON object" })
    .transform((root): ExtractedPlan[] => {
      const list = Array.isArray(root.plans) ? root.plans : [];
      const out: ExtractedPlan[] = [];
      for (const raw of list.slice(0, 5)) {
        const p = raw as Record<string, unknown>;
        const what = typeof p.what === "string" ? p.what.trim().slice(0, 120) : "";
        const start = typeof p.start === "string" ? p.start.trim() : "";
        const evidence = typeof p.evidence === "string" ? p.evidence : "";
        if (!what || !Number.isFinite(Date.parse(start)) || !evidence || !exchange.includes(evidence)) continue;
        const end = typeof p.end === "string" && Number.isFinite(Date.parse(p.end)) ? p.end : null;
        const where = typeof p.where === "string" && p.where.trim() ? p.where.trim().slice(0, 120) : null;
        const who = Array.isArray(p.who) ? p.who.filter((w): w is string => typeof w === "string" && w.trim().length > 0).slice(0, 8) : null;
        out.push({ what, start, end, where, who: who && who.length > 0 ? who : null, evidence });
      }
      return out;
    });
}

export async function extractPlansWithLLM(
  input: { userMessage: string; assistantResponse?: string; now: Date },
  opts?: { timeoutMs?: number; _llm?: (systemPrompt: string, userPrompt: string) => Promise<string | null> },
): Promise<ExtractedPlan[]> {
  const exchange = [input.userMessage, input.assistantResponse ?? ""].join("\n").trim();
  if (!exchange || exchange.length > 6000 || !mentionsTime(exchange)) return [];
  const now = `${input.now.toString()} (ISO local: ${localIso(input.now)})`;
  const result = await classifySchema<ExtractedPlan[]>({
    category: "plan-extract",
    role: "routing",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `NOW: ${now}\n\nThe person said:\n"${input.userMessage}"\n\nThe assistant replied:\n"${input.assistantResponse ?? ""}"\n\nReply with the JSON object only; {"plans":[]} when there is none.`,
    schema: plansSchema(exchange),
    shapeHint: SHAPE_HINT,
    timeoutMs: opts?.timeoutMs ?? 6000,
    envDisableVar: "LAX_LLM_PLAN_EXTRACT",
    _llm: opts?._llm,
  });
  return result ?? [];
}

/** "2026-11-14T17:05:00" in the machine's local time. */
export function localIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
}
