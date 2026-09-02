/**
 * verification-trigger — the keystone observer's condition chain.
 *
 * Under test: every trigger condition individually falsified; dedup on
 * double-projected terminal events plus the live-peer guard; the recursion
 * guard (a verification op's own success never re-triggers); the one-line
 * wiring at the projectCanonicalEvent seam (running BEFORE the session-bridge
 * observer releases the op↔session binding); the cost pin — a non-terminal
 * event costs exactly ONE property read; and the never-throws posture.
 *
 * The heavy submission half (verification-submit.ts) is swapped for a capture
 * seam; its own behavior (op shape, setting gate, runtime failure posture) is
 * pinned in verification-submit.test.ts.
 */
import { describe, it, expect, afterAll, afterEach } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanonicalEvent } from "./types.js";

// ops/op-store.ts binds OPS_BASE = join(getLaxDir(), …) at import, so isolate
// the data dir BEFORE the dynamic imports below (full-turn.test.ts pattern) —
// nothing touches ~/.lax.
const prevLaxDir = process.env.LAX_DATA_DIR;
// realpathSync so recorded artifact paths (task-artifacts canonicalizes via
// realpathDeep — macOS /tmp → /private/tmp) compare equal to expectations.
const laxDir = realpathSync(mkdtempSync(join(tmpdir(), "lax-verify-trigger-")));
process.env.LAX_DATA_DIR = laxDir;
afterAll(() => {
	if (prevLaxDir === undefined) delete process.env.LAX_DATA_DIR;
	else process.env.LAX_DATA_DIR = prevLaxDir;
	rmSync(laxDir, { recursive: true, force: true });
});

const {
	recordVerificationTrigger,
	_setVerificationSubmitterForTests,
	_resetVerificationTriggerForTests,
	isDeliverablePath,
	DELIVERABLE_EXTENSIONS,
	VERIFICATION_OP_TYPE,
} = await import("./verification-trigger.js");
type SubmitInput = import("./verification-trigger.js").VerificationSubmitInput;
const { projectCanonicalEvent } = await import("./event-emitter.js");
const { writeOp } = await import("../ops/op-store.js");
const { trackOpForSession, releaseOpFromSession } = await import("../ops/session-bridge.js");
const { recordExternalIngestion, clearExternalIngestion } = await import("../data-lineage/external.js");
const { recordTaskArtifact, clearTaskArtifacts } = await import("../data-lineage/task-artifacts.js");
const { cancelIdleNudge } = await import("../ops/idle-nudge.js");

let seq = 0;
const trackedOps: string[] = [];
const usedSessions: string[] = [];

function makeTrackedOp(type: string, sessionId: string, extra: Record<string, unknown> = {}): string {
	const id = `op_verify_trig_${type}_${seq++}`;
	writeOp({ id, type, status: "completed", task: `task for ${id}`, ...extra } as never);
	trackOpForSession(id, sessionId, `verify-trigger test op ${id}`);
	trackedOps.push(id);
	return id;
}

function makeSession(): string {
	const sessionId = `sess-verify-trig-${seq++}`;
	usedSessions.push(sessionId);
	return sessionId;
}

function succeededEvent(opId: string): CanonicalEvent {
	return { opId, seq: ++seq, type: "state_changed", ts: new Date().toISOString(), body: { from: "running", to: "succeeded", reason: "done" } };
}

/** Arm a session so conditions 3+4 hold: external ingestion + one deliverable. */
function armSession(sessionId: string, deliverable = join(laxDir, `report-${seq++}.xlsx`)): string {
	recordExternalIngestion(sessionId);
	recordTaskArtifact(sessionId, deliverable);
	return deliverable;
}

let calls: SubmitInput[] = [];
_setVerificationSubmitterForTests(async (input) => { calls.push(input); return true; });

afterEach(() => {
	calls = [];
	_resetVerificationTriggerForTests();
	for (const id of trackedOps.splice(0)) releaseOpFromSession(id);
	for (const sessionId of usedSessions.splice(0)) {
		clearExternalIngestion(sessionId);
		clearTaskArtifacts(sessionId);
		cancelIdleNudge(sessionId);
	}
});
afterAll(() => _setVerificationSubmitterForTests(null));

describe("verification trigger — happy path", () => {
	it("submits once for a succeeded non-interactive op with ingestion + deliverables", () => {
		const sessionId = makeSession();
		const xlsx = armSession(sessionId);
		const txt = join(laxDir, `notes-${seq++}.txt`);
		recordTaskArtifact(sessionId, txt); // non-deliverable extension — filtered out
		const opId = makeTrackedOp("freeform", sessionId);

		recordVerificationTrigger(succeededEvent(opId));

		expect(calls).toHaveLength(1);
		expect(calls[0]!.parentOp.id).toBe(opId);
		expect(calls[0]!.sessionId).toBe(sessionId);
		expect(calls[0]!.deliverables).toEqual([xlsx]);
	});

	it("resolves the session from the explicit override when the op is untracked", () => {
		const sessionId = makeSession();
		armSession(sessionId);
		const opId = `op_verify_trig_untracked_${seq++}`;
		writeOp({ id: opId, type: "freeform", status: "completed", task: "untracked" } as never);

		recordVerificationTrigger(succeededEvent(opId), sessionId);

		expect(calls).toHaveLength(1);
		expect(calls[0]!.sessionId).toBe(sessionId);
	});

	it("matches deliverable extensions case-insensitively", () => {
		expect(isDeliverablePath("/w/Report.XLSX")).toBe(true);
		expect(isDeliverablePath("/w/summary.MD")).toBe(true);
		expect(isDeliverablePath("/w/notes.txt")).toBe(false);
		expect(isDeliverablePath("/w/page.html")).toBe(false);
		expect(isDeliverablePath("/w/no-extension")).toBe(false);
		expect([...DELIVERABLE_EXTENSIONS].sort()).toEqual([".csv", ".docx", ".md", ".pdf", ".pptx", ".xlsx"]);
	});
});

