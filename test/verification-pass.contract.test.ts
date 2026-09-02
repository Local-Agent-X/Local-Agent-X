/**
 * Verification-invariants campaign — the closing END-TO-END contract.
 *
 * One delegated task walked through the REAL seams, tier by tier:
 *   1. INGEST + BUILD: external ingestion recorded via the registry's public
 *      API; the deliverable created by the REAL spreadsheet write tool driven
 *      through the REAL dispatch pipeline (executeToolCalls: resolve → policy
 *      → approval → sandbox → audit), so task-artifact enrollment
 *      (run-sandboxed) and provenance recording (audit-tool-call) land at
 *      their production sites — asserted via readProvenance.
 *   2. TRIGGER + SUBMIT: the parent op runs to `succeeded` through the real
 *      canonical loop (per-op fake adapter — the module's one injection
 *      seam); its terminal projection fires verification-trigger, which
 *      lazily loads the REAL verification-submit (provider chain faked at the
 *      resolveProvider / createProviderAdapterFactory seams, the
 *      verification-submit.test.ts recipe) → exactly ONE verify_deliverable
 *      op, background lane, parentOpId lineage, harness provenance, brief
 *      carrying the VERDICT contract + deliverable + its claimed sources.
 *   3. REPORT: the verify op completes on a fake adapter emitting a
 *      `VERDICT: DISCREPANCIES` final; the verdict rides the real
 *      session-bridge-observer as bg_op_completed (captured at the
 *      setSessionBroadcaster boot seam, NOT headless-stamped) into the
 *      parent session's pending-notification queue; the recorded artifact
 *      fingerprint then absorbs a second identical terminal (no re-spend).
 *   4. QUIET FAILURE: a verify op driven to FAILED through the real loop is
 *      headless-stamped on bg_op_completed, queues NO pending notification;
 *      the idle-nudge non-arming is pinned via a synchronous re-projection
 *      under fake timers (timer-count delta 0, contrasted with an ordinary
 *      failure's ≥1) because the loop's own async terminal cannot run under
 *      fake timers — the strongest in-process observable for "no nudge".
 *   5. BOUNDARIES: the verifier's sealed runtime session is the worker-scoped
 *      `agent-op-<opId>` bucket (its artifact enrollments never grow the
 *      parent set — probed via the registry's public API; an in-run tool
 *      write would need an autonomy/approval fixture this contract test
 *      deliberately does not couple to); the deliverable stays rm-DENIED by
 *      the real shell-path guard and delete_file routes it to the task trash
 *      through the same real dispatch pipeline.
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Adapter, AdapterReport, TurnInput, TurnResult } from "../src/canonical-loop/adapter-contract.js";
import type { CanonicalEvent } from "../src/canonical-loop/types.js";
import type { Op } from "../src/ops/types.js";
import type { ToolDefinition } from "../src/types.js";

// ops/op-store.ts binds OPS_BASE at import — isolate the data dir BEFORE the
// dynamic imports below (full-turn.test.ts pattern). realpathSync so recorded
// artifact paths (realpathDeep canonicalization) compare equal.
const prevLaxDir = process.env.LAX_DATA_DIR;
const laxDir = realpathSync(mkdtempSync(join(tmpdir(), "lax-verify-e2e-")));
const workDir = realpathSync(mkdtempSync(join(tmpdir(), "lax-verify-e2e-work-")));
process.env.LAX_DATA_DIR = laxDir;

// Deterministic provider chain for the REAL submitVerificationOp: no keychain,
// no configured credentials, no real provider adapter (the exact
// verification-submit.test.ts recipe — spread importOriginal so every other
// export stays real).
const mocks = vi.hoisted(() => ({
	adapterFactory: null as null | (() => unknown),
}));
vi.mock("../src/secrets.js", async (importOriginal) => ({
	...(await importOriginal<object>()),
	getOrInitSecretsStore: () => ({}) as never,
}));
vi.mock("../src/agent-request/resolve-provider.js", async (importOriginal) => ({
	...(await importOriginal<object>()),
	resolveProvider: () => Promise.resolve({ provider: "anthropic", apiKey: "key-123", model: "fake-verify-model", authSource: "config" }),
}));
vi.mock("../src/canonical-loop/provider-adapter-factory.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/canonical-loop/provider-adapter-factory.js")>();
	return {
		...original,
		createProviderAdapterFactory: async (
			...args: Parameters<typeof original.createProviderAdapterFactory>
		) => (mocks.adapterFactory ? mocks.adapterFactory : original.createProviderAdapterFactory(...args)),
	};
});

const { canonicalLoopEntry, registerAdapterForOp, awaitCanonicalOp, resetCanonicalRuntime, resetScheduler } = await import("../src/canonical-loop/index.js");
const { projectCanonicalEvent } = await import("../src/canonical-loop/event-emitter.js");
const { VERIFICATION_OP_TYPE, _resetVerificationTriggerForTests } = await import("../src/canonical-loop/verification-trigger.js");
const { buildVerificationOp, verificationRuntimeSessionId } = await import("../src/canonical-loop/verification-submit.js");
const { isWorkerScopedSession } = await import("../src/canonical-loop/trash-scope-observer.js");
const { writeOp, readOp } = await import("../src/ops/op-store.js");
const { trackOpForSession, releaseOpFromSession, listOpsForSession, setSessionBroadcaster } = await import("../src/ops/session-bridge.js");
const { drainPendingNotifications } = await import("../src/ops/pending-notifications.js");
const { cancelIdleNudge } = await import("../src/ops/idle-nudge.js");
const { recordExternalIngestion, hasExternalIngestion, clearExternalIngestion } = await import("../src/data-lineage/external.js");
const { listTaskArtifacts, recordTaskArtifact, clearTaskArtifacts } = await import("../src/data-lineage/task-artifacts.js");
const { readProvenance } = await import("../src/data-lineage/provenance.js");
const { executeToolCalls } = await import("../src/tool-execution/execute-tool.js");
const { SecurityLayer } = await import("../src/security/index.js");
const { ToolPolicy, stampedDefaultPolicy } = await import("../src/tool-policy/index.js");
const { setAriRequired } = await import("../src/ari-kernel/state.js");
const { setSessionProfile, clearSessionProfile } = await import("../src/autonomy/profile-store.js");
const { spreadsheetTools } = await import("../src/tools/spreadsheet-tools.js");
const { deleteFileTool } = await import("../src/tools/read-write-tools.js");
const { evaluateShellCommandAndPaths } = await import("../src/security/layer/shell-path-guard.js");

const SESSION = "sess-verify-e2e-parent"; // chat-parented (NOT headless — the stamp must come from quietVerifyFailure alone)
const QUIET_SESSION = "sess-verify-e2e-quiet";
const LOUD_SESSION = "sess-verify-e2e-loud";
const PARENT_OP_ID = "op_parent_e2e";
const PARENT_TASK = "Build the vendor market-share spreadsheet from the 2026 filings";
const DELIVERABLE = join(workDir, "market-share.xlsx");
const SOURCES = [
	{ url: "https://example.com/gan-2026-report", ref: "table 3" },
	{ file: join(workDir, "vendor-filings.md"), ref: "rows 2-9", note: "headline share figures" },
];
const VERDICT_TEXT = "VERDICT: DISCREPANCIES\nvalue | deliverable says | independent source says | match?\nInfineon share | 41% | 37% | no";

const spreadsheetFamily = spreadsheetTools.find((t) => t.name === "spreadsheet");
if (!spreadsheetFamily) throw new Error("spreadsheet family tool not found");
const TOOL_MAP = new Map<string, ToolDefinition>([
	["spreadsheet", spreadsheetFamily],
	[deleteFileTool.name, deleteFileTool],
]);

// Every bg_op_* the real observer emits, captured at the boot wiring seam.
const wsEvents: { sessionId: string; event: Record<string, unknown> }[] = [];
setSessionBroadcaster((sessionId, event) => wsEvents.push({ sessionId, event: event as unknown as Record<string, unknown> }));
setAriRequired(false);
setSessionProfile(SESSION, "Power");

let seq = 1000;
const state: { verifyOpId?: string } = {};

afterAll(() => {
	setAriRequired(true);
	clearSessionProfile(SESSION);
	for (const sessionId of [SESSION, QUIET_SESSION, LOUD_SESSION]) {
		cancelIdleNudge(sessionId);
		clearExternalIngestion(sessionId);
		clearTaskArtifacts(sessionId);
		for (const id of listOpsForSession(sessionId)) releaseOpFromSession(id);
	}
	_resetVerificationTriggerForTests();
	setSessionBroadcaster(() => { /* detached */ });
	resetCanonicalRuntime();
	resetScheduler();
	if (prevLaxDir === undefined) delete process.env.LAX_DATA_DIR;
	else process.env.LAX_DATA_DIR = prevLaxDir;
	for (const dir of [laxDir, workDir]) rmSync(dir, { recursive: true, force: true });
});

