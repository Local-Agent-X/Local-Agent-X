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
import type { PromptPriority } from "./system-prompt-builder.js";

/** The coding "How to work": in code mode only. */
export const CODE_MODE_PART = "code-mode";

/**
 * Parts a code session leaves out, each with the line that stays in their
 * place (the "One step away" part below). A shorter prompt must not make a
 * capability unknown: a code session asked to "put the app in light mode"
 * carried no word of the app it runs inside, read "the app" as its project
 * (already light), and spent a minute in the browser instead of one `setting`
 * call (2026-11-22). `null` is a part another one replaces: the coding "How
 * to work"; `delegation` (~1.75k tokens), whose short form is a paragraph in
 * "Code mode — how to work" (measured against Hermes on the same model,
 * 2026-10-24); `personality`, which is tone, not a capability.
 */
const LEFT_OUT_OF_CODE_MODE: Readonly<Record<string, string | null>> = {
  "how-to-control-your-own-app":
    "**Local Agent X itself.** You run inside it. Its theme, model, provider and other settings change with one `setting` call " +
    "(`setting({field: \"?\", value: \"\"})` lists the fields). When \"the app\" could mean this project or Local Agent X and the " +
    "project already does what is asked, it means Local Agent X; when it is still unclear, ask which.",
  "how-to-work": null,
  "browser": "**The web.** `browser` opens, reads and clicks through pages; `web_search` and `web_fetch` look things up.",
  "apps-pages": "**Pages and apps in Local Agent X.** `app_design_brief`, `build_app` and `start_app_build` make a page or app the user opens inside the app.",
  "memory": "**What you know about the user.** `memory_search` recalls their preferences and past work; `memory_save` keeps a new one.",
  "personality": null,
  "self-modification": "**Your own behavior** (`config/`). Only `self_edit` changes it, in developer mode; otherwise tell the user the change you would make.",
  "self-repair-and-self-extension":
    "**Extending what you can do.** `connector_create` connects an outside API, `self_edit` changes Local Agent X's own source (developer mode).",
  "delegation": null,
};

/** The part a code session carries in place of the ones it leaves out. */
export const ONE_STEP_AWAY_PART = "one-step-away";

/** What a code session can still do beyond its loaded tools, one `tool_search` away. */
export function oneStepAwayText(): string {
  const lines = Object.values(LEFT_OUT_OF_CODE_MODE).filter((line): line is string => line !== null);
  return (
    "## One step away\n" +
    "A code session loads the coding tools only. Everything Local Agent X can do in a chat is still yours here: " +
    "load the tool with `tool_search` (by name or by what you need) and use it. A request that is not about this " +
    "project is still yours to do; never work around a tool you have not loaded.\n" +
    lines.map((line) => `- ${line}`).join("\n") +
    "\n\n"
  );
}

/**
 * In a code session the coding rules are the job, so they are the last parts a
 * small window gives up. Their own classes put them first: "Coding discipline"
 * is `tuning` (shed before anything else) and the coding "How to work" is
 * `navigation`, so a constrained local window dropped the coding rules and
 * kept recalled personal facts. As `facts` with no rank in the shed order
 * (prompt-degradation.ts) they go after every recalled block.
 */
const SHED_LAST_IN_CODE_MODE: ReadonlySet<string> = new Set([CODE_MODE_PART, "coding-discipline"]);

/** The budget class a session in `mode` sheds this part under. */
export function promptPriorityInMode(slug: string, mode: ChatMode, own: PromptPriority | undefined): PromptPriority | undefined {
  return mode === "code" && SHED_LAST_IN_CODE_MODE.has(slug) ? "facts" : own;
}

/** Does a session in `mode` carry the base-prompt part with this slug? */
export function promptPartInMode(slug: string, mode: ChatMode): boolean {
  if (mode === "code") return !Object.hasOwn(LEFT_OUT_OF_CODE_MODE, slug);
  return slug !== CODE_MODE_PART;
}

/** The base-prompt text a session in `mode` carries, parts in file order, then
 *  a code session's "One step away". */
export function basePromptForMode(prompt: string, mode: ChatMode): string {
  const parts = basePromptSections(prompt)
    .filter((part) => promptPartInMode(basePartSlug(part.id), mode))
    .map((part) => part.build() as string)
    .join("");
  return mode === "code" ? parts + oneStepAwayText() : parts;
}
