/**
 * classifySchema — schema-validated structured output on top of classifyWithLLM.
 *
 * classifyJson gives back whatever JSON.parse accepts; every call site then
 * hand-rolls its own shape check (or worse, trusts the shape). This wrapper
 * makes the contract explicit: the caller supplies a zod schema + a short
 * example-JSON shape hint, the model is instructed to return ONLY JSON in
 * that shape, and the reply is fence-stripped → JSON.parse'd → schema.safeParse'd.
 *
 * On a parse/validation failure it re-asks EXACTLY once, appending the zod
 * error summary so the model can self-correct. On final failure it returns
 * null — never throws — preserving the repo-wide invariant that LLM
 * classification failure → null → deterministic fallback at every call site.
 *
 * Provider unavailability (classifyWithLLM returning null) is NOT retried:
 * a timeout or missing credential won't get better on a second identical call.
 */

import type { ZodType, ZodTypeDef } from "zod";
import { createLogger } from "../logger.js";
import { classifyWithLLM } from "./classify-with-llm.js";
import { stripCodeFences } from "./strip-code-fences.js";

export interface ClassifySchemaOptions<T> {
  /** Logical name for telemetry / env-disable. e.g. "mission-validate". */
  category: string;
  /** Task-specific system prompt. The JSON-only instruction is appended here. */
  systemPrompt: string;
  /** User-side payload — the content to classify/extract from. */
  userPrompt: string;
  /**
   * Zod schema the parsed reply must satisfy. Input is `unknown` (not `T`)
   * so schemas whose OUTPUT differs from their raw JSON input — i.e. any
   * `.transform(...)` doing snake/camel drift-mapping — are accepted.
   */
  schema: ZodType<T, ZodTypeDef, unknown>;
  /** Short example-JSON string shown to the model, e.g. `{"verdict":"pass","reason":"..."}`. */
  shapeHint: string;
  /** Pass-throughs to classifyWithLLM. */
  timeoutMs?: number;
  model?: string;
  modelTier?: "background" | "active";
  maxResponseChars?: number;
  envDisableVar?: string;
  signal?: AbortSignal;
  /**
   * Test seam: override the LLM call. Receives (systemPrompt, userPrompt),
   * returns the raw model text or null for "unavailable". Defaults to the
   * real classifyWithLLM path.
   */
  _llm?: (systemPrompt: string, userPrompt: string) => Promise<string | null>;
}

type ParseOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

// Cap on the error summary interpolated into the RETRY prompt. The summary is
// derived from model-controlled text (a ~500-char invalid reply can produce a
// 10k+ char zod issue list) — uncapped, it amplifies straight back into the
// next request's token budget.
const MAX_RETRY_ERROR_CHARS = 500;

/** Fence-strip → JSON.parse → schema.safeParse. Never throws. */
function parseAgainstSchema<T>(raw: string, schema: ZodType<T, ZodTypeDef, unknown>): ParseOutcome<T> {
  const cleaned = stripCodeFences(raw);
  let obj: unknown;
  try {
    obj = JSON.parse(cleaned);
  } catch (e) {
    return { ok: false, error: `not valid JSON (${(e as Error).message})` };
  }
  try {
    const result = schema.safeParse(obj);
    if (result.success) return { ok: true, value: result.data };
    const summary = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, error: summary };
  } catch (e) {
    // safeParse itself THROWS when a .transform/.refine inside the schema
    // throws a non-ZodError. Treat that as a validation failure so the reply
    // gets the normal single retry instead of short-circuiting to the outer
    // catch with zero retries.
    return { ok: false, error: `schema validation threw (${(e as Error).message})` };
  }
}

/**
 * Ask the model for JSON matching `schema`, with one self-correction retry.
 * Returns the validated value or null (unavailable / invalid twice). Never throws.
 *
 * Caller contracts:
 * - Do NOT use a root schema that can validate to null/undefined (e.g.
 *   `z.null()` or `.nullable()` at the root) — a SUCCESSFUL null result is
 *   indistinguishable from the failure contract, so the call site would take
 *   its deterministic fallback on a valid reply. Wrap the nullable field in
 *   an object instead.
 * - `timeoutMs` is PER ATTEMPT: with the single retry, worst-case wallclock
 *   is 2× timeoutMs.
 */
export async function classifySchema<T>(opts: ClassifySchemaOptions<T>): Promise<T | null> {
  const logger = createLogger(`classifier.${opts.category}`);
  const systemPrompt =
    `${opts.systemPrompt}\n\n` +
    `Return ONLY JSON matching this shape (no prose, no markdown fences): ${opts.shapeHint}`;
  const llm =
    opts._llm ??
    ((system: string, user: string) =>
      classifyWithLLM<string>({
        category: opts.category,
        systemPrompt: system,
        userPrompt: user,
        timeoutMs: opts.timeoutMs,
        model: opts.model,
        modelTier: opts.modelTier,
        maxResponseChars: opts.maxResponseChars,
        envDisableVar: opts.envDisableVar,
        signal: opts.signal,
        parse: (raw) => raw,
      }));

  try {
    let userPrompt = opts.userPrompt;
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await llm(systemPrompt, userPrompt);
      // null = LLM unavailable (no provider / timeout / empty). A retry with
      // an identical call won't help — bail to the deterministic fallback.
      if (raw === null || raw === undefined) return null;
      const outcome = parseAgainstSchema(raw, opts.schema);
      if (outcome.ok) return outcome.value;
      logger.warn(`attempt ${attempt + 1} invalid: ${outcome.error.slice(0, 300)}`);
      // Model-controlled text — cap before it amplifies into the retry prompt.
      const errorSummary =
        outcome.error.length > MAX_RETRY_ERROR_CHARS
          ? `${outcome.error.slice(0, MAX_RETRY_ERROR_CHARS)}…`
          : outcome.error;
      userPrompt =
        `${opts.userPrompt}\n\n` +
        `Your previous reply was invalid: ${errorSummary}. ` +
        `Return ONLY valid JSON matching: ${opts.shapeHint}`;
    }
    return null;
  } catch (e) {
    // Contract: never throw. An _llm override (or an unexpected internal
    // error) surfacing here still resolves to the null → fallback path.
    logger.warn(`call failed: ${(e as Error).message}`);
    return null;
  }
}
