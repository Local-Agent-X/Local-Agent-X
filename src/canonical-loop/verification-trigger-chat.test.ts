/**
 * verification-trigger — CHAT-TURN eligibility, its COUNT bound, and its
 * PER-TURN COST bound.
 *
 * The trigger used to skip interactive host turns outright
 * (isInteractiveHostOpType), which excluded the tier's most common case: a
 * deliverable built entirely inside a conversation. Removing that exclusion
 * puts the trigger on the hot path of EVERY chat turn, which raises two
 * separate questions this file answers with counters rather than assertion.
 *
 * COUNT — how many model runs does a chat session buy? The fingerprint alone
 * answers this only for turns that change nothing. A turn that EDITS the
 * deliverable is a new signature, so an iteration loop would have bought one
 * verification per save, and narrated the verdict on v7 while the user was on
 * v9. The session-idle debounce (verification-spend.ts) is what bounds count:
 * 20 consecutive edit turns → ONE verification, over the final state.
 *
 * COST — what does a turn that buys nothing cost? Exactly ONE op-store read
 * (the terminating turn's own op, which every observer on this seam already
 * pays) plus one statSync per session DELIVERABLE, with the per-peer op scan
 * never reached. That last counter is the load-bearing one: the
 * one-live-verifier scan does a readOp (existsSync + readFileSync +
 * JSON.parse) per live peer op, so under the old guard order a long chat
 * session paid it on every turn.
 *
 * Also pinned: the delta-only brief on a follow-up turn; NO MID-TURN
 * INJECTION (every event a chat turn emits while in flight fires nothing —
 * only its `succeeded` terminal arms); and WORKER SCOPING for the chat-parent
 * case — the verifier's own `agent-op-<opId>` session absorbs its ingestion
 * and its writes, so it can never arm the CHAT session it was spawned from.
 * (The producer of that id, verificationRuntimeSessionId, is pinned against a
 * real chat parent end-to-end in test/verification-pass.contract.test.ts.)
 *
 * The heavy submission half is swapped for the capture seam, as in
 * verification-trigger.test.ts.
 */
import { describe, it, expect, vi, afterAll, afterEach, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanonicalEvent } from "./types.js";

/** Syscall probe. `on` is flipped only around the measured window so setup
 *  (op writes, config warm-up, artifact recording) never pollutes a count. */
const probe = vi.hoisted(() => ({ on: false, statSync: 0, readOp: 0, listOpsForSession: 0 }));

// Pass-through counters at the three seams the trigger's per-turn cost lives
// behind. importOriginal is spread so every other export stays real.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const statSync = ((...args: Parameters<typeof actual.statSync>) => {
		if (probe.on) probe.statSync++;
		return actual.statSync(...args);
	}) as typeof actual.statSync;
	return { ...actual, statSync, default: { ...actual, statSync } };
});
vi.mock("../ops/op-store.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../ops/op-store.js")>();
	return {
		...actual,
		readOp: (opId: string) => {
			if (probe.on) probe.readOp++;
			return actual.readOp(opId);
		},
	};
});
vi.mock("../ops/session-bridge.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../ops/session-bridge.js")>();
	return {
		...actual,
		listOpsForSession: (sessionId: string) => {
			if (probe.on) probe.listOpsForSession++;
			return actual.listOpsForSession(sessionId);
		},
	};
});

// ops/op-store.ts binds OPS_BASE at import — isolate the data dir BEFORE the
// dynamic imports below (verification-trigger.test.ts pattern).
const prevLaxDir = process.env.LAX_DATA_DIR;
const laxDir = realpathSync(mkdtempSync(join(tmpdir(), "lax-verify-chat-")));
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
	VERIFICATION_DEBOUNCE_MS,
} = await import("./verification-trigger.js");
type SubmitInput = import("./verification-trigger.js").VerificationSubmitInput;
const { buildVerificationBrief } = await import("./verification-brief.js");
const { isWorkerScopedSession } = await import("./trash-scope-observer.js");
const { writeOp } = await import("../ops/op-store.js");
const { trackOpForSession, releaseOpFromSession } = await import("../ops/session-bridge.js");
const { recordExternalIngestion, hasExternalIngestion, clearExternalIngestion } = await import("../data-lineage/external.js");
const { listTaskArtifacts, recordTaskArtifact, clearTaskArtifacts } = await import("../data-lineage/task-artifacts.js");
const { cancelIdleNudge } = await import("../ops/idle-nudge.js");
const { getRuntimeConfig } = await import("../config.js");

getRuntimeConfig(); // warm the memoized config so no measured turn pays its disk load

let seq = 0;
const trackedOps: string[] = [];
const usedSessions: string[] = [];

function makeSession(): string {
	const sessionId = `sess-verify-chat-${seq++}`;
	usedSessions.push(sessionId);
	return sessionId;
}

