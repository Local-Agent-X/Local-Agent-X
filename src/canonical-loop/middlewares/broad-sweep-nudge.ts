/**
 * Broad-sweep enumerate-first guard — the task is a codebase-wide change ("find
 * and fix every X", "remove all references to Y", "rename Z everywhere") but the
 * model is wrapping up a turn (zero tool calls) WITHOUT ever enumerating the
 * surface (no `grep`/`glob` this op). Strong tool-users grep the whole tree,
 * build the worklist, then sweep and re-grep to confirm none remain; weaker ones
 * edit only what they stumbled on and declare done — leaving most of the surface
 * untouched. This forces ONE enumeration pass before the under-done result lands.
 *
 * Mirrors tool-search-nudge: a phrase-gated, fire-once, all-lanes nudge.
 *   - broad-sweep phrasing in the task  → narrow single-spot edits excluded
 *   - already grep/glob'd this op        → respect a model that DID enumerate
 *   - zero tool calls this turn          → only fires as it wraps up, not mid-work
 *   - fire-once per op                    → no loops
 */
import { type CanonicalMiddleware } from "./types.js";
import { getMiddlewareState } from "./state.js";
import { capabilityForbiddenForOp } from "../instruction-ledger/index.js";

interface FiredFlag { fired: boolean }

// A change whose SCOPE is the whole codebase, not one named spot.
const SCOPE_CUE =
  /\b(?:all|every|each|any\s+(?:other|remaining)|everywhere|throughout|scattered|left\s*over|remaining|across\s+the\s+(?:code|codebase|project|repo(?:sitory)?|app)|through\s+the\s+(?:code|codebase|project|repo(?:sitory)?|app)|the\s+(?:whole|entire)\s+(?:code|codebase|project|repo(?:sitory)?|app)|in\s+the\s+code(?:base)?)\b/i;

// A FIND-and-CHANGE verb. Excludes add/summarize/list — those aren't sweeps.
const ACTION_CUE =
  /\b(?:find|search|fix|update|replace|remove|delete|rename|clean(?:\s*up|ing)?|cleanup|migrat\w*|refactor|sweep|purge|eliminat\w*|scrub|go\s+through)\b/i;

/** True when the task reads as a codebase-wide find-and-change sweep (needs BOTH
 *  a breadth cue and a find/change verb). Pure + exported for direct testing. */
export function looksLikeBroadSweep(task: string): boolean {
  const t = (task || "").trim();
  if (t.length < 12) return false;
  return SCOPE_CUE.test(t) && ACTION_CUE.test(t);
}

export const broadSweepNudgeMiddleware: CanonicalMiddleware = {
  name: "broad-sweep-nudge",

  afterModelCall(ctx) {
    // The nudge pushes enumerate-and-FIX — never against an explicit user
    // prohibition on changing the workspace. Fail-open: no ledger entry, no
    // suppression.
    if (capabilityForbiddenForOp(ctx.op, "workspace-write")) return { kind: "continue" };
    if (ctx.toolCalls.length > 0) return { kind: "continue" };           // still acting
    if (ctx.toolsCalledThisOp.has("grep") || ctx.toolsCalledThisOp.has("glob"))
      return { kind: "continue" };                                       // already enumerated
    if (!looksLikeBroadSweep(ctx.userMessage)) return { kind: "continue" };

    const flag = getMiddlewareState<FiredFlag>(
      ctx.op.id,
      "broad-sweep-nudge",
      () => ({ fired: false }),
    );
    if (flag.fired) return { kind: "continue" };
    flag.fired = true;

    const message =
      "Stop — this is a codebase-wide change and you haven't enumerated the " +
      "surface yet. Before finishing: run `grep` (and `glob`) across the WHOLE " +
      "project to find EVERY occurrence — code, comments, docs, config, tests — " +
      "and build the full worklist. Fix each one, then re-grep to confirm none " +
      "remain. Tell live references that must change from legitimate historical " +
      "mentions (\"replaced the old X\"), and don't delete or rename a symbol other " +
      "code still depends on just because it names the old thing.";

    return { kind: "nudge", message, reason: "broad-sweep-enumerate" };
  },
};
