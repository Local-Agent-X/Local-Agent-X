import { USER_HINTS } from "../types.js";
import { getLearnedProtocolEnvelopeForOp, type LearnedProtocolEnvelope } from "../canonical-loop/runtime.js";
import { activeLearnedProtocolProvenance } from "../protocols/learned-lifecycle.js";
import type { Phase } from "./context.js";
import { CONTINUE, terminate } from "./context.js";

export const learnedProtocolEnvelopeGate: Phase = async (ctx) => {
  const opId = ctx.operationId;
  if (!opId) return CONTINUE;
  let envelope: LearnedProtocolEnvelope | null;

  try {
    envelope = getLearnedProtocolEnvelopeForOp(opId);
    if (!envelope) return CONTINUE;
    const current = activeLearnedProtocolProvenance(envelope.slug);
    if (
      current.versionId !== envelope.versionId
      || current.candidateId !== envelope.candidateId
      || JSON.stringify(current.allowedTools) !== JSON.stringify(envelope.allowedTools)
    ) {
      throw new Error("Selected learned protocol version is no longer active");
    }
  } catch (error) {
    return terminate(ctx, {
      rendered: "model",
      result: {
        content: `BLOCKED by learned protocol envelope: ${(error as Error).message}`,
        isError: true,
        status: "blocked",
        metadata: {
          layer: "learned-protocol-envelope",
          recovery: "Stop this operation and select a current, verified learned protocol version.",
          userHint: USER_HINTS.policy,
        },
      },
      allowed: false,
    });
  }

  if (!envelope.allowedTools.includes(ctx.tc.name)) {
    return terminate(ctx, {
      rendered: "model",
      result: {
        content: `BLOCKED by learned protocol envelope: ${ctx.tc.name} is not in this version's capability list.`,
        isError: true,
        status: "blocked",
        metadata: {
          layer: "learned-protocol-envelope",
          recovery: "Continue using only the tools recorded in this learned workflow's verified evidence.",
          userHint: USER_HINTS.policy,
        },
      },
      allowed: false,
    });
  }
  return CONTINUE;
};