function makeTrackedOp(type: string, sessionId: string, extra: Record<string, unknown> = {}): string {
	const id = `op_verify_chat_${type}_${seq++}`;
	writeOp({ id, type, status: "completed", task: `task for ${id}`, ...extra } as never);
	trackOpForSession(id, sessionId, `verify-chat test op ${id}`);
	trackedOps.push(id);
	return id;
}

function succeededEvent(opId: string): CanonicalEvent {
	return { opId, seq: ++seq, type: "state_changed", ts: new Date().toISOString(), body: { from: "running", to: "succeeded", reason: "done" } };
}

/** One whole chat turn ending: a fresh `chat_turn` op reaching `succeeded`,
 *  the shape chat-runner/create-op.ts produces and the canonical loop
 *  projects. Production releases each turn's op at the bridge's terminal
 *  branch; these deliberately stay tracked, which is the WORST case for the
 *  per-peer scan the cost pin measures. */
function chatTurnTerminal(sessionId: string): CanonicalEvent {
	return succeededEvent(makeTrackedOp("chat_turn", sessionId));
}

/** Create a real deliverable and enroll it — the fingerprint stats it, so it
 *  must exist on disk. */
function addDeliverable(sessionId: string, name = `chat-report-${seq++}.xlsx`): string {
	const path = join(laxDir, name);
	writeFileSync(path, "cells", "utf-8");
	recordTaskArtifact(sessionId, path);
	return path;
}

/** The turn where the agent scraped external figures and wrote the file. */
function deliverableProducingTurn(sessionId: string, name?: string): string {
	recordExternalIngestion(sessionId);
	return addDeliverable(sessionId, name);
}

const settle = (): Promise<unknown> => new Promise((resolve) => setImmediate(resolve));

/** Elapse the session's quiet period, then let the submission settle. Only
 *  setTimeout/clearTimeout are faked (clearTimeout too, or the debounce's
 *  cancel-and-re-arm would leave the original timer live), so `settle`
 *  (setImmediate) is still real. */
async function flushDebounce(): Promise<void> {
	vi.advanceTimersByTime(VERIFICATION_DEBOUNCE_MS);
	await settle();
}

let calls: SubmitInput[] = [];
_setVerificationSubmitterForTests(async (input) => { calls.push(input); return true; });

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => {
	calls = [];
	probe.on = false;
	_resetVerificationTriggerForTests(); // clears armed timers — while they are still fake
	for (const id of trackedOps.splice(0)) releaseOpFromSession(id);
	for (const sessionId of usedSessions.splice(0)) {
		clearExternalIngestion(sessionId);
		clearTaskArtifacts(sessionId);
		cancelIdleNudge(sessionId);
	}
	vi.useRealTimers();
});
afterAll(() => _setVerificationSubmitterForTests(null));

describe("verification trigger — chat turns are eligible", () => {
	it("a chat turn that builds a deliverable submits ONE verification, scoped to it", async () => {
		const sessionId = makeSession();
		const deliverable = deliverableProducingTurn(sessionId);

		recordVerificationTrigger(chatTurnTerminal(sessionId));
		expect(calls).toHaveLength(0); // armed, waiting for the session to go quiet
		await flushDebounce();

		expect(calls).toHaveLength(1);
		expect(calls[0]!.sessionId).toBe(sessionId);
		expect(calls[0]!.parentOp.type).toBe("chat_turn");
		expect(calls[0]!.deliverables).toEqual([deliverable]);
	});

	it("a LATER chat turn that adds a deliverable re-fires with the delta-only brief", async () => {
		const sessionId = makeSession();
		const first = deliverableProducingTurn(sessionId);
		recordVerificationTrigger(chatTurnTerminal(sessionId));
		await flushDebounce();
		expect(calls).toHaveLength(1);

		// Three ordinary conversational turns in between — the user asking
		// follow-up questions about the sheet. Nothing changed on disk.
		for (let i = 0; i < 3; i++) {
			recordVerificationTrigger(chatTurnTerminal(sessionId));
			await flushDebounce();
		}
		expect(calls).toHaveLength(1);

		// Now the user asks for a second sheet, built in-turn.
		const second = addDeliverable(sessionId, `chat-followup-${seq++}.csv`);
		recordVerificationTrigger(chatTurnTerminal(sessionId));
		await flushDebounce();

		expect(calls).toHaveLength(2);
		expect(calls[1]!.parentOp.type).toBe("chat_turn");
		expect(calls[1]!.deliverables).toEqual([second]);
		expect(calls[1]!.deliverables).not.toContain(first);
		// The brief the submit builds from that input carries the delta ONLY —
		// the already-verified sheet is not re-audited.
		const brief = buildVerificationBrief({ deliverables: calls[1]!.deliverables, parentTask: calls[1]!.parentOp.task });
		expect(brief).toContain(second);
		expect(brief).not.toContain(first);
		expect(brief).toContain("VERDICT: CONFIRMED | DISCREPANCIES | UNVERIFIABLE");
	});

	it("nothing is submitted mid-turn — only the chat turn's succeeded terminal arms", async () => {
		const sessionId = makeSession();
		deliverableProducingTurn(sessionId);
		const opId = makeTrackedOp("chat_turn", sessionId);

		// Everything a chat turn emits while the reply is still streaming.
		const inFlight: Pick<CanonicalEvent, "type" | "body">[] = [
			{ type: "state_changed", body: { from: null, to: "queued" } },
			{ type: "state_changed", body: { from: "queued", to: "running" } },
			{ type: "turn_started", body: { turnIdx: 0 } },
			{ type: "message_appended", body: { role: "assistant" } },
			{ type: "turn_committed", body: { turnIdx: 0, tools: [{ tool: "spreadsheet", status: "ok" }] } },
			{ type: "state_changed", body: { from: "running", to: "paused" } },
		];
		for (const ev of inFlight) {
			recordVerificationTrigger({ opId, seq: ++seq, ts: new Date().toISOString(), ...ev } as CanonicalEvent);
		}
		expect(vi.getTimerCount()).toBe(0); // nothing even armed while the turn runs
		await flushDebounce();
		expect(calls).toHaveLength(0); // the turn in flight is never interrupted

		recordVerificationTrigger(succeededEvent(opId));
		await flushDebounce();
		expect(calls).toHaveLength(1); // armed at the terminal, submitted once quiet
	});
});

