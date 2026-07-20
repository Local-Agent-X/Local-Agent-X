import { buildContextPack } from "../../ops/context-pack-builder.js";
import { getRetryPolicy } from "../../ops/heartbeat.js";
import { newOpId, writeOp } from "../../ops/op-store.js";
import { trackOpForSession } from "../../ops/session-bridge.js";
import type { Op, OpVisibility } from "../../ops/types.js";
import type { CanonicalChatContext } from "../chat-runner.js";
import { seedOpMessages } from "./seed-messages.js";
import { remeasurePromptTelemetry } from "../../prompt-telemetry.js";
import { foldSystemRowsIntoPrompt } from "./message-convert.js";
import { appendSystemPromptSection } from "../../context/system-prompt-builder.js";
import { preflightCapabilityAwarePrompt } from "../prompt-preflight.js";
import type { OpenAICompatTarget } from "../adapters/openai-compat.js";

function readChatWallClockMs(): number {
  const raw = parseInt(process.env.LAX_CHAT_WALLCLOCK_MS ?? "7200000", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 7_200_000;
}

export interface CreatedChatOp {
  op: Op;
  wallClockMs: number;
  resolvedTarget: OpenAICompatTarget | null;
}

export async function createChatOp(ctx: CanonicalChatContext): Promise<CreatedChatOp> {
  const wallClockMs = readChatWallClockMs();
  const plannedPrompt = ctx.prepared.renderedPromptSections.map((section) => section.text).join("");
  if (plannedPrompt !== ctx.prepared.systemPrompt) {
    throw new Error("Canonical chat prompt sections do not match systemPrompt bytes");
  }
  const promptBeforeSystemHistory = ctx.prepared.systemPrompt;
  const foldedSystemPrompt = foldSystemRowsIntoPrompt(
    promptBeforeSystemHistory,
    ctx.prepared.cleanHistory,
  );
  const systemHistory = foldedSystemPrompt.slice(promptBeforeSystemHistory.length);
  appendSystemPromptSection(ctx.prepared, {
    id: "system-history",
    label: "System History",
    type: "dynamic",
    policy: "required",
    text: systemHistory,
  });
  const resolvedTarget = await preflightCapabilityAwarePrompt(ctx.prepared);
  ctx.prepared.promptTelemetry = remeasurePromptTelemetry({
    baseline: ctx.prepared.promptTelemetry,
    prompt: ctx.prepared.systemPrompt,
    tools: ctx.tools,
    historyMessageCount: ctx.prepared.cleanHistory.length,
    sections: ctx.prepared.renderedPromptSections.map((section) => section.measurement),
  });
  const contextPack = await buildContextPack({
    description: ctx.message,
    successCriteria: [],
    constraints: [],
    lane: "interactive",
    preferredProvider: ctx.prepared.provider,
    targetPin: ctx.prepared.targetPin,
    authSource: ctx.prepared.authSource,
    budget: { maxIterations: ctx.prepared.maxIterations || 30, maxWallTimeMs: wallClockMs },
  });
  if (ctx.prepared.promptTelemetry) {
    contextPack.promptTelemetry = ctx.prepared.promptTelemetry;
  }

  const op: Op = {
    id: newOpId("op_chat_turn"),
    sessionId: ctx.sessionId,
    type: "chat_turn",
    task: ctx.message,
    contextPack,
    lane: "interactive",
    retryPolicy: getRetryPolicy("chat_turn"),
    ownerId: "local-user",
    visibility: "private" as OpVisibility,
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
    model: ctx.prepared.model,
  };

  trackOpForSession(op.id, ctx.sessionId, ctx.message);
  writeOp(op);
  seedOpMessages(op.id, ctx.prepared, ctx.message);
  return { op, wallClockMs, resolvedTarget };
}
