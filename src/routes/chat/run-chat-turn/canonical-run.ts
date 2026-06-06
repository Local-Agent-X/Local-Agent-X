import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { ServerContext } from "../../../server-context.js";
import type { ServerEvent, Session } from "../../../types.js";
import type { Role } from "../../../rbac.js";
import type { PreparedAgentRequest } from "../../../agent-request/types.js";
import { ThreatEngine } from "../../../threat/threat-engine.js";
import { createLogger } from "../../../logger.js";

const logger = createLogger("routes.chat.canonical-run");

export interface CanonicalRunInput {
  message: string;
  sessionId: string;
  prepared: PreparedAgentRequest;
  sessionTools: PreparedAgentRequest["tools"];
  session: Session;
  ctx: ServerContext;
  requestRole: Role;
  threatEngine: ThreatEngine;
  abortSignal: AbortSignal;
  primaryEventProxy: (ev: ServerEvent) => void;
  wrappedOnEvent: (ev: ServerEvent) => void;
  emitSse: (ev: ServerEvent) => void;
  getFullResponseText: () => string;
}

export interface CanonicalRunResult {
  /** True iff we emitted the terminal `done` event. */
  doneEmitted: boolean;
}

export async function runCanonicalChat(input: CanonicalRunInput): Promise<CanonicalRunResult> {
  const {
    message, sessionId, prepared, sessionTools, session, ctx, requestRole,
    threatEngine, abortSignal, primaryEventProxy, wrappedOnEvent, emitSse,
    getFullResponseText,
  } = input;

  const turnStart = Date.now();
  try {
    const { runChatViaCanonical } = await import("../../../canonical-loop/index.js");
    const eventStream = runChatViaCanonical({
      message,
      sessionId,
      prepared,
      tools: sessionTools,
      security: ctx.security,
      toolPolicy: ctx.toolPolicy,
      threatEngine,
      rbac: ctx.rbac,
      callerRole: requestRole,
      onToolEvent: primaryEventProxy,
      signal: abortSignal,
    });

    let canonicalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let canonicalOpId = "";
    for await (const ev of eventStream) {
      if (ev.type === "done") {
        if (ev.usage) canonicalUsage = ev.usage;
        continue;
      }
      if (ev.type === "chat_op_started" && typeof ev.opId === "string") {
        canonicalOpId = ev.opId;
      }
      primaryEventProxy(ev);
    }
    const canonicalElapsed = Date.now() - turnStart;
    logger.info(`[timing] canonical/chat ${prepared.model} ${canonicalElapsed}ms (sess=${sessionId.slice(0, 16)})`);

    const assistantText = getFullResponseText().trim();

    // Emit `done` BEFORE persisting. The stream content is complete here; the
    // client finalizes off this signal (promotes its live row, saves locally,
    // clears the STREAMING indicator + stop button). Server-side persistence
    // (session save + memory chunk indexing) ran AFTER this and added 2-3s of
    // phantom streaming to the UI — worse as the session grows. Persistence is
    // server-only state and the client never waits on it, so decouple them.
    wrappedOnEvent({ type: "done", usage: canonicalUsage });

    await persistTurnState({
      canonicalOpId, message, assistantText, session, ctx, sessionId,
    });

    return { doneEmitted: true };
  } catch (e) {
    logger.error(`[chat] canonical chat path threw: ${(e as Error).message}`);
    emitSse({ type: "error", message: `chat: ${(e as Error).message}` });
    emitSse({ type: "done", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
    return { doneEmitted: true };
  }
}

interface PersistInput {
  canonicalOpId: string;
  message: string;
  assistantText: string;
  session: Session;
  ctx: ServerContext;
  sessionId: string;
}

async function persistTurnState(input: PersistInput): Promise<void> {
  const { canonicalOpId, message, assistantText, session, ctx, sessionId } = input;

  const { stripEphemeralMessages: stripCanonical } = await import("../../../providers/sanitize.js");
  type MsgRecordC = Record<string, unknown>;

  const newChatMessages: ChatCompletionMessageParam[] = [];
  if (canonicalOpId) {
    try {
      const { readOpMessages } = await import("../../../canonical-loop/store.js");
      const { opMessageRowToChatParam } = await import("../../../canonical-loop/chat-runner.js");
      const rows = readOpMessages(canonicalOpId);
      for (const row of rows) {
        if (row.messageId.startsWith("hist-")) continue;
        const param = opMessageRowToChatParam(row);
        if (param) newChatMessages.push(param);
      }
    } catch (e) {
      logger.warn(`[chat] canonical op-messages read failed: ${(e as Error).message}`);
    }
  }

  // Defensive fallback: never silently drop the user's input.
  if (newChatMessages.length === 0) {
    newChatMessages.push({ role: "user", content: message });
    if (assistantText) {
      newChatMessages.push({ role: "assistant", content: assistantText });
    }
  }

  const { COMPACTION_PREFIX: COMPACTION_PREFIX_CHAT } = await import("../../../types.js");
  session.messages = stripCanonical([...session.messages, ...newChatMessages]).filter((m) => {
    if (m.role === "system") {
      return typeof m.content === "string" && m.content.startsWith(COMPACTION_PREFIX_CHAT);
    }
    if (m.role === "tool") return true;
    return m.content || (m as unknown as MsgRecordC).tool_calls;
  });
  session.updatedAt = Date.now();

  if (assistantText) {
    const isTrivialCanonical =
      /^(run\s+(bash|command)|execute|bash)\s*(with|:)/i.test(message.trim()) ||
      /^(ls|dir|cat|echo|Write-Output|Get-ChildItem|pwd|whoami|git\s)/i.test(message.trim());
    try {
      await ctx.memoryManager.persistTurn({
        userMessage: message,
        agentResponse: assistantText,
        skip: isTrivialCanonical,
        sessionId,
      });
    } catch (persistErr) {
      logger.warn(`[chat] canonical persistTurn failed (proceeding): ${(persistErr as Error).message}`);
    }
  } else {
    logger.warn(`[chat] canonical turn produced no assistant text — persisting user turn only (sess=${sessionId.slice(0, 16)})`);
  }

  ctx.saveSession(session);
}
