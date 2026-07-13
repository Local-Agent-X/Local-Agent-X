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

import { classifyWithLLM } from "./classify-with-llm.js";
import type { AppTier, AppTierClarify } from "../tools/app-tier.js";

const TIERS: readonly AppTier[] = ["quick-html", "frontend-spa", "full-stack", "compiled-native"];

const SYSTEM_PROMPT = `You triage an app build brief. Reply with EXACTLY one tier token from: QUICK-HTML, FRONTEND-SPA, FULL-STACK, COMPILED-NATIVE — OR a CLARIFY line if the brief is materially ambiguous.

Definitions:
- QUICK-HTML: a single static HTML page can honestly BE this app — a calculator, a tracker, a landing page, a small tool, a dashboard with local/hardcoded data. No login, no server, no persistence beyond localStorage.
- FRONTEND-SPA: a real multi-screen browser app — it needs routing/state across multiple views, user accounts/login, or is explicitly a "web app"/SaaS/PWA — but the backend is unspecified or not required.
- FULL-STACK: the brief needs a real server process — an API the app must serve, a real database with shared/persistent data across users or devices, server-side logic, integrations that cannot run in a browser.
- COMPILED-NATIVE: the brief asks for a program in a compiled non-browser language (Rust, Go, C/C++, Zig, ...) whose real output comes from running a native toolchain.

Bias: reply QUICK-HTML unless the brief CLEARLY requires more. A brief that merely sounds ambitious but a single page can honestly satisfy is QUICK-HTML. Escalate only when a static page would have to FAKE something the user asked for (fake login, fake saved data shared between users, fake multi-page navigation, fake native program output).

CLARIFY — only for MATERIAL ambiguity: the target might not even be software ("a mega computer", "a business", "a house"), OR the plausible builds diverge so much that guessing wrong wastes a real build. Then do NOT pick a tier; reply exactly:
CLARIFY | <one short question> | <option 1> | <option 2> | <option 3 optional>
Do NOT use CLARIFY for a brief that is merely vague but unmistakably a real app or site — "a website for a peptide company" is a real site, pick its tier. Reserve CLARIFY for genuine forks.

Reply: a single tier token + brief reason on one line, OR one CLARIFY line.`;

/**
 * Ask the LLM to triage a build brief. Caller policy (build_app): consult only
 * when the regex says quick-html; apply a tier only upward, or surface a clarify
 * verdict. Null = keep the regex verdict (build).
 */
export async function classifyAppTierEscalation(
  args: { prompt: string; signal?: AbortSignal; timeoutMs?: number; model?: string },
): Promise<AppTier | AppTierClarify | null> {
  return classifyWithLLM<AppTier | AppTierClarify>({
    category: "app-tier",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `BUILD BRIEF:\n"${args.prompt.slice(0, 2000)}"\n\nTier token + reason, or a CLARIFY line if materially ambiguous.`,
    parse: parseTierOrClarify,
    // Once per build_app invocation, before any scaffolding — latency budget
    // is generous relative to the build itself, but keep the default ceiling
    // so a hung provider never stalls the op start.
    timeoutMs: args.timeoutMs,
    model: args.model,
    envDisableVar: "LAX_LLM_APP_TIER",
    signal: args.signal,
  });
}

export function parseTier(raw: string): AppTier | null {
  const head = raw.trim().split(/\r?\n/, 1)[0] ?? "";
  const token = head.trim().toLowerCase().replace(/^[^a-z]*/, "").split(/[\s:,.]+/, 1)[0] ?? "";
  const match = TIERS.find((t) => t === token);
  return match ?? null;
}

/**
 * Parse the escalation reply into a tier token OR a clarify verdict. A CLARIFY
 * line is `CLARIFY | question | opt1 | opt2 [| opt3]`; a malformed one (missing
 * question or < 2 options) returns null so the caller falls open to building
 * rather than surfacing a broken question. Pure + exported for direct testing.
 */
export function parseTierOrClarify(raw: string): AppTier | AppTierClarify | null {
  const head = raw.trim().split(/\r?\n/, 1)[0] ?? "";
  if (/^\s*clarify\b/i.test(head)) {
    const parts = head.split("|").map((s) => s.trim()).filter(Boolean);
    const question = parts[1] ?? "";
    const options = parts.slice(2).filter(Boolean).slice(0, 4);
    if (!question || options.length < 2) return null;
    return { kind: "clarify", question, options };
  }
  return parseTier(raw);
}
