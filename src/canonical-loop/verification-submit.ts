/**
 * Verification-op submission — the heavy half of verification-trigger.ts,
 * loaded lazily on the first candidate so the trigger observer stays cheap.
 *
 * OP SHAPE: mirrors the delegated-op pipeline that ACTUALLY RUNS
 * (ops/tools/op-submit-async.ts → ops/tools/shared.ts buildOpFromArgs +
 * configureDelegatedRuntime). The canonical runtime does NOT dispatch by an
 * op-type registry — runtime.ts resolves adapter factories per op id, else
 * per lane — so a runnable op needs its OWN provider-exact sealed descriptor,
 * registered adapter factory, and installed tool runtime (the delegated
 * worker belt: read/web/spreadsheet/document tools, no op_submit* — exactly
 * the surface the verification brief's mandate needs). ops/tools/shared.ts
 * itself must not be imported from canonical-loop (it imports canonical-loop
 * internals — the interface-seal's known violation, being fixed in a parallel
 * chunk), so the construction is mirrored here from canonical-loop's own
 * seams; agent-runner/run.ts is the in-module precedent for the resolve →
 * seal → register → install → entry sequence.
 *
 * SESSION SPLIT (the anti-compounding invariant): the verifier's TOOL RUNTIME
 * runs under its own worker-scoped borrowed session `agent-op-<opId>` (the
 * operations-executor precedent, agency/handler-types.ts), so its web-fetch
 * ingestion marks and any files it writes land in ITS bucket — never growing
 * the parent session's sticky ingestion/artifact registries that feed the
 * trigger. The op is TRACKED (trackOpForSession) under the PARENT session,
 * and op.sessionId / canonical.sessionId stay the parent too, so AGENTS
 * cards, bg_op_completed, and pending notifications all route to the chat
 * that owns the deliverable. Read access is unaffected by the split: the
 * fresh SecurityLayer below starts with an empty per-session allow-set under
 * EITHER session id, and deliverable reads ride the workspace-floor file
 * access mode, which is session-independent. Intentional consequence:
 * canonical.sessionId ≠ descriptor.sessionId makes the op INELIGIBLE for the
 * process execution backend (process-execution-backend.ts isEligible), so it
 * runs on the default in-process backend — which is also what lets the
 * parent-session projection resolve through the live session map.
 *
 * FAILURE POSTURE: if the provider/runtime cannot be resolved, the op is NOT
 * submitted at all — no silent fallback onto the toolless lane-default
 * adapter, which could only produce a meaningless UNVERIFIABLE verdict. One
 * warn, skip; the set stays fingerprint-recorded (no retry storm) and the
 * next actual deliverable change re-fires.
 */
import { getRuntimeConfig } from "../config.js";
import { getLaxDir } from "../lax-data-dir.js";
import { getOrInitSecretsStore } from "../secrets.js";
import { resolveCredential } from "../auth/resolve.js";
import { resolveProvider } from "../agent-request/resolve-provider.js";
import { SecurityLayer } from "../security/index.js";
import { loadFileAccessModeAtLeast } from "../security/layer/index.js";
import { loadToolPolicy } from "../tool-policy/index.js";
import { DELEGATED_WORKER_PROMPT } from "../server/background-jobs/prompts.js";
import { buildContextPack } from "../ops/context-pack-builder.js";
import { getRetryPolicy } from "../ops/heartbeat.js";
import { newOpId, readOp } from "../ops/op-store.js";
import { broadcastToSession, trackOpForSession } from "../ops/session-bridge.js";
import { delegatedToolsetForOp } from "../ops/tools/delegated-toolset.js";
import type { Op, OpBudget, OpVisibility } from "../ops/types.js";
import { buildVerificationBrief } from "./verification-brief.js";
import { VERIFICATION_OP_TYPE, type VerificationSubmitInput } from "./verification-spend.js";
import { createProviderAdapterFactory, resolveProviderRuntime } from "./provider-adapter-factory.js";
import { sealDelegatedRuntime } from "./runtime-integrity.js";
import { registerAdapterForOp } from "./runtime.js";
import { buildAgentRuntimeSurface, installOpToolRuntime } from "./agent-runner/runtime-surface.js";
import { canonicalLoopEntry } from "./index.js";
import { opCancel } from "./control-api.js";
import { isTerminalCanonicalState } from "./state-machine.js";

