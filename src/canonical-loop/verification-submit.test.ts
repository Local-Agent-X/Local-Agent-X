/**
 * verification-submit — the op shape that actually runs, and the gates around
 * submitting it.
 *
 * Pins:
 *   - buildVerificationOp: type/lane/parentOpId/taskProvenance/budget pinned
 *     exactly; the task carries the brief's verbatim VERDICT contract line.
 *   - the verifyDeliverables runtime setting gates submission (condition 5).
 *   - runtime-resolution failure → NO submission and NO ghost op (no silent
 *     fallback onto the toolless lane-default adapter), and never throws.
 *   - full submit (provider chain faked at the resolveProvider /
 *     createProviderAdapterFactory seams): the op is entered into the real
 *     canonical scheduler, tracked to the session under a short panel label,
 *     runs to `succeeded` on the fake adapter — and its own success does NOT
 *     spawn a second verification op (recursion guard, end to end).
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Adapter } from "./adapter-contract.js";
import type { Op } from "../ops/types.js";

const prevLaxDir = process.env.LAX_DATA_DIR;
const laxDir = mkdtempSync(join(tmpdir(), "lax-verify-submit-"));
process.env.LAX_DATA_DIR = laxDir;
// A background-lane op with an exact delegated runtime is eligible for the
// PROCESS execution backend (process-execution-backend.ts isEligible — the
// production path), which needs a child worker pool this test doesn't run.
// Force the in-process backend so the fake adapter drives the op here.
const prevBackend = process.env.LAX_CANONICAL_EXECUTION_BACKEND;
process.env.LAX_CANONICAL_EXECUTION_BACKEND = "in-process";
afterAll(() => {
	if (prevLaxDir === undefined) delete process.env.LAX_DATA_DIR;
	else process.env.LAX_DATA_DIR = prevLaxDir;
	if (prevBackend === undefined) delete process.env.LAX_CANONICAL_EXECUTION_BACKEND;
	else process.env.LAX_CANONICAL_EXECUTION_BACKEND = prevBackend;
	rmSync(laxDir, { recursive: true, force: true });
});

const mocks = vi.hoisted(() => ({
	resolveProvider: (..._args: unknown[]): unknown => { throw new Error("resolveProvider mock unset"); },
	adapterFactory: null as null | (() => Adapter),
}));

// Deterministic provider chain: no keychain (secrets store), no configured
// credentials (resolveProvider), no real provider adapter (factory). Spread
// importOriginal so every other export (assertExactDelegatedRuntime etc.,
// which runtime.ts pulls from the same module) stays real.
vi.mock("../secrets.js", async (importOriginal) => ({
	...(await importOriginal<object>()),
	getOrInitSecretsStore: () => ({}) as never,
}));
vi.mock("../agent-request/resolve-provider.js", async (importOriginal) => ({
	...(await importOriginal<object>()),
	resolveProvider: (...args: unknown[]) => Promise.resolve(mocks.resolveProvider(...args)),
}));
vi.mock("./provider-adapter-factory.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("./provider-adapter-factory.js")>();
	return {
		...original,
		createProviderAdapterFactory: async (
			...args: Parameters<typeof original.createProviderAdapterFactory>
		) => (mocks.adapterFactory ? mocks.adapterFactory : original.createProviderAdapterFactory(...args)),
	};
});

const { submitVerificationOp, buildVerificationOp, VERIFICATION_OP_BUDGET } = await import("./verification-submit.js");
const { VERIFICATION_OP_TYPE } = await import("./verification-trigger.js");
const { awaitCanonicalOp, resetCanonicalRuntime, resetScheduler } = await import("./index.js");
const { getRuntimeConfig, setRuntimeConfig } = await import("../config.js");
const { listOpsForSession, getTaskForOp, releaseOpFromSession } = await import("../ops/session-bridge.js");
const { readOp } = await import("../ops/op-store.js");
const { cancelIdleNudge } = await import("../ops/idle-nudge.js");

afterAll(() => {
	resetCanonicalRuntime();
	resetScheduler();
});

const PARENT_TASK = "Build the GaN market-share spreadsheet from vendor filings";
function parentOp(id: string): Op {
	return { id, type: "freeform", task: PARENT_TASK } as never;
}
const DELIVERABLE = join(laxDir, "gan-market-share.xlsx");

function verifyOpDirs(): string[] {
	try {
		return readdirSync(join(laxDir, "operations")).filter((d) => d.startsWith(`op_${VERIFICATION_OP_TYPE}`));
	} catch {
		return [];
	}
}

/** One-turn scripted verifier: immediately finalizes a verdict and ends. */
function fakeVerifierAdapter(): Adapter {
	return {
		name: "fake-verifier",
		version: "1",
		async runTurn(_input, report) {
			report({
				kind: "message_finalized",
				message: { messageId: "vm-0", role: "assistant", content: { text: "VERDICT: CONFIRMED\nall values matched" } },
			});
			return {
				providerState: { adapterName: "fake-verifier", adapterVersion: "1", providerPayload: null },
				terminalReason: "done",
				modelStop: "ended",
			};
		},
		async abort(): Promise<void> { /* scripted — nothing in flight */ },
	};
}