/** The real dispatch pipeline, restore-file-tool.test.ts posture: the write
 *  and delete both flow resolve → policy → approval → sandbox → audit. */
async function dispatch(name: string, args: Record<string, unknown>): Promise<string> {
	const messages = await executeToolCalls(
		[{ id: `call-e2e-${seq++}`, name, arguments: JSON.stringify(args) }],
		TOOL_MAP,
		new SecurityLayer(workDir, "unrestricted"),
		new ToolPolicy(stampedDefaultPolicy()),
		undefined, undefined, undefined,
		SESSION,
		undefined, undefined, undefined, undefined,
		PARENT_OP_ID, // production shape: the write executes inside the parent op
		"local",
	);
	expect(messages).toHaveLength(1);
	return String(messages[0].content ?? "");
}

function scriptedTextAdapter(name: string, text: string): Adapter {
	return {
		name, version: "1",
		async runTurn(_input: TurnInput, report: (r: AdapterReport) => void): Promise<TurnResult> {
			report({ kind: "message_finalized", message: { messageId: `${name}-m0`, role: "assistant", content: { text } } });
			return { providerState: { adapterName: name, adapterVersion: "1", providerPayload: null }, terminalReason: "done", modelStop: "ended" };
		},
		async abort(): Promise<void> { /* scripted — nothing in flight */ },
	};
}

