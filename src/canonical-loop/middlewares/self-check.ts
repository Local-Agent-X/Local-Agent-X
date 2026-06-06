/**
 * Self-check on terminal turns — when the model is about to end the turn
 * (no tool calls), scan recent tool results for unresolved errors and
 * inject a reflection prompt. Canonical-loop port of
 * src/agent-loop/middlewares/self-check.ts. Fires at most once per OP.
 */
import { isWorkerOp, type CanonicalMiddleware } from "./types.js";
import { getMiddlewareState } from "./state.js";
import { detectUnresolvedErrors, buildReflectionPrompt } from "../../agent-guards/index.js";
import { readOpMessages } from "../store.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

interface FiredFlag { fired: boolean }

export const selfCheckMiddleware: CanonicalMiddleware = {
  name: "self-check",
  when: isWorkerOp,

  afterModelCall(ctx) {
    if (ctx.toolCalls.length > 0) return { kind: "continue" };
    const flag = getMiddlewareState<FiredFlag>(
      ctx.op.id,
      "self-check",
      () => ({ fired: false }),
    );
    if (flag.fired) return { kind: "continue" };

    // detectUnresolvedErrors needs ChatCompletionMessageParam[] — project the
    // canonical op_messages into that shape just deeply enough for the
    // regex-based scan to work. role + content (string) is all it reads.
    const rows = readOpMessages(ctx.op.id);
    const messages: ChatCompletionMessageParam[] = rows.map(r => {
      const text = (r.content as { text?: string; result?: unknown })?.text
        ?? (typeof (r.content as { result?: unknown })?.result === "string"
              ? (r.content as { result: string }).result
              : "");
      if (r.role === "tool_result") {
        return {
          role: "tool",
          tool_call_id: (r.content as { toolCallId?: string })?.toolCallId ?? "",
          content: text,
        } as ChatCompletionMessageParam;
      }
      if (r.role === "assistant") return { role: "assistant", content: text };
      if (r.role === "user") return { role: "user", content: text };
      return { role: "user", content: "" };
    });

    // NOTE: we deliberately do NOT push ctx.assistantContent here. agent-
    // loop's self-check runs in afterModelCall BEFORE the new assistant
    // message is committed, so detectUnresolvedErrors sees only the prior
    // turn's assistant + tool history. Pushing the live assistant text
    // would make `lastAssistantTextIdx` land on this turn's text and
    // skip the prior turn's tool errors that are exactly what self-check
    // is supposed to catch.

    const errors = detectUnresolvedErrors(messages);
    if (errors.length === 0) return { kind: "continue" };
    flag.fired = true;
    return { kind: "nudge", message: buildReflectionPrompt(errors), reason: "self-check" };
  },
};
