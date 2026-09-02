/**
 * Task-trash scope closer for canonical-loop ops.
 *
 * Always-on observer on the canonical event seam (projectCanonicalEvent,
 * event-emitter.ts) — the counterpart of cost-recording.ts on the same seam.
 * When a WORKER session's op reaches a terminal state and that session has no
 * other live op, the worker's task is over: close its task-trash scope
 * (safe-delete.markTaskTrashScopeClosed) so "restorable until this task ends"
 * means what it says and the trash TTL starts counting. A no-op for sessions
 * that never trashed anything.
 *
 * The discriminator is the SESSION ID, not the op type. Op type alone is
 * wrong: op_submit_async runs AND tracks its delegated ops under the
 * ORIGINATING chat session (ops/tools/shared.ts delegatedRuntimeSessionId =
 * originatingSessionId || opId), and chat-turn delete_file trashes into that
 * same per-session scope — so a background op completing BETWEEN turns finds
 * no live chat_turn peer and would close the CHAT session's scope, silently
 * downgrading chat trash from the 30-day retention window to the 24h
 * closed-TTL. A user-surface session's scope (chat, ide-, cron-, telegram/
 * whatsapp bridges, voice) is therefore NEVER auto-closed, whatever op
 * traffic it carries — it rides safe-delete's ordinary retention. Only
 * isWorkerScopedSession sessions close. (Unattended delegated ops with no
 * originating session run under their op id and are never tracked in the
 * session map, so they too fall to the retention backstop.)
 *
 * The interactive-host-op check is a belt on top: even for a worker-family
 * session, a chat_turn/voice_turn terminal is one reply turn ending, never a
 * task ending.
 *
 * ORDER-SENSITIVE: wired BEFORE the session-bridge observer in
 * projectCanonicalEvent, because the bridge's terminal branch releases the op
 * from the session map (releaseOpFromSession) — after that, getSessionForOp
 * returns nothing and the close could never fire. The terminating op is
 * therefore still IN listOpsForSession here, so the live-peer check excludes
 * it by id.
 *
 * Pure instrumentation — never throws, never blocks the op terminal path
 * (cost-recording posture).
 */
import { readOp, isInteractiveHostOpType } from "../ops/op-store.js";
import { getSessionForOp, listOpsForSession } from "../ops/session-bridge.js";
import { isHeadlessSession } from "../chat-ws/broadcast.js";
import { markTaskTrashScopeClosed } from "../safe-delete.js";
import type { CanonicalEvent } from "./types.js";

import { createLogger } from "../logger.js";
const logger = createLogger("canonical-loop.trash-scope-observer");

let warnedOnce = false;

/**
 * Is this session id a MACHINE-run session — one whose task-trash scope may
 * be auto-closed when its last live op terminates? Two canonical families:
 *
 *   `agent-*`  the delegated sub-agent runtime family. Minted as
 *              `agent-<runId>` per FieldAgent run (server/handler-events.ts:
 *              runSessionId = req.sessionId ?? `agent-<agentId>`; also
 *              agents/invoke.ts) and borrowed as `agent-op-<opId>` for
 *              operations-executor phases (agency/handler-types.ts
 *              runSessionId). The Handler validates the family back to a live
 *              run (agents/escalate-tool.ts resolveCallerAgentId →
 *              Handler.getAgentStatus), and the worktree path-rewriter keys
 *              on the same prefix (tool-execution/enforce-policy.ts
 *              rewriteWorktreePaths).
 *   headless   the synthetic no-user runs — eval_ / skill-review- / dream- —
 *              via chat-ws/broadcast.ts isHeadlessSession (the canonical
 *              prefix list; never re-declare it). cron- is deliberately NOT
 *              headless there and NOT worker-scoped here: a cron job is a
 *              USER-SCHEDULED task and its trash keeps the user-grade window.
 *
 * Everything else is a user surface and must never have its scope auto-closed.
 */
export function isWorkerScopedSession(sessionId: string): boolean {
	return sessionId.startsWith("agent-") || isHeadlessSession(sessionId);
}

export function recordTrashScopeEvent(event: CanonicalEvent, sessionOverride?: string): void {
	try {
		if (event.type !== "state_changed") return;
		const to = ((event.body ?? {}) as Record<string, unknown>).to;
		if (to !== "succeeded" && to !== "failed" && to !== "cancelled") return;

		const op = readOp(event.opId);
		// Unreadable op → type unknowable → do nothing: an interactive turn
		// must never close a scope by accident, so unknown fails toward open.
		if (!op?.type || isInteractiveHostOpType(op.type)) return;

		// Same session resolution as the bridge observer: the relay path hands
		// an explicit session for events projected on behalf of a worker
		// process; everything else resolves through the submit-time tracking.
		const sessionId = sessionOverride ?? getSessionForOp(event.opId);
		if (!sessionId) return; // op wasn't submitted by a session — no scope to close

		// THE invariant (see header): only a worker-family session's scope may
		// auto-close. A chat/ide/cron/bridge/voice session hosting delegated
		// ops keeps its scope open regardless of op traffic.
		if (!isWorkerScopedSession(sessionId)) return;

		// A live peer defers the close — the session's task is still running
		// elsewhere. The terminating op itself is excluded (see ORDER above).
		if (listOpsForSession(sessionId).some((id) => id !== event.opId)) return;

		markTaskTrashScopeClosed(sessionId);
	} catch (e) {
		if (!warnedOnce) {
			warnedOnce = true;
			logger.warn(`[trash-scope] event hook failed (further suppressed): ${(e as Error).message}`);
		}
	}
}

/** Test-only: reset the warn-once latch. */
export function _resetTrashScopeObserverForTests(): void {
	warnedOnce = false;
}
