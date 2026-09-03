/**
 * verification-trigger — the keystone observer's condition chain and, above
 * all, its SPEND guards.
 *
 * Under test: the skeptic's 3-ops probe (three terminals over one unchanged
 * deliverable → exactly ONE submission); changed-file refire with a
 * delta-only brief scope; one live verifier per session (both the in-flight
 * flag and a tracked live verify op); every trigger condition individually
 * falsified (recursion guard, no session, no ingestion, wrong extensions,
 * unreadable files, setting off, non-success terminals) — plus the one
 * condition that is deliberately NO LONGER falsifiable, the interactive-host
 * op type (chat-turn eligibility; the chat-specific semantics and the
 * per-turn cost bound live in verification-trigger-chat.test.ts);
 * the one-line wiring at the projectCanonicalEvent seam (running BEFORE the
 * session-bridge observer releases the op↔session binding); the cost pin — a
 * non-terminal event costs exactly ONE property read; and the never-throws
 * posture.
 *
 * The heavy submission half (verification-submit.ts) is swapped for a capture
 * seam; its own behavior (op shape, session split, deadline, failure posture)
 * is pinned in verification-submit.test.ts.
 */
import { describe, it, expect, afterAll, afterEach } from "vitest";
import { mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanonicalEvent } from "./types.js";

// ops/op-store.ts binds OPS_BASE = join(getLaxDir(), …) at import, so isolate
// the data dir BEFORE the dynamic imports below (full-turn.test.ts pattern) —
// nothing touches ~/.lax. realpathSync so recorded artifact paths
// (task-artifacts canonicalizes via realpathDeep — macOS /tmp → /private/tmp)
// compare equal to expectations.
const prevLaxDir = process.env.LAX_DATA_DIR;
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
const { getRuntimeConfig, setRuntimeConfig } = await import("../config.js");

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

/** Let the (immediately-resolving) seam submitter settle so the in-flight
 *  PENDING flag clears — between terminals, not during a burst. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

function succeededEvent(opId: string): CanonicalEvent {
	return { opId, seq: ++seq, type: "state_changed", ts: new Date().toISOString(), body: { from: "running", to: "succeeded", reason: "done" } };
}

/** Create a real deliverable file and enroll it as a session artifact —
 *  the fingerprint stats the file, so it must exist on disk. */
function addDeliverable(sessionId: string, name = `report-${seq++}.xlsx`, content = "cells"): string {
	const path = join(laxDir, name);
	writeFileSync(path, content, "utf-8");
	recordTaskArtifact(sessionId, path);
	return path;
}

