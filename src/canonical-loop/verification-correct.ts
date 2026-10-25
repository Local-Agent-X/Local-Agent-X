/**
 * Deliverable correction — what follows a DISCREPANCIES verdict.
 *
 * The verification pass (verification-submit.ts) is the harness checking the
 * agent's own work. When it finds figures that do not match their sources,
 * the right next step is the agent's, not the user's: correct the deliverable
 * from the independent sources and say so in a line. This module submits
 * that correction as a build-lane worker whose work root is the folder the
 * deliverables share, so it holds the write tools for exactly those files.
 *
 * BOUND: one automatic correction per deliverable set. The corrected file is
 * a changed deliverable, so the trigger re-verifies it (the proof the
 * correction took); a verdict on THAT pass never corrects again, it goes to
 * the agent as a rework instruction (session-bridge-verification.ts). Without
 * the bound a figure no source can settle would correct forever.
 *
 * Shape and posture mirror verification-submit.ts: the op is built, its
 * runtime resolved and installed BEFORE it becomes visible, and a runtime
 * that cannot be resolved means no op at all (the agent is told instead).
 */
import { dirname, sep } from "node:path";
import { getRuntimeConfig } from "../config.js";
import { SecurityLayer } from "../security/index.js";
import { loadFileAccessModeAtLeast } from "../security/layer/index.js";
import { delegatedWorkerPrompt } from "../server/background-jobs/prompts.js";
import { buildContextPack } from "../ops/context-pack-builder.js";
import { getRetryPolicy } from "../ops/heartbeat.js";
import { newOpId } from "../ops/op-store.js";
import { OP_TYPE } from "../ops/op-types.js";
import { trackOpForSession } from "../ops/session-bridge.js";
import { delegatedToolsetForOp } from "../ops/tools/delegated-toolset.js";
import type { Op, OpVisibility } from "../ops/types.js";
import { setSessionWorkRoot } from "../workspace/paths.js";
import { VERIFICATION_OP_BUDGET, verificationTargetOf } from "./verification-submit.js";
import { armWorkerOpDeadline, configureWorkerOpRuntime } from "./worker-op-runtime.js";
import { canonicalLoopEntry } from "./index.js";

import { createLogger } from "../logger.js";
const logger = createLogger("canonical-loop.verification-correct");

export const CORRECTION_OP_TYPE = OP_TYPE.correctDeliverable;

/** What a correction op was asked to fix, kept for the surfacing that follows
 *  its terminal (the user hears how many figures moved; a failed correction
 *  hands the agent the same table as a rework instruction). */
export interface CorrectionContext {
	parentTask: string;
	deliverables: string[];
	table: string;
	mismatched: number;
	checked: number;
}

const CONTEXTS = new Map<string, CorrectionContext>();

export function correctionContextOf(opId: string): CorrectionContext | undefined {
	return CONTEXTS.get(opId);
}

/** The deepest folder every deliverable sits under: the correction's work root. */
export function commonAncestorDir(paths: string[]): string {
	const split = (p: string) => dirname(p).split(/[\\/]+/);
	let common = split(paths[0]);
	for (const p of paths.slice(1)) {
		const parts = split(p);
		let i = 0;
		while (i < common.length && i < parts.length && common[i].toLowerCase() === parts[i].toLowerCase()) i++;
		common = common.slice(0, i);
	}
	return common.join(sep) || dirname(paths[0]);
}

export function buildCorrectionBrief(input: { deliverables: string[]; table: string; parentTask: string }): string {
	return [
		"An independent re-check of a deliverable you built found figures that do not match their sources. Correct them.",
		"",
		`The task the deliverable came from: ${input.parentTask.replace(/\s+/g, " ").trim().slice(0, 300)}`,
		"",
		"Deliverables (absolute paths; edit these and nothing else):",
		...input.deliverables.map((p) => `- ${p}`),
		"",
		"The re-check's table (value, what the deliverable says, what the independent source says, match?):",
		input.table.trim(),
		"",
		"Mandate:",
		"1. For each row whose match column says no, change the deliverable's value to the independent source's value. Use the `edit` tool for text and markdown, the `spreadsheet` tool for spreadsheets, the `document` tool for documents.",
		"2. If the table does not give enough to settle a value, re-fetch the source with web_fetch and use what it states today.",
		"3. Change nothing else: no rewording, no new sections, no reformatting.",
		"",
		"Output contract:",
		"The FIRST line of your final answer MUST be `CORRECTED: <n> values` or `COULD NOT CORRECT: <why>`.",
		"Then one line per value you changed: value, old, new.",
	].join("\n");
}

