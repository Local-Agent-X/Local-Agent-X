/**
 * Verification-op submission — the heavy half of verification-trigger.ts,
 * loaded lazily on the first candidate so the trigger (imported by
 * event-emitter.ts at the core of the loop) stays cheap to load.
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
 * seams; agent-runner/run.ts is the in-module precedent for this exact
 * resolve → seal → register → install → canonicalLoopEntry sequence.
 *
 * FAILURE POSTURE: if the provider/runtime cannot be resolved, the op is NOT
 * submitted at all — no silent fallback onto the toolless lane-default
 * adapter, which could only produce a meaningless UNVERIFIABLE verdict. One
 * warn, skip; the deliverable simply goes unverified this time.
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
import { newOpId } from "../ops/op-store.js";
import { broadcastToSession, trackOpForSession } from "../ops/session-bridge.js";
import { delegatedToolsetForOp } from "../ops/tools/delegated-toolset.js";
import type { Op, OpBudget, OpVisibility } from "../ops/types.js";
import { buildVerificationBrief } from "./verification-brief.js";
import { VERIFICATION_OP_TYPE, type VerificationSubmitInput } from "./verification-trigger.js";
import { createProviderAdapterFactory, resolveProviderRuntime } from "./provider-adapter-factory.js";
import { sealDelegatedRuntime } from "./runtime-integrity.js";
import { registerAdapterForOp } from "./runtime.js";
import { buildAgentRuntimeSurface, installOpToolRuntime } from "./agent-runner/runtime-surface.js";
import { canonicalLoopEntry } from "./index.js";

import { createLogger } from "../logger.js";
const logger = createLogger("canonical-loop.verification-submit");

/** Hard budget for a verification pass — deliberately tight. maxTokens is a
 *  LIVE per-op cumulative ceiling (canonical-loop/worker.ts enforces positive
 *  values) and doubles as the recursion belt: even if the type marker ever
 *  broke, each runaway generation is capped at one short bounded run. */
export const VERIFICATION_OP_BUDGET: OpBudget = {
	maxIterations: 12,
	maxTokens: 80_000,
	maxWallTimeMs: 300_000,
	maxSelfEditCalls: 0,
};

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
		// deliverables it audits; the trigger's dedup keys on it too.
		parentOpId: input.parentOp.id,
		// Harness-composed task text: the instruction-ledger middleware must
		// not mine the mandate prose for user constraints (see Op.taskProvenance).
		taskProvenance: "harness",
	};
}

/**
 * Resolve and pin the exact provider/model/runtime, then install the per-op
 * adapter factory and tool runtime. Mirror of ops/tools/shared.ts
 * configureDelegatedRuntime (see module header for why it cannot be imported)
 * on the background-lane worker belt.
 */
async function configureVerificationRuntime(op: Op, sessionId: string): Promise<void> {
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
		sessionId,
		surface: buildAgentRuntimeSurface(surfaceOptions, sessionId),
	});
	op.model = runtime.identity.model;
	const factory = await createProviderAdapterFactory(op.runtimeDescriptor, {
		apiKey,
		authSource,
		customBaseURL: resolved.customBaseURL,
		sessionId,
		systemPrompt: DELEGATED_WORKER_PROMPT,
		requireToolOnFirstTurn: true,
	});
	registerAdapterForOp(op.id, factory);
	installOpToolRuntime(op, {
		tools,
		security,
		toolPolicy,
		sessionId,
		callContext: "delegated",
		onEvent: (event) => broadcastToSession(sessionId, event),
	});
}

/**
 * Submit the verification op for a completed parent. Returns true when an op
 * was actually submitted. Never throws — the trigger fires this and forgets.
 */
export async function submitVerificationOp(input: VerificationSubmitInput): Promise<boolean> {
	try {
		// Condition 5 of the trigger chain — the runtime setting, consulted
		// LIVE (settings mirror keeps runtime config current on save).
		if (!getRuntimeConfig().verifyDeliverables) {
			logger.debug(`[verify] skip ${input.parentOp.id}: verifyDeliverables setting is off`);
			return false;
		}
		const op = await buildVerificationOp(input);
		// Runtime before visibility (agent-runner/run.ts posture): a failed
		// credential/endpoint/surface must not leave a ghost operation.
		await configureVerificationRuntime(op, input.sessionId);
		canonicalLoopEntry(op, { sessionId: input.sessionId, confirmRunning: false });
		trackOpForSession(op.id, input.sessionId, panelLabel(input.parentOp.task));
		logger.info(
			`[verify] submitted ${op.id} (parent=${input.parentOp.id}, lane=background, `
			+ `${input.deliverables.length} deliverable${input.deliverables.length === 1 ? "" : "s"})`,
		);
		return true;
	} catch (e) {
		logger.warn(`[verify] could not submit verification for ${input.parentOp.id}: ${(e as Error).message}`);
		return false;
	}
}
