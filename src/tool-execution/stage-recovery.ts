/**
 * The next step a refusal names when the layer that refused gave none of its
 * own. Every blocked result must carry one (types.ts ToolResult): a refusal
 * with no way forward is where a model stops and hands the work back. Keyed
 * by stage, so a new stage without an entry does not compile; a specific
 * recovery from the deciding rule always wins over these.
 *
 * None of these steers around the decision: a security or kernel refusal
 * says not to look for another way, and every one says what the user can do
 * and to keep going with the rest of the request.
 */
import type { ToolBlockedStage } from "./pre-dispatch.js";

export const STAGE_RECOVERY: Readonly<Record<ToolBlockedStage, string>> = {
  "session-policy":
    "This chat's session policy does not allow this tool. Tell the user what you were trying to do; they can change it for this chat. Continue with the rest of the request.",
  security:
    "The security policy refused this. Do not look for another way around it. Tell the user what you were trying to do and why; if the rule is wrong for this task, they can change it in Settings → Security. Continue with the rest of the request.",
  rbac:
    "You are not allowed to call this. Tell the user what you needed, so they can do it themselves, and continue with the rest of the request.",
  "tool-policy":
    "The tool policy refuses this call. Tell the user what you were trying to do; they can change the rule in Settings → Security → Tool Policy. Continue with the rest of the request.",
  threat:
    "The threat monitor stopped this. Do not retry it another way. Tell the user what you were doing so they can review it, and continue with work that does not need it.",
  arikernel:
    "The security kernel refused this. Do not look for another way around it. Tell the user what you were trying to do, and continue with the rest of the request.",
  approval:
    "This needs the user's approval. Tell them what you want to do and why, and continue with other work meanwhile.",
};
