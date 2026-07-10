import { buildContextPack } from "../../ops/context-pack-builder.js";
import { getRetryPolicy } from "../../ops/heartbeat.js";
import { newOpId, writeOp } from "../../ops/op-store.js";
import { trackOpForSession } from "../../ops/session-bridge.js";
import type { Op, OpVisibility } from "../../ops/types.js";
import type { CanonicalChatContext } from "../chat-runner.js";
import { seedOpMessages } from "./seed-messages.js";

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
  const contextPack = await buildContextPack({
    description: ctx.message,
    successCriteria: [],
    constraints: [],
    lane: "interactive",
    preferredProvider: ctx.prepared.provider,
    authSource: ctx.prepared.authSource,
    budget: { maxIterations: ctx.prepared.maxIterations || 30, maxWallTimeMs: wallClockMs },
  });

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