describe("verification trigger — each condition individually falsified", () => {
	it("skips interactive host op types (chat_turn / voice_turn)", () => {
		for (const type of ["chat_turn", "voice_turn"]) {
			const sessionId = makeSession();
			armSession(sessionId);
			recordVerificationTrigger(succeededEvent(makeTrackedOp(type, sessionId)));
		}
		expect(calls).toHaveLength(0);
	});

	it("skips a verification op's own completion (recursion guard)", () => {
		const sessionId = makeSession();
		armSession(sessionId);
		const opId = makeTrackedOp(VERIFICATION_OP_TYPE, sessionId, { parentOpId: "op_parent_x" });
		recordVerificationTrigger(succeededEvent(opId));
		expect(calls).toHaveLength(0);
	});

	it("skips when the session has no external ingestion", () => {
		const sessionId = makeSession();
		recordTaskArtifact(sessionId, join(laxDir, `clean-${seq++}.docx`)); // deliverable, but no ingestion
		recordVerificationTrigger(succeededEvent(makeTrackedOp("freeform", sessionId)));
		expect(calls).toHaveLength(0);
	});

	it("skips when the session has no deliverable-extension artifacts", () => {
		const sessionId = makeSession();
		recordExternalIngestion(sessionId);
		recordTaskArtifact(sessionId, join(laxDir, `scratch-${seq++}.txt`)); // artifact, wrong extension
		recordVerificationTrigger(succeededEvent(makeTrackedOp("freeform", sessionId)));
		expect(calls).toHaveLength(0);
	});

	it("skips when no session binding resolves and no override is given", () => {
		const opId = `op_verify_trig_orphan_${seq++}`;
		writeOp({ id: opId, type: "freeform", status: "completed", task: "orphan" } as never);
		recordVerificationTrigger(succeededEvent(opId));
		expect(calls).toHaveLength(0);
	});

	it("skips failed and cancelled terminals — only success earns a verification pass", () => {
		const sessionId = makeSession();
		armSession(sessionId);
		const opId = makeTrackedOp("freeform", sessionId);
		for (const to of ["failed", "cancelled", "running"]) {
			recordVerificationTrigger({ ...succeededEvent(opId), body: { from: "running", to, reason: "x" } });
		}
		expect(calls).toHaveLength(0);
	});
});

describe("verification trigger — dedup", () => {
	it("submits exactly once for double-projected terminal events", () => {
		const sessionId = makeSession();
		armSession(sessionId);
		const opId = makeTrackedOp("freeform", sessionId);
		const event = succeededEvent(opId);
		recordVerificationTrigger(event);
		recordVerificationTrigger(event); // relay/dup projection of the same terminal
		expect(calls).toHaveLength(1);
	});

	it("skips when a live verification peer already exists for the same parent", () => {
		const sessionId = makeSession();
		armSession(sessionId);
		const parentId = makeTrackedOp("freeform", sessionId);
		makeTrackedOp(VERIFICATION_OP_TYPE, sessionId, { status: "pending", parentOpId: parentId });
		recordVerificationTrigger(succeededEvent(parentId));
		expect(calls).toHaveLength(0);
	});

	it("a live verification peer for a DIFFERENT parent does not block", () => {
		const sessionId = makeSession();
		armSession(sessionId);
		const parentId = makeTrackedOp("freeform", sessionId);
		makeTrackedOp(VERIFICATION_OP_TYPE, sessionId, { status: "running", parentOpId: "op_some_other_parent" });
		recordVerificationTrigger(succeededEvent(parentId));
		expect(calls).toHaveLength(1);
	});
});

describe("verification trigger — wiring and posture", () => {
	it("fires through projectCanonicalEvent BEFORE the bridge releases the op↔session binding", () => {
		const sessionId = makeSession();
		armSession(sessionId);
		const opId = makeTrackedOp("freeform", sessionId);
		// The bridge observer's terminal branch releases the binding in this
		// same projection; the trigger still resolved the session — proof it
		// runs first (the wiring-order invariant).
		projectCanonicalEvent(succeededEvent(opId));
		expect(calls).toHaveLength(1);
		expect(calls[0]!.sessionId).toBe(sessionId);
	});

	it("non-terminal events cost exactly one property read (the type discriminator)", () => {
		const reads: (string | symbol)[] = [];
		const probe = new Proxy({ opId: "op_x", seq: 1, type: "message_appended", ts: "", body: null }, {
			get(target, prop) {
				reads.push(prop);
				return Reflect.get(target, prop);
			},
		}) as CanonicalEvent;
		recordVerificationTrigger(probe);
		expect(reads).toEqual(["type"]);
	});

	it("never throws — a rejecting submitter and a malformed event are both absorbed", async () => {
		const sessionId = makeSession();
		armSession(sessionId);
		_setVerificationSubmitterForTests(async () => { throw new Error("boom"); });
		const opId = makeTrackedOp("freeform", sessionId);
		expect(() => recordVerificationTrigger(succeededEvent(opId))).not.toThrow();
		await new Promise((resolve) => setImmediate(resolve)); // rejection is caught, not unhandled
		expect(() => recordVerificationTrigger({ opId: "nope", seq: 1, type: "state_changed", ts: "", body: null })).not.toThrow();
		_setVerificationSubmitterForTests(async (input) => { calls.push(input); return true; });
	});
});