import { createLogger } from "../logger.js";
const logger = createLogger("canonical-loop.verification-submit");

/**
 * Budget for a verification pass. HONEST ACCOUNT of what binds on the
 * background lane:
 *   - maxTokens BINDS: worker.ts enforces a positive cumulative-token
 *     ceiling on every lane (running → failed max_tokens_exceeded).
 *   - maxWallTimeMs BINDS — but via THIS module's deadline timer
 *     (armVerificationDeadline → opCancel), not the worker's wall-clock
 *     timer, which arms on the interactive lane ONLY, by documented design
 *     ("Autonomous lanes are governed by progress middleware", worker.ts).
 *     That design was left alone: every delegated build/background op
 *     carries buildContextPack's 15-minute default maxWallTimeMs today and
 *     relies on it NOT binding (a 15-min hard kill would fail ordinary long
 *     builds), so enforce-when-present in worker.ts was rejected in favor of
 *     an explicit deadline at this submit seam.
 *   - maxIterations does NOT cap on the background lane — worker.ts treats
 *     it as a CHECKPOINT CADENCE there (emits iteration_checkpoint and
 *     resets the counter). 12 is therefore the verifier's checkpoint cadence;
 *     the real run bounds are the token ceiling and the deadline above.
 *   - maxSelfEditCalls: 0 — the belt has no self_edit tool anyway.
 */
export const VERIFICATION_OP_BUDGET: OpBudget = {
	maxIterations: 12,
	maxTokens: 80_000,
	maxWallTimeMs: 300_000,
	maxSelfEditCalls: 0,
};

/** The verifier's borrowed worker-scoped runtime session (see SESSION SPLIT
 *  in the module header). isWorkerScopedSession() recognizes the `agent-`
 *  prefix, so the trash-scope observer treats it as machine-run too. */
export function verificationRuntimeSessionId(opId: string): string {
	return `agent-op-${opId}`;
}

/** One-line AGENTS-panel label (trackOpForSession); the full brief stays on
 *  op.task, where the worker seeds from — an 8KB mandate is not a card title. */
function panelLabel(parentTask: string): string {
	const oneLine = parentTask.replace(/\s+/g, " ").trim() || "(unknown task)";
	return `Verification pass: ${oneLine.length > 160 ? `${oneLine.slice(0, 160)}…` : oneLine}`;
}

/** Build the verification Op — shape pinned by verification-submit.test.ts.
 *  Exported separately so the shape is testable without runtime resolution. */
export async function buildVerificationOp(input: VerificationSubmitInput): Promise<Op> {
	const task = buildVerificationBrief({
		deliverables: input.deliverables,
		parentTask: input.parentOp.task,
	});
	const contextPack = await buildContextPack({
		description: task,
		lane: "background",
		budget: { ...VERIFICATION_OP_BUDGET },
	});
	return {
		id: newOpId(`op_${VERIFICATION_OP_TYPE}`),
		sessionId: input.sessionId,
		type: VERIFICATION_OP_TYPE,
		task,
		contextPack,
		lane: "background",
		retryPolicy: getRetryPolicy(VERIFICATION_OP_TYPE),
		ownerId: "local-user",
		visibility: "private" as OpVisibility,
		status: "pending",
		createdAt: new Date().toISOString(),
		attemptCount: 0,
		// Spawn lineage: the AGENTS panel nests this op under the op whose
		// deliverables it audits (dedup is fingerprint-based, not lineage-based).
		parentOpId: input.parentOp.id,
		// Harness-composed task text: the instruction-ledger middleware must
		// not mine the mandate prose for user constraints (see Op.taskProvenance).
		taskProvenance: "harness",
	};
}

/**
 * Resolve and pin the exact provider/model/runtime, then install the per-op
 * adapter factory and tool runtime UNDER THE VERIFIER'S OWN worker-scoped
 * session (module header). Mirror of ops/tools/shared.ts
 * configureDelegatedRuntime (see header for why it cannot be imported) on the
 * background-lane worker belt.
 */
