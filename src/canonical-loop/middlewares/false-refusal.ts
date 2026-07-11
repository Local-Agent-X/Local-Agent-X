/**
 * False-refusal grounding guard — the model ends a turn REFUSING a file action
 * it is actually permitted to do, on a GUESSED restriction ("that's outside the
 * sandbox", "I can't access that file", "no permission to read it"), while
 * making zero tool calls and never having attempted `read` this op.
 *
 * Live failure 2026-06-29 (grok-4.3): with file access set to UNRESTRICTED the
 * model refused `read ~/Documents/notes.txt` as "outside the workspace sandbox"
 * — it never called `read`, so the access check never ran. The constitutional
 * rule + the per-turn mode block (config/system-prompt.md "Attempt permitted
 * actions" + build-system-prompt.fileAccessGroundingBlock) are the prompt-level
 * fix; this is the enforcement backstop for prompt-ignoring models (Grok).
 *
 * Scoped to UNRESTRICTED mode on purpose: there a file-access refusal is almost
 * certainly false — the only real blocks are a missing file and credential/key
 * files, which the model can learn ONLY by trying. In workspace/common mode a
 * refusal can be a correct "that path is outside the allowed roots", so we don't
 * nudge there; the prompt grounding handles those.
 *
 * Distinguishes a FALSE refusal (never attempted read → nudge) from a TRUE one
 * (tried read, got a real block → a legitimate report, leave it): the
 * precondition requires read to be ABSENT from attemptedToolsThisOp.
 *
 * Sibling of tool-search-nudge (which handles "declines claiming NO TOOL" by
 * forcing a search) — distinct remedy: here the tool EXISTS and is permitted, so
 * grounding the model in the real policy and forcing the call is the fix, not a
 * search. Registered BEFORE tool-search-nudge so a file-permission refusal gets
 * THIS grounding nudge, not the (useless-for-an-eager-read) search nudge. Fires
 * at most once per op.
 */
import { type CanonicalMiddleware } from "./types.js";
import { getMiddlewareState } from "./state.js";
import { loadFileAccessMode } from "../../security/layer/security-config.js";

interface FiredFlag { fired: boolean }

// Tools whose ATTEMPT (success OR block) means the model engaged the file system
// — a refusal after one of these is a real report, not a guess, so it's excluded.
const READ_TOOLS = ["read", "ari_file"];

// Ethical / willingness refusals — never a false capability refusal.
const ETHICAL_REFUSAL =
  /\b(?:i\s+won'?t|i\s+will\s+not|not\s+comfortable|not\s+willing|against\s+my)\b/i;

// A refusal of a FILE action grounded in a guessed restriction (sandbox / path /
// permission). Narrow on purpose — each pattern pairs a refusal with a file/path
// cue so it doesn't fire on no-tool denials (tool-search-nudge's job) or normal
// answers. Matched against the conclusion (tail) of the reply.
const FILE_REFUSAL: RegExp[] = [
  /\boutside\s+(?:the\s+|your\s+|my\s+)?(?:workspace|sandbox|allowed|permitted|project)\b/i,
  /\b(?:can'?t|cannot|could\s+not|couldn'?t|am\s+(?:not\s+able|unable)\s+to|not\s+able\s+to)\s+(?:access|read|open|reach)\b[^.?!]{0,40}?\b(?:file|path|directory|folder|document|that|this|it|your)\b/i,
  /\b(?:don'?t|do\s+not)\s+have\s+(?:permission|access|the\s+permission)\b[^.?!]{0,40}?\b(?:read|open|access|file|path|that|this|directory|folder)\b/i,
  /\b(?:that|this|the)\s+(?:file|path|directory|folder)\b[^.?!]{0,40}?\b(?:is\s+)?(?:outside|restricted|off-limits|not\s+accessible|blocked|not\s+allowed|protected)\b/i,
];

/** True when `text` reads as the model refusing a FILE action on a guessed
 *  restriction (vs a no-tool denial or an ethical refusal). Pure + exported. */
export function looksLikeFalseFileRefusal(text: string): boolean {
  const norm = text.trim().replace(/’/g, "'").replace(/\bi'm\b/gi, "I am");
  if (!norm) return false;
  if (ETHICAL_REFUSAL.test(norm)) return false;
  return FILE_REFUSAL.some((re) => re.test(norm.slice(-600)));
}

export const falseRefusalMiddleware: CanonicalMiddleware = {
  name: "false-refusal",

  afterModelCall(ctx) {
    if (ctx.toolCalls.length > 0) return { kind: "continue" };          // it tried a tool
    const text = ctx.assistantContent.trim();
    if (!text) return { kind: "continue" };
    // Tried to read already → whatever it reports is a real result, not a guess.
    if (READ_TOOLS.some((t) => ctx.attemptedToolsThisOp.has(t))) return { kind: "continue" };
    // Only UNRESTRICTED makes a file refusal unambiguously false; a refusal in
    // workspace/common can be a correct out-of-roots report. Best-effort read.
    let mode: string;
    try { mode = loadFileAccessMode(); } catch { return { kind: "continue" }; }
    if (mode !== "unrestricted") return { kind: "continue" };
    if (!looksLikeFalseFileRefusal(text)) return { kind: "continue" };

    const flag = getMiddlewareState<FiredFlag>(ctx.op.id, "false-refusal", () => ({ fired: false }));
    if (flag.fired) return { kind: "continue" };
    flag.fired = true;

    const message =
      "Stop — file access is set to UNRESTRICTED, so you CAN read that. A read fails " +
      "ONLY if the file does not exist or is a credential/key file; nothing here is " +
      "\"outside a sandbox.\" You refused without ever calling `read`. Call `read` on the " +
      "exact path the user named now and report the real result — only tell the user you " +
      "can't AFTER the tool itself returns an error.";

    return { kind: "nudge", message, reason: "false-refusal-grounding" };
  },
};
