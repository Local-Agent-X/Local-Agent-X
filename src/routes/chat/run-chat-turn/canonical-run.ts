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
  /** SSE-only sink (null on WS). Retained for the orchestrator's call shape;
   *  terminal error/done now go through `wrappedOnEvent` so WS clients get them. */
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
    threatEngine, abortSignal, primaryEventProxy, wrappedOnEvent,
    getFullResponseText,
  } = input;

  const turnStart = Date.now();
  let canonicalOpId = "";
  let salvaged = false;
  let iterationCheckpoint = false;

  // Fold whatever the canonical op COMMITTED (user msg + assistant tool-calls +
  // tool results) into session.messages so a turn that ends — cleanly OR by a
  // user-stop / provider error — is never erased. Runs exactly once. This is
  // what lets the user "keep going" after a stop with the prior turn's work
  // intact instead of the agent re-deriving what it just did (the 2026-06-27
  // amnesia: persistTurnState sat AFTER the stream loop, so an aborting throw
  // skipped it and the committed work never reached session.messages). Only
  // fully-committed turns are in op_messages (commitTurn writes assistant +
  // tool_results together), so the folded history is always provider-valid.
  const salvage = async (interrupted: boolean): Promise<void> => {
    if (salvaged) return;
    salvaged = true;
    try {
      await persistTurnState({
        canonicalOpId, message, assistantText: getFullResponseText().trim(),
        session, ctx, sessionId,
        images: prepared.images.map((im) => ({ name: im.name, url: im.url })),
        interrupted,
        abortSignal,
      });
    } catch (e) {
      logger.warn(`[chat] salvage/persist failed (${interrupted ? "interrupted" : "clean"}): ${(e as Error).message}`);
    }
  };

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
    for await (const ev of eventStream) {
      if (ev.type === "done") {
        if (ev.usage) canonicalUsage = ev.usage;
        continue;
      }
      if (ev.type === "chat_op_started" && typeof ev.opId === "string") {
        canonicalOpId = ev.opId;
      }
      if (ev.type === "stopped" && ev.firedBy === "iteration-budget") {
        iterationCheckpoint = true;
      }
      primaryEventProxy(ev);
    }
    const canonicalElapsed = Date.now() - turnStart;
    logger.info(`[timing] canonical/chat ${prepared.model} ${canonicalElapsed}ms (sess=${sessionId.slice(0, 16)})`);

    // Emit `done` BEFORE persisting. The stream content is complete here; the
    // client finalizes off this signal (promotes its live row, saves locally,
    // clears the STREAMING indicator + stop button). Server-side persistence
    // (session save + memory chunk indexing) ran AFTER this and added 2-3s of
    // phantom streaming to the UI — worse as the session grows. Persistence is
    // server-only state and the client never waits on it, so decouple them.
    wrappedOnEvent({ type: "done", usage: canonicalUsage });

    // The stream can end gracefully even on abort (the loop just stops
    // yielding), so detect interruption here too — not only in catch.
    await salvage(abortSignal.aborted || iterationCheckpoint);
    return { doneEmitted: true };
  } catch (e) {
    // Abort (user stop) or provider error mid-stream. EITHER way, salvage the
    // committed work FIRST so it lands in session.messages before the terminal
    // event — skipping this is exactly what erased the interrupted turn.
    const interrupted = abortSignal.aborted;
    logger.error(`[chat] canonical chat path ${interrupted ? "interrupted (abort)" : "threw"}: ${(e as Error).message}`);
    await salvage(interrupted);
    // Emit the terminal error/done via wrappedOnEvent, NOT emitSse. On WS
    // clients sseSink is null, so emitSse is a no-op and both events vanish —
    // yet we still return doneEmitted:true, which suppresses the orchestrator's
    // failChat safety net. The ActiveChat is then never marked done and the UI
    // spins until the 60s watchdog. wrappedOnEvent also drives wsChat.onEvent,
    // whose `done` handler clears the ActiveChat (mirrors the success path).
    if (!interrupted) wrappedOnEvent({ type: "error", message: `chat: ${(e as Error).message}` });
    wrappedOnEvent({ type: "done", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
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
  /** This turn's images (/uploads paths) — persisted on the user message. */
  images: Array<{ name: string; url: string }>;
  /** Turn ended by user-stop / abort rather than a clean done. Salvage the
   *  committed work, mark the boundary, and refresh the stale context cache. */
  interrupted?: boolean;
  /** This turn's abort signal — the same one its turn-lock acquire was tagged
   *  with. Used to refuse the persist if a newer turn has since taken the
   *  session's slot (write-generation check). Optional: direct callers (tests)
   *  without a lock-managed signal are always allowed. */
  abortSignal?: AbortSignal;
}

// Exported for the salvage regression test (an interrupted turn must persist
// its work + boundary marker instead of erasing the turn).
export async function persistTurnState(input: PersistInput): Promise<void> {
  const { canonicalOpId, message, assistantText, session, ctx, sessionId, images, interrupted, abortSignal } = input;

  // Write-generation check. A wedged turn that the turn lock force-released
  // (5s safety net) can un-wedge AFTER a replacement turn has acquired the
  // slot and written new history; its in-memory session.messages is stale and
  // the full rewrite below would erase the newer turn's rows ("agent forgot
  // what I just said"). Only the session slot's latest acquirer may persist.
  const { isCurrentTurnWriter } = await import("../../../session/turn-lock.js");
  if (!isCurrentTurnWriter(sessionId, abortSignal)) {
    logger.warn(`[chat] stale turn superseded by a newer turn — skipping persist to protect current history (sess=${sessionId.slice(0, 16)})`);
    return;
  }

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

  // Defensive fallback: never silently drop the user's input. The normal path
  // persists this turn's images via opMessageRowToChatParam (reads them off the
  // op row); this fallback bypasses that, so carry them explicitly here too.
  if (newChatMessages.length === 0) {
    const userMsg: ChatCompletionMessageParam & { images?: typeof images } = { role: "user", content: message };
    if (images.length > 0) userMsg.images = images;
    newChatMessages.push(userMsg);
    if (assistantText) {
      newChatMessages.push({ role: "assistant", content: assistantText });
    }
  }
  const hasAssistantContent = newChatMessages.some((m) =>
    m.role === "assistant" && typeof m.content === "string" && m.content.trim().length > 0
  );
  if (assistantText && !hasAssistantContent) {
    newChatMessages.push({ role: "assistant", content: assistantText });
  }

  // A stopped turn ends without the model's natural closing reply. Leave a
  // short, provider-safe boundary marker so the resume turn reads a coherent
  // history (user → tool calls/results → "[interrupted]") and continues from
  // there instead of re-deriving. Standalone assistant text is a valid
  // continuation after the salvaged messages, so this never breaks the
  // tool_use/tool_result pairing the providers require.
  if (interrupted) {
    newChatMessages.push({
      role: "assistant",
      content: "[Previous turn was interrupted before it finished. The work above ran; continue from there.]",
    });
  }

  const { COMPACTION_PREFIX: COMPACTION_PREFIX_CHAT } = await import("../../../types.js");
  session.messages = stripCanonical([...session.messages, ...newChatMessages]).filter((m) => {
    if (m.role === "system") {
      return typeof m.content === "string" && m.content.startsWith(COMPACTION_PREFIX_CHAT);
    }
    if (m.role === "tool") return true;
    return m.content || (m as unknown as MsgRecordC).tool_calls || (m as { images?: unknown[] }).images?.length;
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

  // An interrupted turn changed session.messages; the cached memory/situational
  // block built from the pre-interruption state is now stale (its 30-min TTL
  // would otherwise serve it to the resume turn). Evict so the next turn
  // rebuilds context that reflects the salvaged work.
  if (interrupted) {
    try {
      const { invalidateTurnContextCache } = await import("../../../agent-request/turn-context-cache.js");
      invalidateTurnContextCache(sessionId);
    } catch { /* best-effort */ }
  }
}
