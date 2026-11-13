/**
 * The `## Memory-Recall Reflex` prompt section: when to search past sessions
 * and memory instead of guessing.
 *
 * Cross-session recall IS auto-injected, but only on task-start turns and only
 * when the message carries 2+ keywords (memory/auto-search-context.ts, wired at
 * memory/manager.ts). This section covers what injection does not reach —
 * mid-session topic pivots, and turns where the injected block came back empty
 * — so the model checks what has actually been built or discussed instead of
 * guessing from URLs and logos. Static, so it caches with the base prompt.
 *
 * A code session does not preload the retained-facts dump or the project
 * catalog (memory/manager.ts omitCoreMemory, system-prompt-builder.ts). What
 * is not preloaded must still be reachable, so here the section also names
 * each of those and the tool that fetches it: the model takes one more step,
 * it never goes without (recall-reflex-section.test.ts).
 */
import type { ChatMode } from "../session/mode.js";
import type { PromptSection } from "./system-prompt-builder.js";

const CATALOG_LINE =
  "- The tool also surfaces apps you previously built (workspace/apps/<name>/) — read their files if you need actual build details. Cross-reference the Project Catalog above to see if the brand matches a built app slug.";
const CATALOG_LINE_CODE =
  "- The tool also surfaces apps you previously built (workspace/apps/<name>/) — read their files if you need actual build details.";

/** What a code session fetches instead of being handed, and with what. */
export const CODE_SESSION_FETCHES = `
This is a code session, so two things a chat is handed up front are fetched on demand here. Load each tool with \`tool_search\`, then call it:
- The user's saved facts and preferences: \`memory_search\`, or \`memory_recall\` by person, kind or date.
- Their other projects and earlier chats: \`search_past_sessions\`.
When a request depends on one of these (a preference, a person, an earlier decision, a project that is not this folder), fetch it before you answer. Never say you have no record of something without searching.`;

export function recallReflexText(mode: ChatMode): string {
  return `## Memory-Recall Reflex
A task-opening turn auto-injects cross-session recall — the RELEVANT MEMORIES block, where entries tagged \`PAST SESSION\` come from earlier conversations. Read that block before reaching for a tool. It is bounded: it fires on the turn that OPENS a task, needs a message with a couple of substantive keywords, and does NOT follow topic pivots later in the session.
Call \`search_past_sessions\` when it doesn't cover the reference — a project, website, person, or topic you don't recognize from THIS conversation:
- The user pivots mid-session to something the opening message never mentioned, or no RELEVANT MEMORIES block arrived / it came back empty and you still don't recognize the reference.
- An image or a domain counts as a reference: the brand you read off it IS the query ("Baddies & Sugar Daddies" → search "baddies sugar daddies"). Search before answering; never describe or guess from the logo or URL alone.
${mode === "code" ? CATALOG_LINE_CODE : CATALOG_LINE}
- A miss is not proof: say you couldn't find it, never that it wasn't said or that you made it up — the user's account outranks a miss. If the user disputes something you sourced, cite the source and its date; change your answer only for newer or contradicting evidence.${mode === "code" ? CODE_SESSION_FETCHES : ""}`;
}

export function recallReflexSection(mode: ChatMode): PromptSection {
  return {
    id: "recall-reflex", label: "Recall Reflex", type: "static", policy: "required", priority: "safety",
    build: () => recallReflexText(mode),
  };
}
