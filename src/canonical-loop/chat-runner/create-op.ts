import { buildContextPack } from "../../ops/context-pack-builder.js";
import { getRetryPolicy } from "../../ops/heartbeat.js";
import { newOpId, writeOp } from "../../ops/op-store.js";
import { trackOpForSession } from "../../ops/session-bridge.js";
import type { Op, OpVisibility } from "../../ops/types.js";
import type { CanonicalChatContext } from "../chat-runner.js";
import { seedOpMessages } from "./seed-messages.js";
import { measurePromptSection, remeasurePromptTelemetry } from "../../prompt-telemetry.js";
import { foldSystemRowsIntoPrompt } from "./message-convert.js";
import { appendSystemPromptSection } from "../../context/system-prompt-builder.js";

function readChatWallClockMs(): number {
  const raw = parseInt(process.env.LAX_CHAT_WALLCLOCK_MS ?? "7200000", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 7_200_000;
}

export interface CreatedChatOp {
  op: Op;
  wallClockMs: number;
}

export async function createChatOp(ctx: CanonicalChatContext): Promise<CreatedChatOp> {
  const wallClockMs = readChatWallClockMs();
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
  const contextPack = await buildContextPack({
    description: ctx.message,
    successCriteria: [],
    constraints: [],
    lane: "interactive",
    preferredProvider: ctx.prepared.provider,
    authSource: ctx.prepared.authSource,
    budget: { maxIterations: ctx.prepared.maxIterations || 30, maxWallTimeMs: wallClockMs },
  });
  if (ctx.prepared.promptTelemetry) {
    const chatAugmentations = promptBeforeSystemHistory.slice(ctx.prepared.promptTelemetry.characters);
    const sections = [...ctx.prepared.promptTelemetry.sections];
    if (chatAugmentations) {
      sections.push(measurePromptSection("chat-augmentations", "dynamic", chatAugmentations));
    }
    if (systemHistory) {
      sections.push(measurePromptSection("system-history", "dynamic", systemHistory));
    }
    contextPack.promptTelemetry = remeasurePromptTelemetry({
      baseline: ctx.prepared.promptTelemetry,
      prompt: ctx.prepared.systemPrompt,
      tools: ctx.tools,
      historyMessageCount: ctx.prepared.cleanHistory.length,
      sections,
    });
  }

  const op: Op = {
    id: newOpId("op_chat_turn"),
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
  return { op, wallClockMs };
}