describe("buildVerificationOp — the pinned op shape", () => {
	it("stamps type, lane, parentOpId, provenance, budget, and the VERDICT contract", async () => {
		const op = await buildVerificationOp({
			parentOp: parentOp("op_parent_shape"),
			sessionId: "sess-verify-shape",
			deliverables: [DELIVERABLE],
		});
		expect(op.id.startsWith(`op_${VERIFICATION_OP_TYPE}`)).toBe(true);
		expect(op.type).toBe(VERIFICATION_OP_TYPE);
		expect(op.lane).toBe("background");
		expect(op.contextPack.routing.lane).toBe("background");
		expect(op.sessionId).toBe("sess-verify-shape");
		expect(op.parentOpId).toBe("op_parent_shape");
		expect(op.taskProvenance).toBe("harness");
		expect(op.status).toBe("pending");
		expect(op.attemptCount).toBe(0);
		expect(op.retryPolicy).toBeDefined();
		expect(op.contextPack.budget).toEqual(VERIFICATION_OP_BUDGET);
		expect(VERIFICATION_OP_BUDGET).toEqual({
			maxIterations: 12,
			maxTokens: 80_000,
			maxWallTimeMs: 300_000,
			maxSelfEditCalls: 0,
		});
		// The brief IS the task: verbatim output contract + the deliverable +
		// the parent task line all present (buildVerificationBrief contract).
		expect(op.task).toContain("VERDICT: CONFIRMED | DISCREPANCIES | UNVERIFIABLE");
		expect(op.task).toContain(DELIVERABLE);
		expect(op.task).toContain(PARENT_TASK);
		expect(op.contextPack.task.description).toBe(op.task);
	});
});

describe("submitVerificationOp — gates and posture", () => {
	it("skips when the verifyDeliverables runtime setting is off", async () => {
		const cfg = getRuntimeConfig();
		setRuntimeConfig({ ...cfg, verifyDeliverables: false });
		try {
			const submitted = await submitVerificationOp({
				parentOp: parentOp("op_parent_off"),
				sessionId: "sess-verify-off",
				deliverables: [DELIVERABLE],
			});
			expect(submitted).toBe(false);
			expect(verifyOpDirs()).toEqual([]);
			expect(listOpsForSession("sess-verify-off")).toEqual([]);
		} finally {
			setRuntimeConfig({ ...cfg, verifyDeliverables: true });
		}
	});

	it("does not submit (and never throws) when the provider runtime cannot be resolved", async () => {
		mocks.resolveProvider = () => { throw new Error("no provider configured"); };
		const submitted = await submitVerificationOp({
			parentOp: parentOp("op_parent_noprov"),
			sessionId: "sess-verify-noprov",
			deliverables: [DELIVERABLE],
		});
		expect(submitted).toBe(false);
		// No ghost op: nothing persisted, nothing tracked, no fallback onto a
		// toolless lane-default adapter.
		expect(verifyOpDirs()).toEqual([]);
		expect(listOpsForSession("sess-verify-noprov")).toEqual([]);
	});

	it("submits a runnable background op that completes on the canonical scheduler", async () => {
		mocks.resolveProvider = () => ({
			provider: "anthropic",
			apiKey: "key-123",
			model: "fake-verify-model",
			authSource: "config",
		});
		mocks.adapterFactory = () => fakeVerifierAdapter();
		const sessionId = "sess-verify-full";
		try {
			const submitted = await submitVerificationOp({
				parentOp: parentOp("op_parent_full"),
				sessionId,
				deliverables: [DELIVERABLE],
			});
			expect(submitted).toBe(true);

			const dirs = verifyOpDirs();
			expect(dirs).toHaveLength(1);
			const opId = listOpsForSession(sessionId).find((id) => id.startsWith(`op_${VERIFICATION_OP_TYPE}`));
			expect(opId).toBeDefined();
			// AGENTS-panel label is the short line, not the 8KB brief.
			expect(getTaskForOp(opId!)).toBe(`Verification pass: ${PARENT_TASK}`);

			const persisted = readOp(opId!);
			expect(persisted?.parentOpId).toBe("op_parent_full");
			expect(persisted?.lane).toBe("background");
			expect(persisted?.model).toBe("fake-verify-model");
			expect(persisted?.runtimeDescriptor?.kind).toBe("delegated-op");

			const result = await awaitCanonicalOp(opId!, 10_000);
			expect(result?.status).toBe("completed");

			// Recursion guard, end to end: the verification op's own success
			// event ran through the trigger and must not have spawned a second
			// verification op.
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(verifyOpDirs()).toHaveLength(1);
		} finally {
			mocks.adapterFactory = null;
			for (const id of listOpsForSession(sessionId)) releaseOpFromSession(id);
			cancelIdleNudge(sessionId);
		}
	});
});
