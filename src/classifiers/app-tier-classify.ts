/**
 * LLM second-opinion for the app-tier classifier — ESCALATION ONLY.
 *
 * Pattern: `tools/app-tier.ts` regex decides the tier from high-precision
 * signals (named toolchain/framework/backend engine, real-app phrasing). Those
 * hard signals are trusted as-is. The residue — briefs the regex reads as
 * "quick-html" — is where the silent-faking failure lives: a real app described
 * in words the keyword list doesn't know ("a booking system for my car wash
 * where customers reserve slots") ships as a faked static page.
 *
 * The call site consults this classifier ONLY when the regex verdict is
 * quick-html, and uses the result ONLY to escalate to a stricter (real-build)
 * tier. It never downgrades. That answers the file's original objection to an
 * LLM here ("a timeout could fall back to quick-html = the exact silent
 * faking"): on timeout/outage/unparseable this returns null and the caller
 * keeps the regex verdict — the status quo — so the LLM path can only reduce
 * silent faking, never cause it.
 *
 * Returns the model's tier verdict, or null (LLM unavailable / bad shape).
 */

import { z } from "zod";
import { classifySchema, type ClassifySchemaOptions } from "./schema-output.js";
import type { AppTier, AppTierClarify } from "../tools/app-tier.js";

const TIERS = ["quick-html", "frontend-spa", "full-stack", "compiled-native"] as const;

const SYSTEM_PROMPT = `You triage an app build brief. Reply with EXACTLY one tier from: quick-html, frontend-spa, full-stack, compiled-native — OR a clarify verdict if the brief is materially ambiguous.

Definitions:
- quick-html: a single static HTML page can honestly BE this app — a calculator, a tracker, a landing page, a small tool, a dashboard with local/hardcoded data. No login, no server, no persistence beyond localStorage.
- frontend-spa: a real multi-screen browser app — it needs routing/state across multiple views, user accounts/login, or is explicitly a "web app"/SaaS/PWA — but the backend is unspecified or not required.
- full-stack: the brief needs a real server process — an API the app must serve, a real database with shared/persistent data across users or devices, server-side logic, integrations that cannot run in a browser.
- compiled-native: the brief asks for a program in a compiled non-browser language (Rust, Go, C/C++, Zig, ...) whose real output comes from running a native toolchain.

Bias: reply quick-html unless the brief CLEARLY requires more. A brief that merely sounds ambitious but a single page can honestly satisfy is quick-html. Escalate only when a static page would have to FAKE something the user asked for (fake login, fake saved data shared between users, fake multi-page navigation, fake native program output).

Clarify — only for MATERIAL ambiguity: the target might not even be software ("a mega computer", "a business", "a house"), OR the plausible builds diverge so much that guessing wrong wastes a real build. Then do NOT pick a tier; reply with kind "clarify", one short question, and 2-3 concrete options for the user to pick from.
Do NOT clarify a brief that is merely vague but unmistakably a real app or site — "a website for a peptide company" is a real site, pick its tier. Reserve clarify for genuine forks.

Reply: kind "tier" with the single tier + brief reason, OR kind "clarify" with the question and options.`;

// Discriminated union so the root stays an OBJECT (never a bare/nullable
// value): a tier verdict rides in {"kind":"tier",...}, a clarify question in
// {"kind":"clarify",...}. The clarify branch encodes the old parser's
// validity rule — a question plus at least 2 options, else the reply is
// invalid and the caller falls open to building rather than surfacing a
// broken question.
const TierReplySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("tier"),
    tier: z.enum(TIERS),
    reason: z.string().optional(),
  }),
  z.object({
    kind: z.literal("clarify"),
    question: z.string().trim().min(1),
    options: z.array(z.string().trim().min(1)).min(2),
  }),
]);

const SHAPE_HINT =
  `{"kind":"tier","tier":"quick-html|frontend-spa|full-stack|compiled-native","reason":"one line"}` +
  ` OR {"kind":"clarify","question":"...","options":["...","..."]}`;

/**
 * Ask the LLM to triage a build brief. Caller policy (build_app): consult only
 * when the regex says quick-html; apply a tier only upward, or surface a clarify
 * verdict. Null = keep the regex verdict (build).
 */
export async function classifyAppTierEscalation(
  args: {
    prompt: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    model?: string;
    _llm?: ClassifySchemaOptions<unknown>["_llm"];
  },
): Promise<AppTier | AppTierClarify | null> {
  const reply = await classifySchema({
    category: "app-tier",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `BUILD BRIEF:\n"${args.prompt.slice(0, 2000)}"\n\nTier verdict, or a clarify verdict if materially ambiguous.`,
    schema: TierReplySchema,
    shapeHint: SHAPE_HINT,
    // Once per build_app invocation, before any scaffolding — latency budget
    // is generous relative to the build itself, but keep the default ceiling
    // so a hung provider never stalls the op start.
    timeoutMs: args.timeoutMs,
    model: args.model,
    envDisableVar: "LAX_LLM_APP_TIER",
    signal: args.signal,
    _llm: args._llm,
  });
  if (!reply) return null;
  if (reply.kind === "tier") return reply.tier;
  // AppTierClarify documents 2-4 options; the schema floors at 2, cap at 4 here.
  return { kind: "clarify", question: reply.question, options: reply.options.slice(0, 4) };
}