describe("verification trigger — the COUNT bound (session-idle debounce)", () => {
	it("20 consecutive edit turns on ONE deliverable submit exactly one verification, over the final state", async () => {
		const sessionId = makeSession();
		const deliverable = deliverableProducingTurn(sessionId);
		recordVerificationTrigger(chatTurnTerminal(sessionId));

		// 19 more turns, each REWRITING the same file. Content length differs
		// every time, so mtime:size is a fresh fingerprint delta on every turn
		// — exactly the case that used to buy one verification per save.
		let lastTurnOpId = "";
		for (let i = 1; i < 20; i++) {
			writeFileSync(deliverable, `cells v${i}`.padEnd(24 + i, "x"), "utf-8");
			// The user is still iterating: each turn lands inside the window.
			vi.advanceTimersByTime(VERIFICATION_DEBOUNCE_MS / 2);
			const event = chatTurnTerminal(sessionId);
			lastTurnOpId = event.opId;
			recordVerificationTrigger(event);
			expect(calls).toHaveLength(0); // nothing spent mid-run, on any turn
		}

		await flushDebounce();
		expect(calls).toHaveLength(1);
		// The UNION of everything that changed, deduped by path — one file.
		expect(calls[0]!.deliverables).toEqual([deliverable]);
		// Lineage and the brief's parent-task line come from the turn the user
		// STOPPED at, not the one that started the run.
		expect(calls[0]!.parentOp.id).toBe(lastTurnOpId);
		// The brief is path-scoped and the verifier reads at run time, so what
		// it audits is what is on disk now: the final state.
		expect(readFileSync(deliverable, "utf-8")).toContain("v19");

		// And the FINAL state is what got fingerprinted — a further quiet turn
		// re-spends nothing. (Had v1's signature been recorded instead, this
		// would fire a second verification.)
		recordVerificationTrigger(chatTurnTerminal(sessionId));
		await flushDebounce();
		expect(calls).toHaveLength(1);
	});

	it("an edit landing mid-window restarts the quiet period rather than adding a verification", async () => {
		const sessionId = makeSession();
		const deliverable = deliverableProducingTurn(sessionId);
		recordVerificationTrigger(chatTurnTerminal(sessionId));

		// Just short of the window, the user saves again.
		vi.advanceTimersByTime(VERIFICATION_DEBOUNCE_MS - 1);
		writeFileSync(deliverable, "cells edited once more", "utf-8");
		recordVerificationTrigger(chatTurnTerminal(sessionId));

		// The ORIGINAL deadline passes — but it was cancelled and re-armed.
		vi.advanceTimersByTime(2);
		await settle();
		expect(calls).toHaveLength(0);

		await flushDebounce();
		expect(calls).toHaveLength(1);
		expect(calls[0]!.deliverables).toEqual([deliverable]);
	});

	it("a session whose turns change nothing never arms a timer at all", async () => {
		const sessionId = makeSession();
		deliverableProducingTurn(sessionId);
		recordVerificationTrigger(chatTurnTerminal(sessionId));
		await flushDebounce();
		expect(calls).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);

		for (let i = 0; i < 5; i++) recordVerificationTrigger(chatTurnTerminal(sessionId));
		expect(vi.getTimerCount()).toBe(0); // no delta → no timer after the session's last op
		await flushDebounce();
		expect(calls).toHaveLength(1);
	});
});

