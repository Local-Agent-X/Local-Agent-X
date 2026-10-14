/**
 * When changing a fact the user told the agent asks them first
 * (ToolDefinition.confirmWithUser → ask-user-gates.ts; Peter, 2026-10-13).
 * "Told by the user" is isUserReported, quoted or paraphrased, or a row with
 * no recorded origin. A fact a model wrote on its own account asks nothing.
 */
import type { MemoryIndex } from "../index.js";
import type { RetainedFact } from "../types.js";
import { displayContent } from "../utils.js";
import { localDate } from "../retrieval-format.js";
import { isUserReported } from "../fact-provenance-label.js";
import { tokenizeStrict } from "../text-utils.js";
import { userAskedToForget } from "../../irreversible-tools.js";

type Confirm = (args: Record<string, unknown>, ctx: { userText: string }) => string | null;

function userTold(memory: MemoryIndex, query: string): RetainedFact | null {
  const { fact } = memory.findOneFact(query);
  return fact && (fact.provenance == null || isUserReported(fact)) ? fact : null;
}

const quoted = (fact: RetainedFact) => `"${displayContent(fact).slice(0, 160)}" (recorded ${localDate(fact.timestamp)})`;

/** forget: qwen3.6:27b, told "you made that up" with the user's own message in
 *  front of it, forgot the true fact in 2 of 3 runs (2023610d). A forget the
 *  user asked for in their own words asks nothing. */
export function confirmForget(memory: MemoryIndex): Confirm {
  return (args, { userText }) => {
    const query = String(args.query || "").trim();
    if (!query || userAskedToForget(userText)) return null;
    const fact = userTold(memory, query);
    return fact ? `The agent wants to forget something you told it: ${quoted(fact)}. Approve only if you want it forgotten.` : null;
  };
}

/**
 * update_fact: the same 27B, refused the forget, reached for update_fact with
 * "This fact was recorded in error and has been retracted by the user." — a
 * deletion by another name, which only a wrong argument name stopped (9115bd39).
 * A correction carries the user's new value ("it's at slip 31 now" → "…slip
 * 31…"), so it runs when a word the replacement adds to the fact is in the
 * user's latest message; a replacement that adds nothing new is a rewording.
 * Anything else asks.
 */
export function confirmUpdate(memory: MemoryIndex): Confirm {
  return (args, { userText }) => {
    const query = String(args.query || "").trim();
    const content = String(args.content || "").trim();
    if (!query || !content) return null;
    const fact = userTold(memory, query);
    if (!fact) return null;
    const before = tokenizeStrict(fact.content);
    const added = [...tokenizeStrict(content)].filter((t) => !before.has(t));
    if (added.length === 0) return null;
    const said = tokenizeStrict(userText);
    if (added.some((t) => said.has(t))) return null;
    return `The agent wants to change something you told it: ${quoted(fact)} → "${content.slice(0, 160)}". `
      + "Your last message doesn't contain the new value. Approve only if this is the correction you meant.";
  };
}
