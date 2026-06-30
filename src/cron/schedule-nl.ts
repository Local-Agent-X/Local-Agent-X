/**
 * Natural-language → schedule translation for the New Mission form.
 *
 * The form lets a user type a schedule in plain words ("every weekday at 9am",
 * "the 1st of each month at noon"). This turns that into a concrete schedule the
 * cron service understands — either a fixed interval ("5m", "2h") or a 5-field
 * cron expression ("0 9 * * 1-5").
 *
 * Two guardrails make the LLM safe to trust for a scheduling primitive:
 *   1. SHORT-CIRCUIT — if the text is already a valid interval/cron, return it
 *      verbatim. No model call, no cost, no chance of a mis-read.
 *   2. VALIDATION GATE — the model's `schedule` is only accepted if the REAL
 *      cron parser (getIntervalMs / msUntilNextRun) can parse it. A hallucinated
 *      or malformed expression is rejected (returns null), so the model can
 *      never silently schedule garbage. The caller falls back to an error.
 *
 * Timezone is handled SEPARATELY by the job's `tz` field — the model produces a
 * wall-clock cron and must NOT shift times across zones (told so in the prompt).
 *
 * Rides the canonical classifier path (classifyJson → provider background
 * model, hard wallclock race, graceful null on any failure). Disabled via
 * LAX_SCHEDULE_NL=0.
 */

import { classifyJson } from "../classifiers/classify-with-llm.js";
import { isValidSchedule } from "./cron-parser.js";

export interface ParsedSchedule {
  /** A cron-service-parseable schedule: interval ("5m") or 5-field cron. */
  schedule: string;
  /** Human-readable restatement, e.g. "Every weekday at 9:00 AM". */
  description: string;
}

/** True if the cron service can already run `s` as-is (interval or valid cron). */
export function isParseableSchedule(s: string): boolean {
  return isValidSchedule((s || "").trim());
}

const SYSTEM_PROMPT = `You convert a natural-language recurring-schedule phrase into a concrete schedule for a cron service.

Output ONE of these forms in the "schedule" field:
- A fixed interval: a number followed by s/m/h/d. Examples: "30s", "5m", "2h", "1d". Use this ONLY for "every N minutes/hours/seconds/days" with no specific clock time.
- A standard 5-field cron expression: "minute hour day-of-month month day-of-week". Fields support *, */N, N-M ranges, and N,M lists. Day-of-week is 0-6 with Sunday=0. Use this for any specific clock time or calendar rule.

Rules:
- Produce the cron in the user's LOCAL WALL-CLOCK time. Do NOT convert between timezones — the system stores the timezone separately.
- 24-hour internally: "9am" -> hour 9, "9pm" -> hour 21, "noon" -> 12, "midnight" -> 0.
- "weekday/weekdays" = Mon-Fri = day-of-week 1-5. "weekend" = 0,6.
- If no minute is specified for an hourly clock time, use minute 0.
- If the phrase is too vague to schedule (e.g. "sometimes", "often"), return an empty schedule "".

Examples:
"every weekday at 9am" -> {"schedule":"0 9 * * 1-5","description":"Every weekday at 9:00 AM"}
"daily 9am" -> {"schedule":"0 9 * * *","description":"Every day at 9:00 AM"}
"every monday and thursday at 6:30pm" -> {"schedule":"30 18 * * 1,4","description":"Every Monday and Thursday at 6:30 PM"}
"every 2 hours" -> {"schedule":"2h","description":"Every 2 hours"}
"every 15 minutes" -> {"schedule":"15m","description":"Every 15 minutes"}
"the 1st of every month at noon" -> {"schedule":"0 12 1 * *","description":"On the 1st of each month at 12:00 PM"}
"twice a day, 8am and 8pm" -> {"schedule":"0 8,20 * * *","description":"Every day at 8:00 AM and 8:00 PM"}

Reply with JSON only, no prose, no markdown fences:
{"schedule":"<interval-or-cron>","description":"<plain English>"}`;

interface RawParse {
  schedule?: unknown;
  description?: unknown;
}

/**
 * Translate a free-text schedule phrase into a concrete schedule. Returns the
 * parsed schedule, or null if the text is too vague, the model failed, or the
 * result didn't pass the deterministic parser. `tz` is passed only as context
 * (the model must not shift clock times); `nowISO` anchors relative phrasing.
 */
export async function parseScheduleNL(
  text: string,
  opts?: { tz?: string; nowISO?: string; signal?: AbortSignal },
): Promise<ParsedSchedule | null> {
  const trimmed = (text || "").trim();
  if (!trimmed) return null;

  // 1. Short-circuit: already a valid schedule → no model call needed.
  if (isParseableSchedule(trimmed)) {
    return { schedule: trimmed, description: trimmed };
  }

  // 2. Ask the background model, then gate the answer on the real parser.
  return classifyJson<ParsedSchedule>({
    category: "schedule-nl",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: [
      opts?.nowISO ? `Current local time (for relative phrasing): ${opts.nowISO}` : "",
      opts?.tz ? `Timezone (context only — do not shift clock times): ${opts.tz}` : "",
      `Phrase: ${trimmed}`,
    ].filter(Boolean).join("\n"),
    envDisableVar: "LAX_SCHEDULE_NL",
    signal: opts?.signal,
    validate: (parsed: unknown): ParsedSchedule | null => {
      if (!parsed || typeof parsed !== "object") return null;
      const obj = parsed as RawParse;
      if (typeof obj.schedule !== "string") return null;
      const schedule = obj.schedule.trim();
      // The validation gate: only accept what the cron service can actually run.
      if (!schedule || !isParseableSchedule(schedule)) return null;
      const description = typeof obj.description === "string" && obj.description.trim()
        ? obj.description.trim().slice(0, 200)
        : schedule;
      return { schedule, description };
    },
  });
}