describe("verification trigger — the per-turn cost of chat-turn eligibility", () => {
	const CONVERSATIONAL_TURNS = 50;

	it(`${CONVERSATIONAL_TURNS} conversational turns after one deliverable turn submit exactly once`, async () => {
		const sessionId = makeSession();
		const deliverable = deliverableProducingTurn(sessionId);

		recordVerificationTrigger(chatTurnTerminal(sessionId));
		await flushDebounce();
		expect(calls).toHaveLength(1);
		expect(calls[0]!.deliverables).toEqual([deliverable]);

		for (let i = 0; i < CONVERSATIONAL_TURNS; i++) {
			recordVerificationTrigger(chatTurnTerminal(sessionId));
			await flushDebounce();
		}

		expect(calls).toHaveLength(1);
	});

	it("a conversational turn costs ONE op read + one stat per deliverable, and never scans peer ops", async () => {
		const sessionId = makeSession();
		// Three deliverables: the stat scan is bounded by the ARTIFACT set…
		deliverableProducingTurn(sessionId);
		addDeliverable(sessionId, `cost-b-${seq++}.csv`);
		addDeliverable(sessionId, `cost-c-${seq++}.docx`);
		recordVerificationTrigger(chatTurnTerminal(sessionId));
		// Let the window elapse so the fingerprint is RECORDED: the measured
		// turns below must reach it, not stop one guard earlier.
		await flushDebounce();
		expect(calls).toHaveLength(1);

		// …and NOT by the session's op set. Twenty peer ops: under the old
		// guard order (live-verifier scan before the fingerprint) each of them
		// was a readOp — existsSync + readFileSync + JSON.parse of a whole
		// operation.json — on EVERY subsequent turn.
		for (let i = 0; i < 20; i++) makeTrackedOp("freeform", sessionId);
		const turnOpId = makeTrackedOp("chat_turn", sessionId);

		const TURNS = 200;
		probe.statSync = 0;
		probe.readOp = 0;
		probe.listOpsForSession = 0;
		probe.on = true;
		const startedAt = performance.now();
		for (let i = 0; i < TURNS; i++) recordVerificationTrigger(succeededEvent(turnOpId));
		const elapsedMs = performance.now() - startedAt;
		probe.on = false;

		expect(calls).toHaveLength(1);                    // no turn changed anything → no spend
		expect(probe.readOp).toBe(TURNS);                 // exactly the terminating op itself
		expect(probe.listOpsForSession).toBe(0);          // the per-peer DISK scan is never reached
		expect(probe.statSync).toBe(TURNS * 3);           // one per deliverable, independent of the 21 peers

		// Wall-clock evidence for the same claim. Measured on this box: ~35us
		// per conversational turn (counting proxies included). The avoided
		// half is the bigger number — 21 readOp of a 4.3KB operation.json is
		// ~438us/turn, against ~8us for the three stats that replace it. The
		// 5ms ceiling is ~2 orders of magnitude of headroom, so it fails on a
		// real regression (a reintroduced per-peer scan), not on a busy CI box.
		expect(elapsedMs / TURNS).toBeLessThan(5);
	});
});

describe("verification trigger — the verifier cannot arm its parent chat session", () => {
	it("a verifier's own worker-scoped session absorbs its ingestion and its writes", async () => {
		const chatSession = makeSession();
		// The id verification-submit.ts borrows for the verifier's TOOL RUNTIME
		// (verificationRuntimeSessionId; pinned against the real submit with a
		// chat parent in test/verification-pass.contract.test.ts).
		const verifyOpId = `op_verify_deliverable_chat_${seq++}`;
		const runtimeSession = `agent-op-${verifyOpId}`;
		usedSessions.push(runtimeSession);
		expect(isWorkerScopedSession(runtimeSession)).toBe(true);

		// The verifier does exactly what a verifier does: fetches independent
		// sources (external ingestion) and writes its own scratch notes.
		recordExternalIngestion(runtimeSession);
		addDeliverable(runtimeSession, `verifier-notes-${seq++}.md`);

		// The parent CHAT session stays clean on both axes…
		expect(hasExternalIngestion(chatSession)).toBe(false);
		expect(listTaskArtifacts(chatSession)).toEqual([]);

		// …so the user's next chat turn is not a verification candidate. Without
		// the split, a verifier's own fetch+write would arm the chat session and
		// every later turn would re-verify the verifier's scratch notes —
		// compounding, on the surface where the user is watching.
		recordVerificationTrigger(chatTurnTerminal(chatSession));
		await flushDebounce();
		expect(calls).toHaveLength(0);
	});
});
