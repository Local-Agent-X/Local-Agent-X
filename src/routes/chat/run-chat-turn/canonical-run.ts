import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { ServerContext } from "../../../server-context.js";
import type { ServerEvent, Session } from "../../../types.js";
import type { Role } from "../../../rbac.js";
import type { PreparedAgentRequest } from "../../../agent-request/types.js";
import { ThreatEngine } from "../../../threat/threat-engine.js";
import { sanitizeModelOutput } from "../../../providers/output-sanitize.js";
import type { TurnError } from "../../../providers/sanitize.js";
import { createLogger } from "../../../logger.js";

const logger = createLogger("routes.chat.canonical-run");

/** Cap on the error text carried into history — the same cap the event pump
 *  applies to the `error` ServerEvent it forwards to the UI. */
const TURN_ERROR_MESSAGE_MAX = 240;

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
  const salvage = async (interrupted: boolean, terminalError: TurnError | null): Promise<void> => {
    if (salvaged) return;
    salvaged = true;
    try {
      await persistTurnState({
        canonicalOpId, message, assistantText: getFullResponseText().trim(),
        session, ctx, sessionId,
        images: prepared.images.map((im) => ({ name: im.name, url: im.url })),
        interrupted,
        terminalError,
        abortSignal,
      });
    } catch (e) {
      logger.warn(`[chat] salvage/persist failed (${interrupted ? "interrupted" : terminalError ? "error" : "clean"}): ${(e as Error).message}`);
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
    let lastError: TurnError | null = null;
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
      if (ev.type === "error") {
        // Last error wins. Whether it was TERMINAL is settled against the
        // op's final state after the drain (opEndedFailed) — not guessed here.
        lastError = turnErrorFromEvent(ev.message);
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
    // An error the UI showed is narrated to the next turn's model ONLY when
    // the op actually died on it; recovered errors keep going and must not be.
    const terminalError = lastError && await opEndedFailed(canonicalOpId) ? lastError : null;
    await salvage(abortSignal.aborted || iterationCheckpoint, terminalError);
    return { doneEmitted: true };
  } catch (e) {
    // Abort (user stop) or provider error mid-stream. EITHER way, salvage the
    // committed work FIRST so it lands in session.messages before the terminal
    // event — skipping this is exactly what erased the interrupted turn.
    const interrupted = abortSignal.aborted;
    logger.error(`[chat] canonical chat path ${interrupted ? "interrupted (abort)" : "threw"}: ${(e as Error).message}`);
    // A throw is terminal by construction (nothing downstream can recover it)
    // and reaches the UI as the `error` event below, so the model hears it too.
    await salvage(interrupted, interrupted ? null : turnErrorFromEvent(`exception: ${(e as Error).message}`));
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

/** The event pump folds the canonical error's code into the ServerEvent
 *  message as `<code>: <message>` (chat-runner/event-pump.ts); split it back
 *  out for the structural flag. A message without that shape (chat-runner's
 *  submit failure) keeps code "error". Whitespace-flattened and capped so the
 *  boundary stays one sentence. */
function turnErrorFromEvent(message: string): TurnError {
  const m = /^([A-Za-z0-9_.-]{1,64}): ([\s\S]*)$/.exec(message);
  const body = (m ? m[2] : message).replace(/\s+/g, " ").trim();
  return { code: m ? m[1] : "error", message: body.slice(0, TURN_ERROR_MESSAGE_MAX) };
}

/** Did the op itself die? The recovery modules (turn-loop/adapter-throw-
 *  recovery, reported-adapter-recovery, worker-adapter-retry) emit `error`
 *  events that reach the UI and the drain loop exactly like terminal ones —
 *  context-overflow compact-and-retry, adapter retry streaks — so the op's
 *  final state is the only signal that separates them. transitionOp persists
 *  the row BEFORE it emits state_changed, so once the stream has drained the
 *  read is current. A turn with no op (submit failed) had nothing that could
 *  recover it: terminal by construction. */
async function opEndedFailed(opId: string): Promise<boolean> {
  if (!opId) return true;
  try {
    const { readOp } = await import("../../../ops/op-store.js");
    return readOp(opId)?.canonical?.state === "failed";
  } catch (e) {
    logger.warn(`[chat] op state read failed (${opId.slice(0, 12)}) — not narrating the error: ${(e as Error).message}`);
    return false;
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
  /** Turn ended on a TERMINAL error the UI already showed (op state `failed`,
   *  or a throw). Same salvage + boundary treatment as `interrupted`, with an
   *  `_error` boundary row so the next turn's model explains the failure
   *  instead of re-doing the work. Recovered errors never reach here. */
  terminalError?: TurnError | null;
  /** This turn's abort signal — the same one its turn-lock acquire was tagged
   *  with. Used to refuse the persist if a newer turn has since taken the
   *  session's slot (write-generation check). Optional: direct callers (tests)
   *  without a lock-managed signal are always allowed. */
  abortSignal?: AbortSignal;
}

/** Persist-profile hygiene over ONE committed row's param. Assistant SPEECH
 *  only: user rows and tool rows are not model output — a tool result that
 *  legitimately contains `<think>` must persist verbatim — and each assistant
 *  row is a complete message (opMessageRowToChatParam), never a fragment of
 *  one, so per-row is the correct granularity. Clean text returns the same
 *  object, keeping the stored turn byte-identical on the fast path. */
function sanitizeAssistantRowParam(param: ChatCompletionMessageParam): ChatCompletionMessageParam {
  if (param.role !== "assistant" || typeof param.content !== "string" || !param.content) return param;
  const clean = sanitizeModelOutput(param.content, "persist");
  return clean === param.content ? param : { ...param, content: clean };
}

// Exported for the salvage regression test (an interrupted turn must persist
// its work + boundary marker instead of erasing the turn).
export async function persistTurnState(input: PersistInput): Promise<void> {
  const { canonicalOpId, message, session, ctx, sessionId, images, interrupted, terminalError, abortSignal } = input;
  // Persist-profile pass over what the MODEL said this turn (leaked template
  // tokens, reasoning tags, hallucinated tool markup, whole-reply repeats —
  // providers/output-sanitize.ts). Applied to this turn's NEW text only: the
  // streamed-accumulation fallback here and each committed assistant row
  // below. Prior-session history is never re-touched, and the _interrupted
  // boundary row pushed further down stays verbatim — this pass COMPOSES with
  // providers/sanitize.ts's control-marker handling, it doesn't replace it.
  const assistantText = sanitizeModelOutput(input.assistantText, "persist");

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
  // The end-of-turn profile pass scans this turn's rows for untrusted markers;
  // only a COMPLETE op-row projection yields the tool results. The projection
  // is built locally and adopted only once the loop finishes, so a throw
  // mid-loop can neither persist a truncated prefix nor pass as "recovered";
  // the fallback below cannot supply tool rows either. Both hand the pass
  // null and it declines (not provably clean).
  let turnRowsRecovered = false;
  if (canonicalOpId) {
    try {
      const { readOpMessages, opMessageRowToChatParam } = await import("../../../canonical-loop/index.js");
      const projected: ChatCompletionMessageParam[] = [];
      for (const row of readOpMessages(canonicalOpId)) {
        if (row.messageId.startsWith("hist-")) continue;
        const param = opMessageRowToChatParam(row);
        if (param) projected.push(sanitizeAssistantRowParam(param));
      }
      newChatMessages.push(...projected);
      turnRowsRecovered = projected.length > 0;
    } catch (e) {
      turnRowsRecovered = false;
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

  // A stopped or errored turn ends without the model's natural closing reply.
  // Leave the canonical boundary row (INTERRUPTED_TURN_BOUNDARY / the turn-
  // error boundary — both owned by providers/sanitize.ts, which also scrubs
  // any model echoes of them) so the resume turn reads a coherent history and
  // continues from there instead of re-deriving. Standalone assistant text is
  // a valid continuation after the salvaged messages, so this never breaks
  // the tool_use/tool_result pairing the providers require. `_interrupted` /
  // `_error` mark it structurally so UI/replay can treat it as control-plane
  // rather than speech. One row: a user stop outranks a provider error, since
  // the user's intent is the fact the next turn needs.
  if (interrupted) {
    const { INTERRUPTED_TURN_BOUNDARY } = await import("../../../providers/sanitize.js");
    newChatMessages.push({
      role: "assistant",
      content: INTERRUPTED_TURN_BOUNDARY,
      _interrupted: true,
    } as ChatCompletionMessageParam);
  } else if (terminalError) {
    const { renderTurnErrorBoundary } = await import("../../../providers/sanitize.js");
    newChatMessages.push({
      role: "assistant",
      content: renderTurnErrorBoundary(terminalError),
      _error: { code: terminalError.code, message: terminalError.message },
    } as ChatCompletionMessageParam);
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
      // Session-level external-content taint (data-lineage/external.ts): a
      // turn that ingested web/http/browser/MCP content must not auto-promote
      // to durable memory — an LLM paraphrase would launder injected
      // instructions past the content-based taint gate. Computed HERE at
      // persist time so the background end-of-turn pass sees the state of the
      // turn that spawned it.
      const { hasExternalIngestion } = await import("../../../data-lineage/external.js");
      await ctx.memoryManager.persistTurn({
        userMessage: message,
        agentResponse: assistantText,
        skip: isTrivialCanonical,
        sessionId,
        hasExternalTaint: hasExternalIngestion(sessionId),
        // This turn's OWN rows (user, tool calls, tool results, injects, final
        // reply) for the end-of-turn marker scan — every row, no anchor; null
        // when the op-row read failed and the tool rows are unknown.
        turnMessages: turnRowsRecovered ? newChatMessages : null,
      });
    } catch (persistErr) {
      logger.warn(`[chat] canonical persistTurn failed (proceeding): ${(persistErr as Error).message}`);
    }
  } else {
    logger.warn(`[chat] canonical turn produced no assistant text — persisting user turn only (sess=${sessionId.slice(0, 16)})`);
  }

  ctx.saveSession(session);

  // An interrupted or errored turn changed session.messages; the cached
  // memory/situational block built from the pre-interruption state is now
  // stale (its TTL would otherwise serve it to the resume turn). Evict so the
  // next turn rebuilds context that reflects the salvaged work.
  if (interrupted || terminalError) {
    try {
      const { invalidateTurnContextCache } = await import("../../../agent-request/turn-context-cache.js");
      invalidateTurnContextCache(sessionId);
    } catch { /* best-effort */ }
  }
}