async function configureVerificationRuntime(op: Op, runtimeSessionId: string): Promise<void> {
	const dataDir = getLaxDir();
	const resolved = await resolveProvider(
		getRuntimeConfig(),
		getOrInitSecretsStore(dataDir),
		dataDir,
		op.contextPack.routing.preferredProvider,
	);
	const runtime = await resolveProviderRuntime(resolved.provider as import("../providers/provider-ids.js").ProviderId, resolved.model, {
		apiKey: resolved.apiKey,
		authSource: resolved.authSource ?? (() => { throw new Error("provider credential source was not resolved"); })(),
		customBaseURL: resolved.customBaseURL,
	});
	let authSource = runtime.identity.authSource;
	let apiKey = runtime.apiKey;
	if (runtime.identity.credentialProvider !== resolved.provider) {
		const credential = await resolveCredential(runtime.identity.credentialProvider);
		if (!credential || credential.credential !== runtime.apiKey) throw new Error("resolved runtime credential does not match its canonical credential source");
		authSource = credential.source;
		apiKey = credential.credential;
	}
	const tools = delegatedToolsetForOp("background");
	const security = new SecurityLayer(getRuntimeConfig().workspace, loadFileAccessModeAtLeast("workspace"));
	const toolPolicy = loadToolPolicy(dataDir);
	const surfaceOptions = {
		systemPrompt: DELEGATED_WORKER_PROMPT,
		tools,
		security,
		toolPolicy,
		callContext: "delegated" as const,
	};
	op.runtimeDescriptor = sealDelegatedRuntime(op.id, {
		kind: "delegated-op",
		adapter: "provider-exact",
		...runtime.identity,
		authSource,
		sessionId: runtimeSessionId,
		surface: buildAgentRuntimeSurface(surfaceOptions, runtimeSessionId),
	});
	op.model = runtime.identity.model;
	const factory = await createProviderAdapterFactory(op.runtimeDescriptor, {
		apiKey,
		authSource,
		customBaseURL: resolved.customBaseURL,
		sessionId: runtimeSessionId,
		systemPrompt: DELEGATED_WORKER_PROMPT,
		requireToolOnFirstTurn: true,
	});
	registerAdapterForOp(op.id, factory);
	installOpToolRuntime(op, {
		tools,
		security,
		toolPolicy,
		sessionId: runtimeSessionId,
		callContext: "delegated",
		onEvent: (event) => broadcastToSession(runtimeSessionId, event),
	});
}

/**
 * Arm the wall-time deadline for a submitted verification op: after `ms`,
 * a still-live op is cancelled through the canonical control API. opCancel
 * is terminal-guarded and idempotent, so firing after natural completion is
 * a no-op; the timer is unref'd so it never holds the process open. This is
 * what makes VERIFICATION_OP_BUDGET.maxWallTimeMs actually bind (see the
 * budget doc — the worker's own wall clock is interactive-lane-only).
 */
export function armVerificationDeadline(opId: string, ms: number): void {
	const timer = setTimeout(() => {
		try {
			const state = readOp(opId)?.canonical?.state;
			if (state && isTerminalCanonicalState(state)) return;
			const result = opCancel(opId, "verification-deadline");
			if (result.ok) logger.warn(`[verify] ${opId} exceeded maxWallTimeMs=${ms} — cancelled`);
		} catch (e) {
			logger.warn(`[verify] deadline enforcement failed for ${opId}: ${(e as Error).message}`);
		}
	}, ms);
	timer.unref?.();
}

/**
 * Submit the verification op for a completed parent (trigger has already
 * gated on setting, dedup, and delta). Returns true when an op was actually
 * submitted. Never throws — the trigger fires this and forgets.
 */
export async function submitVerificationOp(input: VerificationSubmitInput): Promise<boolean> {
	try {
		const op = await buildVerificationOp(input);
		// Runtime before visibility (agent-runner/run.ts posture): a failed
		// credential/endpoint/surface must not leave a ghost operation.
		await configureVerificationRuntime(op, verificationRuntimeSessionId(op.id));
		canonicalLoopEntry(op, { sessionId: input.sessionId, confirmRunning: false });
		trackOpForSession(op.id, input.sessionId, panelLabel(input.parentOp.task));
		armVerificationDeadline(op.id, VERIFICATION_OP_BUDGET.maxWallTimeMs);
		logger.info(
			`[verify] submitted ${op.id} (parent=${input.parentOp.id}, lane=background, `
			+ `${input.deliverables.length} changed deliverable${input.deliverables.length === 1 ? "" : "s"})`,
		);
		return true;
	} catch (e) {
		logger.warn(`[verify] could not submit verification for ${input.parentOp.id}: ${(e as Error).message}`);
		return false;
	}
}