function failingAdapter(): Adapter {
	return {
		name: "fake-failing", version: "1",
		async runTurn(_input: TurnInput, report: (r: AdapterReport) => void): Promise<TurnResult> {
			report({ kind: "error", code: "provider_500", message: "verifier exploded", retryable: false });
			return { providerState: { adapterName: "fake-failing", adapterVersion: "1", providerPayload: null }, terminalReason: "error" };
		},
		async abort(): Promise<void> { /* nothing in flight */ },
	};
}

function chatParentedOp(id: string, task: string): Op {
	return {
		id, type: "freeform", task,
		contextPack: {
			task: { description: task, successCriteria: [], constraints: [], notWhatToRedo: [] },
			context: { recentTurns: [], referencedFiles: [], memoryHits: [], agentsRules: "" },
			capabilities: {},
			budget: { maxIterations: 8, maxTokens: 0, maxWallTimeMs: 0, maxSelfEditCalls: 0 },
			routing: { lane: "interactive" },
			secrets: { allowed: [] },
		},
		lane: "interactive",
		retryPolicy: { maxRecoveryAttempts: 1, backoffMs: [0] },
		ownerId: "local-user",
		visibility: "private",
		status: "pending",
		createdAt: new Date().toISOString(),
		attemptCount: 0,
		model: "fake-test-model",
	};
}

function makeTrackedOp(type: string, sessionId: string, extra: Record<string, unknown> = {}): string {
	const id = `op_e2e_${type}_${seq++}`;
	writeOp({ id, type, status: "completed", task: `task for ${id}`, ...extra } as never);
	trackOpForSession(id, sessionId, `e2e op ${id}`);
	return id;
}

function terminalEvent(opId: string, to: "succeeded" | "failed"): CanonicalEvent {
	return { opId, seq: ++seq, type: "state_changed", ts: new Date().toISOString(), body: { from: "running", to, reason: "e2e" } };
}

function verifyOpDirs(): string[] {
	try {
		return readdirSync(join(laxDir, "operations")).filter((d) => d.startsWith(`op_${VERIFICATION_OP_TYPE}`));
	} catch { return []; }
}

async function waitFor<T>(probe: () => T | undefined, what: string, ms = 10_000): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 15));
	}
}