export async function buildCorrectionOp(input: {
	sessionId: string;
	parentOp: Op;
	verificationOpId: string;
	deliverables: string[];
	table: string;
}): Promise<Op> {
	const task = buildCorrectionBrief({ deliverables: input.deliverables, table: input.table, parentTask: input.parentOp.task });
	const workRoot = commonAncestorDir(input.deliverables);
	const contextPack = await buildContextPack({
		description: task,
		lane: "build",
		budget: { ...VERIFICATION_OP_BUDGET },
	});
	contextPack.routing.workRoot = workRoot;
	return {
		id: newOpId(`op_${CORRECTION_OP_TYPE}`),
		sessionId: input.sessionId,
		type: CORRECTION_OP_TYPE,
		task,
		contextPack,
		lane: "build",
		retryPolicy: getRetryPolicy(CORRECTION_OP_TYPE),
		ownerId: "local-user",
		visibility: "private" as OpVisibility,
		status: "pending",
		createdAt: new Date().toISOString(),
		attemptCount: 0,
		// Nested under the op whose deliverables it corrects, the same parent
		// the verification pass hangs off; the verification op itself is the
		// bound's marker (see attemptDeliverableCorrection).
		parentOpId: input.parentOp.id,
		taskProvenance: "harness",
	};
}

/**
 * Submit a correction for a verification pass that found discrepancies.
 * Returns false, submitting nothing, when the verification's parent was
 * itself a correction (the bound), when the pass's target is unknown (a
 * restart since submit), or when the runtime cannot be resolved. The caller
 * hands the agent a rework instruction in every false case.
 */
export async function attemptDeliverableCorrection(input: {
	verificationOpId: string;
	sessionId: string;
	verdictText: string;
	mismatched: number;
	checked: number;
}): Promise<boolean> {
	const target = verificationTargetOf(input.verificationOpId);
	if (!target) {
		logger.info(`[correct] no target recorded for ${input.verificationOpId} — the agent is told instead`);
		return false;
	}
	if (target.parentOp.type === CORRECTION_OP_TYPE) {
		logger.info(`[correct] ${input.verificationOpId} re-checked a correction and still found discrepancies — not correcting again`);
		return false;
	}
	try {
		const op = await buildCorrectionOp({
			sessionId: input.sessionId,
			parentOp: target.parentOp,
			verificationOpId: input.verificationOpId,
			deliverables: target.deliverables,
			table: input.verdictText,
		});
		const workRoot = op.contextPack.routing.workRoot!;
		// The build worker's mutation scope, registered before the surface is
		// built so recovery restores both (ops/tools/shared.ts does the same).
		const security = new SecurityLayer(getRuntimeConfig().workspace, loadFileAccessModeAtLeast("workspace"));
		security.addAllowedPath(workRoot, op.id);
		setSessionWorkRoot(op.id, workRoot);
		await configureWorkerOpRuntime(op, op.id, {
			tools: delegatedToolsetForOp("build", { workRoot }),
			systemPrompt: delegatedWorkerPrompt(workRoot),
			security,
		});
		CONTEXTS.set(op.id, {
			parentTask: target.parentOp.task,
			deliverables: target.deliverables,
			table: input.verdictText,
			mismatched: input.mismatched,
			checked: input.checked,
		});
		canonicalLoopEntry(op, { sessionId: input.sessionId, confirmRunning: false });
		trackOpForSession(op.id, input.sessionId, `Correcting figures: ${target.parentOp.task.replace(/\s+/g, " ").trim().slice(0, 160)}`);
		armWorkerOpDeadline(op.id, VERIFICATION_OP_BUDGET.maxWallTimeMs, "correction");
		logger.info(`[correct] submitted ${op.id} for ${input.verificationOpId} (${input.mismatched} of ${input.checked} values, root ${workRoot})`);
		return true;
	} catch (e) {
		logger.warn(`[correct] could not submit a correction for ${input.verificationOpId}: ${(e as Error).message}`);
		return false;
	}
}