/** Arm a session so the ingestion + deliverable conditions hold. */
function armSession(sessionId: string): string {
	recordExternalIngestion(sessionId);
	return addDeliverable(sessionId);
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

describe("verification trigger — spend guards (the design center)", () => {
	it("3-ops probe: three terminals over one unchanged deliverable submit exactly once", async () => {
		const sessionId = makeSession();
		const xlsx = armSession(sessionId);

		recordVerificationTrigger(succeededEvent(makeTrackedOp("freeform", sessionId)));
		expect(calls).toHaveLength(1);
		expect(calls[0]!.deliverables).toEqual([xlsx]);
		await settle(); // in-flight flag cleared — the skips below are the FINGERPRINT's

		recordVerificationTrigger(succeededEvent(makeTrackedOp("freeform", sessionId)));
		expect(calls).toHaveLength(1); // unchanged set — no second spend
		await settle();

		recordVerificationTrigger(succeededEvent(makeTrackedOp("research", sessionId)));
		expect(calls).toHaveLength(1); // still nothing new to verify
	});

	it("double-projected terminal events for one op submit exactly once", () => {
		const sessionId = makeSession();
		armSession(sessionId);
		const event = succeededEvent(makeTrackedOp("freeform", sessionId));
		recordVerificationTrigger(event);
		recordVerificationTrigger(event); // relay/dup projection of the same terminal
		expect(calls).toHaveLength(1);
	});

	it("a changed file re-fires with ONLY the delta in scope", async () => {
		const sessionId = makeSession();
		const unchanged = armSession(sessionId);
		recordVerificationTrigger(succeededEvent(makeTrackedOp("freeform", sessionId)));
		expect(calls).toHaveLength(1);
		await settle();

		// Add a SECOND deliverable now, keeping the first byte-identical:
		// the refire must scope to the new file only.
		const added = addDeliverable(sessionId, `late-${seq++}.csv`);
		recordVerificationTrigger(succeededEvent(makeTrackedOp("freeform", sessionId)));
		expect(calls).toHaveLength(2);
		expect(calls[1]!.deliverables).toEqual([added]);
		expect(calls[1]!.deliverables).not.toContain(unchanged);
	});

	it("an mtime-only change (same size) counts as changed and re-fires", async () => {
		const sessionId = makeSession();
		const xlsx = armSession(sessionId);
		recordVerificationTrigger(succeededEvent(makeTrackedOp("freeform", sessionId)));
		expect(calls).toHaveLength(1);
		await settle();

		const later = new Date(Date.now() + 5_000);
		utimesSync(xlsx, later, later); // same bytes, bumped mtime
		recordVerificationTrigger(succeededEvent(makeTrackedOp("freeform", sessionId)));
		expect(calls).toHaveLength(2);
		expect(calls[1]!.deliverables).toEqual([xlsx]);
	});

	it("burst while a submission is in flight collapses to one live verifier", async () => {
		const sessionId = makeSession();
		armSession(sessionId);
		let release!: () => void;
		const gate = new Promise<boolean>((resolve) => { release = () => resolve(true); });
		_setVerificationSubmitterForTests(async (input) => { calls.push(input); return gate; });

		recordVerificationTrigger(succeededEvent(makeTrackedOp("freeform", sessionId)));
		expect(calls).toHaveLength(1);

		// The set CHANGES mid-flight — still no second verifier while pending.
		const added = addDeliverable(sessionId, `midflight-${seq++}.docx`);
		recordVerificationTrigger(succeededEvent(makeTrackedOp("freeform", sessionId)));
		expect(calls).toHaveLength(1);

		release();
		await settle(); // let .finally clear the in-flight flag

		// Next terminal picks up the accumulated delta.
		recordVerificationTrigger(succeededEvent(makeTrackedOp("freeform", sessionId)));
		expect(calls).toHaveLength(2);
		expect(calls[1]!.deliverables).toEqual([added]);
		_setVerificationSubmitterForTests(async (input) => { calls.push(input); return true; });
	});

	it("a tracked live verification op blocks a new one for the whole session", () => {
		const sessionId = makeSession();
		armSession(sessionId);
		makeTrackedOp(VERIFICATION_OP_TYPE, sessionId, { status: "running", parentOpId: "op_some_other_parent" });
		recordVerificationTrigger(succeededEvent(makeTrackedOp("freeform", sessionId)));
		expect(calls).toHaveLength(0);
	});
});

describe("verification trigger — each condition individually falsified", () => {
	it("does NOT skip interactive host op types — chat_turn / voice_turn fire like any other op", () => {
		// SEMANTICS CHANGED. This condition used to be falsifiable: an
		// interactive host turn was skipped as "a reply turn ending, not a task
		// ending". That excluded the tier's most common case — a deliverable
		// built entirely inside a conversation — so the exclusion is gone and
		// both host types are eligible. Every OTHER condition still gates them;
		// the fingerprint dedup is what keeps the per-turn spend flat.
		for (const type of ["chat_turn", "voice_turn"]) {
			const sessionId = makeSession();
			const deliverable = armSession(sessionId);
			recordVerificationTrigger(succeededEvent(makeTrackedOp(type, sessionId)));
			expect(calls.at(-1)!.sessionId).toBe(sessionId);
			expect(calls.at(-1)!.deliverables).toEqual([deliverable]);
		}
		expect(calls).toHaveLength(2);
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
		addDeliverable(sessionId); // deliverable, but no ingestion
		recordVerificationTrigger(succeededEvent(makeTrackedOp("freeform", sessionId)));
		expect(calls).toHaveLength(0);
	});

	it("skips when the session has no deliverable-extension artifacts", () => {
		const sessionId = makeSession();
		recordExternalIngestion(sessionId);
		const txt = join(laxDir, `scratch-${seq++}.txt`);
		writeFileSync(txt, "notes", "utf-8");
		recordTaskArtifact(sessionId, txt); // artifact, wrong extension
		recordVerificationTrigger(succeededEvent(makeTrackedOp("freeform", sessionId)));
		expect(calls).toHaveLength(0);
	});

	it("skips when every deliverable has vanished from disk", () => {
		const sessionId = makeSession();
		const xlsx = armSession(sessionId);
		rmSync(xlsx);
		recordVerificationTrigger(succeededEvent(makeTrackedOp("freeform", sessionId)));
		expect(calls).toHaveLength(0);
	});

	it("skips when the verifyDeliverables setting is off", () => {
		const cfg = getRuntimeConfig();
		setRuntimeConfig({ ...cfg, verifyDeliverables: false });
		try {
			const sessionId = makeSession();
			armSession(sessionId);
			recordVerificationTrigger(succeededEvent(makeTrackedOp("freeform", sessionId)));
			expect(calls).toHaveLength(0);
		} finally {
			setRuntimeConfig({ ...cfg, verifyDeliverables: true });
		}
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

	it("matches deliverable extensions case-insensitively", () => {
		expect(isDeliverablePath("/w/Report.XLSX")).toBe(true);
		expect(isDeliverablePath("/w/summary.MD")).toBe(true);
		expect(isDeliverablePath("/w/notes.txt")).toBe(false);
		expect(isDeliverablePath("/w/page.html")).toBe(false);
		expect(isDeliverablePath("/w/no-extension")).toBe(false);
		expect([...DELIVERABLE_EXTENSIONS].sort()).toEqual([".csv", ".docx", ".md", ".pdf", ".pptx", ".xlsx"]);
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
		expect(calls[0]!.parentOp.id).toBe(opId);
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
