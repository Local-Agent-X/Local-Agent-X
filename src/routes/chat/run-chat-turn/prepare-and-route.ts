import { join } from "node:path";
import type { ServerContext } from "../../../server-context.js";
import type { ServerEvent } from "../../../types.js";
import type { PreparedAgentRequest } from "../../../agent-request/types.js";
import { createLogger } from "../../../logger.js";

const logger = createLogger("routes.chat.prepare");

export interface PrepareInput {
  sessionId: string;
  message: string;
  sessionMessages: unknown[];
  attachments: Array<{ name: string; url: string; isImage: boolean }>;
  ctx: ServerContext;
}

export async function preparePerTurnRequest(input: PrepareInput): Promise<PreparedAgentRequest> {
  const { sessionId, message, sessionMessages, attachments, ctx } = input;
  const { prepareAgentRequest } = await import("../../../agent-request.js");
  const prepStart = Date.now();
  const prepared = await prepareAgentRequest({
    channel: sessionId.startsWith("ide-") ? "web" : "web",
    message, sessionMessages: sessionMessages as Parameters<typeof prepareAgentRequest>[0]["sessionMessages"], sessionId,
    config: ctx.config, dataDir: ctx.dataDir,
    memoryIndex: ctx.memoryIndex, memoryManager: ctx.memoryManager, integrations: ctx.integrations,
    secretsStore: ctx.secretsStore,
    allAgentTools: ctx.allAgentTools, bridgeTools: ctx.bridgeTools,
    attachments, uploadsDir: join(ctx.dataDir, "uploads"),
  });
  logger.info(`[timing] prepareAgentRequest ${Date.now() - prepStart}ms (sess=${sessionId.slice(0, 16)})`);
  console.log(`[chat-diag] prepared sess=${sessionId.slice(-8)} provider=${prepared.provider} model=${prepared.model || "EMPTY"} hasKey=${!!prepared.apiKey}`);
  return prepared;
}

/**
 * Emit a context_status event so the chat-bar gauge reflects actual
 * prompt size BEFORE the agent runs. Fan out to BOTH transports —
 * SSE clients (Telegram/WhatsApp/curl) get `emitSse`, WS clients (the
 * chat UI, which uses sseSink=null) get `ctx.chatWs.emit`. Until this
 * dual-emit was added, WS clients never saw a fresh context_status
 * unless compaction fired, so the bottom-of-chat gauge stayed at the
 * 0K/128K fallback for every normal turn. (chat-status-bar.js falls
 * back to that placeholder when window.lastContextStatus is null.)
 */
export async function emitContextStatus(
  prepared: PreparedAgentRequest,
  ctx: ServerContext,
  sessionId: string,
  emitSse: (ev: ServerEvent) => void,
): Promise<void> {
  try {
    const { getContextStatus } = await import("../../../context-manager.js");
    const status = getContextStatus(prepared.cleanHistory, prepared.model);
    const ev = {
      type: "context_status" as const,
      percentage: status.percentage,
      level: status.level,
      usedTokens: status.usedTokens,
      maxTokens: status.maxTokens,
      compacted: false,
    };
    emitSse(ev);
    ctx.chatWs.emit(sessionId, ev);
  } catch { /* best-effort telemetry */ }
}

const IDE_BLOCKED_TOOLS = new Set([
  "agent_spawn", "delegate", "build_app", "agent_status",
  "agent_cancel", "agent_pause", "agent_resume", "agent_message",
]);

/** IDE sessions: strip delegation tools so an in-editor chat can't spawn workers. */
export function filterToolsForSession(
  tools: PreparedAgentRequest["tools"],
  sessionId: string,
): PreparedAgentRequest["tools"] {
  const isIdeSession = sessionId.startsWith("ide-");
  return isIdeSession ? tools.filter(t => !IDE_BLOCKED_TOOLS.has(t.name)) : tools;
}

/** Strip `>>discuss` prefix if present so the routing decision can act on raw intent. */
export async function applyDiscussPrefix(message: string): Promise<string> {
  const { hasDiscussPrefix, stripDiscussPrefix } = await import("../../../routing/index.js");
  return hasDiscussPrefix(message) ? stripDiscussPrefix(message) : message;
}
