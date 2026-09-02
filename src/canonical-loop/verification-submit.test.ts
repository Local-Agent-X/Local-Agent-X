/**
 * verification-submit — the op shape that actually runs, and the bounds and
 * session split around it.
 *
 * Pins:
 *   - buildVerificationOp: type/lane/parentOpId/taskProvenance/budget pinned
 *     exactly; the task carries the brief's verbatim VERDICT contract line.
 *   - SESSION SPLIT (the anti-compounding invariant): the sealed runtime
 *     descriptor — and therefore the installed tool runtime, whose session id
 *     feeds the data-lineage recorders — carries the verifier's OWN
 *     worker-scoped session `agent-op-<opId>`, while tracking/canonical
 *     session stay the PARENT chat session (cards + notifications flow), and
 *     the parent's artifact registry is untouched by the run.
 *   - runtime-resolution failure → NO submission and NO ghost op (no silent
 *     fallback onto the toolless lane-default adapter), and never throws.
 *   - full submit (provider chain faked at the resolveProvider /
 *     createProviderAdapterFactory seams): the op enters the real canonical
 *     scheduler — the session split makes it process-backend INELIGIBLE, so
 *     the default in-process backend drives it — runs to `succeeded` on the
 *     fake adapter, and its own success does NOT spawn a second verification
 *     op (recursion guard, end to end).
 *   - the wall-time deadline BINDS: armVerificationDeadline cancels a
 *     still-running verify op through opCancel, and is a no-op on one that
 *     already finished (the worker's own wall clock is interactive-only by
 *     design, so this seam is what makes maxWallTimeMs honest).
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Adapter, AdapterReport, TurnResult } from "./adapter-contract.js";
import type { Op } from "../ops/types.js";

const prevLaxDir = process.env.LAX_DATA_DIR;
const laxDir = mkdtempSync(join(tmpdir(), "lax-verify-submit-"));
process.env.LAX_DATA_DIR = laxDir;
afterAll(() => {
	if (prevLaxDir === undefined) delete process.env.LAX_DATA_DIR;
	else process.env.LAX_DATA_DIR = prevLaxDir;
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

const {
	submitVerificationOp,
	buildVerificationOp,
	armVerificationDeadline,
	verificationRuntimeSessionId,
	VERIFICATION_OP_BUDGET,
} = await import("./verification-submit.js");
const { VERIFICATION_OP_TYPE } = await import("./verification-trigger.js");
const { awaitCanonicalOp, canonicalLoopEntry, registerAdapterForOp, resetCanonicalRuntime, resetScheduler } = await import("./index.js");
const { listOpsForSession, getTaskForOp, releaseOpFromSession } = await import("../ops/session-bridge.js");
const { readOp } = await import("../ops/op-store.js");
const { cancelIdleNudge } = await import("../ops/idle-nudge.js");
const { listTaskArtifacts, recordTaskArtifact, clearTaskArtifacts } = await import("../data-lineage/task-artifacts.js");

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

/** Streams until aborted — compact stand-in for the test/ fake-adapter's
 *  scriptLongStreamingTurn (that helper lives outside tsc's src rootDir).
 *  Same abort semantics: cooperative polling, error report + terminalReason
 *  "error" when preempted. */