describe("verification pass — the end-to-end contract", () => {
	it("ingest → build → trigger → verify → verdict reaches the pending-notification; fingerprint stops the re-spend", async () => {
		// LEG 1 — delegated work under the chat-parented session.
		recordExternalIngestion(SESSION); // the ingestion registry's public API
		await dispatch("spreadsheet", {
			action: "write", file_path: DELIVERABLE,
			data: JSON.stringify([{ Vendor: "Infineon", Share: "41%" }, { Vendor: "Navitas", Share: "18%" }]),
			sources: SOURCES,
		});
		expect(existsSync(DELIVERABLE)).toBe(true);
		expect(hasExternalIngestion(SESSION)).toBe(true);
		// The REAL create-class recording (run-sandboxed) enrolled the artifact…
		expect(listTaskArtifacts(SESSION)).toEqual([DELIVERABLE]);
		// …and the REAL audit seam landed the attributed provenance record.
		const prov = readProvenance(DELIVERABLE);
		expect(prov).toHaveLength(1);
		expect(prov[0]).toMatchObject({ sessionId: SESSION, opId: PARENT_OP_ID, tool: "spreadsheet", action: "write", sources: SOURCES });

		// LEG 2 — the parent op succeeds through the real loop; the terminal
		// projection fires the trigger → REAL submit → ONE verify op.
		mocks.adapterFactory = () => scriptedTextAdapter("fake-verifier", VERDICT_TEXT);
		const parent = chatParentedOp(PARENT_OP_ID, PARENT_TASK);
		trackOpForSession(parent.id, SESSION, PARENT_TASK);
		registerAdapterForOp(parent.id, () => scriptedTextAdapter("fake-parent", "Spreadsheet built."));
		canonicalLoopEntry(parent);
		expect((await awaitCanonicalOp(parent.id, 10_000))?.status).toBe("completed");

		// Poll the durable ops store, not listOpsForSession: the scripted
		// verifier can finish (and the bridge release the binding) within ms.
		const verifyOpId = await waitFor(() => verifyOpDirs()[0], "verification op submission");
		expect(verifyOpDirs()).toHaveLength(1); // exactly ONE submitted
		const submitted = readOp(verifyOpId)!;
		expect(submitted.type).toBe(VERIFICATION_OP_TYPE);
		expect(submitted.lane).toBe("background");
		expect(submitted.parentOpId).toBe(parent.id);
		expect(submitted.taskProvenance).toBe("harness");
		expect(submitted.task).toContain("VERDICT: CONFIRMED | DISCREPANCIES | UNVERIFIABLE");
		expect(submitted.task).toContain(DELIVERABLE);
		expect(submitted.task).toContain("url: https://example.com/gan-2026-report"); // the claimed sources, from the sidecar
		expect(submitted.task).toContain("ref: table 3");

		// LEG 3 — the verifier reports DISCREPANCIES; the verdict rides
		// bg_op_completed into the parent session's pending queue.
		expect((await awaitCanonicalOp(verifyOpId, 10_000))?.status).toBe("completed");
		const completed = await waitFor(
			() => wsEvents.find((e) => e.event.type === "bg_op_completed" && e.event.opId === verifyOpId),
			"verify bg_op_completed",
		);
		expect(completed.sessionId).toBe(SESSION);
		expect(completed.event.status).toBe("completed");
		expect(String(completed.event.summary)).toContain("VERDICT: DISCREPANCIES");
		expect(completed.event.headless).toBeUndefined(); // a verdict is user-facing — full surfacing

		const verdictNote = drainPendingNotifications(SESSION).find((n) => n.opId === verifyOpId);
		expect(verdictNote?.status).toBe("completed");
		expect(verdictNote?.summary).toContain("VERDICT: DISCREPANCIES");
		expect(verdictNote?.task).toBe(`Verification pass: ${PARENT_TASK}`);
		cancelIdleNudge(SESSION);

		// Fingerprint recorded: a second identical terminal → no second spend.
		projectCanonicalEvent(terminalEvent(makeTrackedOp("freeform", SESSION), "succeeded"));
		await new Promise((resolve) => setImmediate(resolve));
		expect(verifyOpDirs()).toHaveLength(1);
		drainPendingNotifications(SESSION); // the second parent's own note — not under test
		cancelIdleNudge(SESSION);
		state.verifyOpId = verifyOpId;
	}, 30_000);

	it("quiet failure: a FAILED verify op is headless-stamped, queues no notification, arms no nudge", async () => {
		const op = await buildVerificationOp({
			parentOp: { id: "op_parent_quiet", type: "freeform", task: PARENT_TASK } as never,
			sessionId: QUIET_SESSION,
			deliverables: [DELIVERABLE],
		});
		op.model = "fake-test-model"; // configureVerificationRuntime stamps this in production
		op.retryPolicy = { maxRecoveryAttempts: 0, backoffMs: [] }; // no multi-second recovery ladder inside a unit test
		registerAdapterForOp(op.id, failingAdapter);
		trackOpForSession(op.id, QUIET_SESSION, `Verification pass: ${PARENT_TASK}`);
		canonicalLoopEntry(op, { sessionId: QUIET_SESSION, confirmRunning: false });
		expect((await awaitCanonicalOp(op.id, 10_000))?.status).toBe("failed");

		const completed = await waitFor(
			() => wsEvents.find((e) => e.event.type === "bg_op_completed" && e.event.opId === op.id),
			"quiet bg_op_completed",
		);
		expect(completed.sessionId).toBe(QUIET_SESSION);
		expect(completed.event.status).toBe("failed");
		expect(completed.event.headless).toBe(true); // the borrowed stamp: AGENTS card, no toast
		expect(drainPendingNotifications(QUIET_SESSION)).toEqual([]); // nothing queued for the agent to narrate

		// No idle nudge armed — pinned synchronously under fake timers (see
		// module header for why the loop's own terminal can't be probed this
		// way), with an ordinary failure as the ≥1-timer contrast.
		vi.useFakeTimers({ toFake: ["setTimeout"] });
		try {
			const quietOp = makeTrackedOp(VERIFICATION_OP_TYPE, QUIET_SESSION, { status: "failed", parentOpId: "op_parent_quiet", lastFailureReason: "verifier crashed" });
			const before = vi.getTimerCount();
			projectCanonicalEvent(terminalEvent(quietOp, "failed"));
			expect(vi.getTimerCount() - before).toBe(0); // quiet: no nudge timer

			const loudOp = makeTrackedOp("freeform", LOUD_SESSION, { status: "failed", lastFailureReason: "provider 500" });
			const beforeLoud = vi.getTimerCount();
			projectCanonicalEvent(terminalEvent(loudOp, "failed"));
			expect(vi.getTimerCount() - beforeLoud).toBeGreaterThanOrEqual(1); // an ordinary failure DOES nudge
			cancelIdleNudge(LOUD_SESSION); // clear while the fake handle is still clearable
		} finally {
			vi.useRealTimers();
		}
		expect(drainPendingNotifications(QUIET_SESSION)).toEqual([]); // the synthetic quiet failure queued nothing either
		drainPendingNotifications(LOUD_SESSION);
	}, 15_000);

	it("boundaries: worker-scoped verifier session never grows the parent set; delete-protection coexists", async () => {
		const verifyOpId = state.verifyOpId;
		expect(verifyOpId).toBeDefined();

		// The sealed runtime session — which feeds the verifier's tool runtime
		// and therefore its data-lineage recorders — is its OWN worker-scoped
		// bucket, while the canonical (projection) session stays the parent.
		const runtimeSession = verificationRuntimeSessionId(verifyOpId!);
		expect((readOp(verifyOpId!)?.runtimeDescriptor as { sessionId?: string } | undefined)?.sessionId).toBe(runtimeSession);
		expect(readOp(verifyOpId!)?.canonical?.sessionId).toBe(SESSION);
		expect(isWorkerScopedSession(runtimeSession)).toBe(true);
		const parentBefore = listTaskArtifacts(SESSION);
		recordTaskArtifact(runtimeSession, join(workDir, "verifier-own-notes.md"));
		expect(listTaskArtifacts(SESSION)).toEqual(parentBefore); // no compounding
		expect(listTaskArtifacts(runtimeSession)).toHaveLength(1);
		clearTaskArtifacts(runtimeSession);

		// The agent-created deliverable: shell hard-delete DENIED by the real
		// guard, in the mode where ONLY the artifact rule can deny…
		const rm = evaluateShellCommandAndPaths(`rm ${DELIVERABLE}`, {
			workspace: workDir, fileAccessMode: "unrestricted", inlineEvalPolicy: "allow",
			allowedPathCheck: () => true, sessionId: SESSION,
		});
		expect(rm.allowed).toBe(false);
		expect(rm.reason).toContain("use delete_file (recoverable) instead");

		// …and delete_file, through the same real pipeline, routes to the
		// recoverable task trash with the restore contract in the result.
		const delContent = await dispatch("delete_file", { path: DELIVERABLE });
		expect(delContent).toContain("moved to task trash");
		expect(delContent).toContain(`restore_file({ path: "${DELIVERABLE}" })`);
		expect(existsSync(DELIVERABLE)).toBe(false);
	});
});
