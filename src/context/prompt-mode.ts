/**
 * Which parts of the base prompt (config/system-prompt.md, one part per `## `
 * heading) each chat mode carries (session/mode.ts).
 *
 * A code session works in one project folder. Measured on recorded local
 * turns (2026-10-23), the full prompt was ~25k tokens before the conversation
 * started, mostly parts a coding task never reads: steering the app itself,
 * the browser, in-app pages, memory recall, personality, self-modification.
 * Code mode leaves those out and replaces the general "How to work" with the
 * coding one ("Code mode — how to work"), which chat mode never carries.
 * Nothing becomes unreachable: the tools behind the dropped parts stay
 * loadable through tool_search, and every behavioural rule must keep a
 * delivered channel in code mode (rule-coverage.test.ts has a code profile).
 *
 * Keyed by the part's slug (config-loader.ts classifySystemPromptPart).
 */
import type { ChatMode } from "../session/mode.js";
import { basePartSlug, basePromptSections } from "../config-loader.js";

/** The coding "How to work": in code mode only. */
export const CODE_MODE_PART = "code-mode";

/** Parts a code session leaves out. */
const LEFT_OUT_OF_CODE_MODE: ReadonlySet<string> = new Set([
  "how-to-control-your-own-app",
  "how-to-work",
  "browser",
  "apps-pages",
  "memory",
  "personality",
  "self-modification",
  "self-repair-and-self-extension",
]);

/** Does a session in `mode` carry the base-prompt part with this slug? */
export function promptPartInMode(slug: string, mode: ChatMode): boolean {
  if (mode === "code") return !LEFT_OUT_OF_CODE_MODE.has(slug);
  return slug !== CODE_MODE_PART;
}

/** The base-prompt text a session in `mode` carries, parts in file order. */
export function basePromptForMode(prompt: string, mode: ChatMode): string {
  return basePromptSections(prompt)
    .filter((part) => promptPartInMode(basePartSlug(part.id), mode))
    .map((part) => part.build() as string)
    .join("");
}