function hangingAdapter(): Adapter & { abortCalls: number } {
	const providerState = { adapterName: "fake-hanging", adapterVersion: "1", providerPayload: null };
	const adapter = {
		name: "fake-hanging",
		version: "1",
		abortCalls: 0,
		aborted: false,
		async runTurn(_input: unknown, report: (r: AdapterReport) => void): Promise<TurnResult> {
			for (let i = 0; i < 500 && !adapter.aborted; i++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			if (adapter.aborted) {
				report({ kind: "error", code: "aborted", message: "adapter aborted mid-stream", retryable: false });
				return { providerState, terminalReason: "error" };
			}
			report({ kind: "message_finalized", message: { messageId: "hm-0", role: "assistant", content: { text: "never reached in tests" } } });
			return { providerState, terminalReason: "done", modelStop: "ended" };
		},
		async abort(): Promise<void> { adapter.abortCalls++; adapter.aborted = true; },
	};
	return adapter;
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
		// Honest-budget doc pins: tokens bind in the worker; wall time binds
		// via armVerificationDeadline; maxIterations is checkpoint cadence on
		// the background lane, not a cap.
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

describe("submitVerificationOp — posture, session split, and the full run", () => {
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

	it("submits a runnable background op — parent-tracked, own-session runtime — that completes in-process", async () => {
		mocks.resolveProvider = () => ({
			provider: "anthropic",
			apiKey: "key-123",
			model: "fake-verify-model",
			authSource: "config",
		});
		mocks.adapterFactory = () => fakeVerifierAdapter();
		const sessionId = "sess-verify-full";
		// Compounding probe: the parent's artifact registry must be untouched
		// by the verifier's run.
		recordTaskArtifact(sessionId, DELIVERABLE);
		const parentArtifactsBefore = listTaskArtifacts(sessionId);
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
			// SESSION SPLIT: sealed runtime (→ tool runtime → data-lineage
			// recorders) under the verifier's own worker-scoped session;
			// canonical/tracking session stays the parent so projections and
			// notifications route to the chat. The mismatch also makes the op
			// process-backend ineligible → default in-process backend (which
			// is why this test needs no backend override to run it).
			expect(persisted?.runtimeDescriptor?.kind).toBe("delegated-op");
			expect((persisted?.runtimeDescriptor as { sessionId?: string }).sessionId)
				.toBe(verificationRuntimeSessionId(opId!));
			expect(persisted?.canonical?.sessionId).toBe(sessionId);

			const result = await awaitCanonicalOp(opId!, 10_000);
			expect(result?.status).toBe("completed");

			// Recursion guard, end to end: the verification op's own success
			// event ran through the trigger and must not have spawned a second
			// verification op.
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(verifyOpDirs()).toHaveLength(1);

			// Compounding killed: the parent's deliverable set did not grow.
			expect(listTaskArtifacts(sessionId)).toEqual(parentArtifactsBefore);
		} finally {
			mocks.adapterFactory = null;
			for (const id of listOpsForSession(sessionId)) releaseOpFromSession(id);
			clearTaskArtifacts(sessionId);
			cancelIdleNudge(sessionId);
		}
	});
});

describe("armVerificationDeadline — the wall-time bound actually binds", () => {
	it("cancels a verify op still running past the deadline", async () => {
		const op = await buildVerificationOp({
			parentOp: parentOp("op_parent_deadline"),
			sessionId: "sess-verify-deadline",
			deliverables: [DELIVERABLE],
		});
		op.model = "fake-test-model"; // configureVerificationRuntime stamps this in production; the worker refuses model-less ops
		// A turn that streams for ~5s — far past the 80ms deadline below.
		const adapter = hangingAdapter();
		registerAdapterForOp(op.id, () => adapter);
		canonicalLoopEntry(op, { sessionId: "sess-verify-deadline", confirmRunning: false });
		armVerificationDeadline(op.id, 80);

		const result = await awaitCanonicalOp(op.id, 10_000);
		expect(result?.status).toBe("cancelled");
		expect(adapter.abortCalls).toBeGreaterThanOrEqual(1);
	});

	it("is a no-op on an op that already finished", async () => {
		const op = await buildVerificationOp({
			parentOp: parentOp("op_parent_done"),
			sessionId: "sess-verify-done",
			deliverables: [DELIVERABLE],
		});
		op.model = "fake-test-model"; // configureVerificationRuntime stamps this in production; the worker refuses model-less ops
		mocks.adapterFactory = null;
		registerAdapterForOp(op.id, () => fakeVerifierAdapter());
		canonicalLoopEntry(op, { sessionId: "sess-verify-done", confirmRunning: false });
		const result = await awaitCanonicalOp(op.id, 10_000);
		expect(result?.status).toBe("completed");

		armVerificationDeadline(op.id, 1);
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(readOp(op.id)?.canonical?.state).toBe("succeeded");
	});
});
