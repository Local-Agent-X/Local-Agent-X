/**
 * Cross-seam contract: the FULL durable-approval cycle across a simulated
 * server restart. Sibling of approval-recovery.test.ts (recovery semantics)
 * and control-api-approvals.test.ts (substrate) — this file drives every
 * seam END TO END in one story:
 *
 *   ask (approval-manager → control-api-approvals column + event)
 *     → crash (fresh module registry: in-process pending map + timers die,
 *       the disk column and canonical events are the only survivors)
 *     → rediscovery (routes/approvals.ts buildPendingApprovals)
 *     → post-restart answer (chat-ws/approval-durable-resolve.ts →
 *       opResolveApproval, decision stored ON the column, delivery "recorded")
 *     → pending route hides the answered card (double-answer guard)
 *     → recovery re-drive re-asks the same tool call and
 *       reconcileRecoveredAsk applies the recorded decision — no new card
 *   plus the negative twin: a recorded decision whose window expired before
 *   the re-drive is NOT applied — old record settles as timeout, fresh card,
 *   fresh honest window.
 *
 * The crash is vi.resetModules() + re-import: every in-process singleton
 * (ApprovalManager pending map, durable bridge cache) is rebuilt from
 * nothing, exactly like a process restart, while LAX_DATA_DIR keeps the
 * disk state. The pre-crash card's 5-min timer is created under fake timers
 * and discarded by useRealTimers() so its settle path can never fire and
 * clear the column behind the "dead" process's back.
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocket } from "ws";
import type { Op } from "../ops/types.js";
import type { ServerEvent } from "../types.js";

// op-store binds OPS_BASE = join(getLaxDir(), …) at import, so the env
// override must be in place BEFORE the dynamic imports below.
const prevLaxDir = process.env.LAX_DATA_DIR;
const dataDir = mkdtempSync(join(tmpdir(), "lax-approval-cycle-"));
process.env.LAX_DATA_DIR = dataDir;
afterAll(() => {
	if (prevLaxDir === undefined) delete process.env.LAX_DATA_DIR;
	else process.env.LAX_DATA_DIR = prevLaxDir;
	rmSync(dataDir, { recursive: true, force: true });
});

/** Everything the cycle touches, bound to ONE module registry. Reloaded
 *  after vi.resetModules() to simulate the restarted process. Loaded under
 *  REAL timers so no module-eval await can hang on a faked clock. */
async function loadWorld() {
	const canonical = await import("./index.js");
	const opStore = await import("../ops/op-store.js");
	const mgrMod = await import("../approval-manager.js");
	const durable = await import("../chat-ws/approval-durable-resolve.js");
	const routes = await import("../routes/approvals.js");
	return { canonical, opStore, mgr: mgrMod.getApprovalManager(), durable, routes };
}
let w = await loadWorld();
const { APPROVAL_TIMEOUT_MS } = await import("../approval-manager.js");

let seq = 0;
const uid = (label: string) => `${label}-${++seq}-${process.hrtime.bigint().toString(36)}`;

const mkOp = (id: string, over: Partial<Op> = {}): Op => ({
	id,
	type: "freeform",
	task: "do the thing",
	contextPack: {} as Op["contextPack"],
	lane: "interactive" as Op["lane"],
	retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
	ownerId: "u",
	visibility: "private" as Op["visibility"],
	status: "pending" as Op["status"],
	createdAt: new Date().toISOString(),
	attemptCount: 0,
	...over,
});

function mkWs() {
	const sent: string[] = [];
	const ws = { send: (p: string) => { sent.push(p); } } as unknown as WebSocket;
	return { ws, frames: () => sent.map(p => JSON.parse(p) as Record<string, unknown>) };
}

function resolvedEvents(opId: string) {
	return w.canonical.readCanonicalEvents(opId).filter(e => e.type === "approval_resolved");
}

/** Ask through the CURRENT world's manager with an opId, waiting until the
 *  card exists. */
async function askOpScoped(opId: string, sessionId: string, args: Record<string, unknown>, toolName = "bash") {
	const events: ServerEvent[] = [];
	let approvalId = "";
	let sawCard: () => void = () => {};
	const cardSeen = new Promise<void>(res => { sawCard = res; });
	const outcome = w.mgr.requestApprovalDetailed({
		toolName,
		toolCallId: "tc-1",
		sessionId,
		context: "test ask",
		args,
		alwaysAsk: true,
		opId,
		emit: (e) => {
			events.push(e);
			if (e.type === "approval_requested") { approvalId = e.approvalId; sawCard(); }
		},
	});
	await cardSeen;
	return { outcome, events, approvalId: () => approvalId };
}

const pendingFor = (opId: string, now?: number) =>
	w.routes.buildPendingApprovals(w.canonical.listActiveCanonicalOps(), now)
		.filter(e => e.opId === opId);

describe("durable approval restart cycle", () => {
	// Cycle state shared across the sequential steps below.
	const opId = uid("op-cycle");
	const sessionId = uid("sess-cycle");
	const args = { command: `echo cycle-${opId}` };
	const argsPreview = JSON.stringify(args);
	let approvalId = "";
	let requestedAt = 0;

	it("step 1 — op-scoped ask writes the pendingApproval column + approval_requested event", async () => {
		// Op shape at crash time: canonical, active, NO lease (expired with the
		// dead worker) — listActiveCanonicalOps needs flagValue + active state.
		w.opStore.writeOp(mkOp(opId, {
			status: "running",
			canonical: { flagValue: true, state: "running", sessionId },
		}));

		// Fake timers so the crash can discard this card's 5-min timer without
		// letting its timeout path fire and durably clear the column.
		vi.useFakeTimers();
		const ask = await askOpScoped(opId, sessionId, args);
		approvalId = ask.approvalId();
		expect(approvalId).not.toBe("");

		const column = w.canonical.readPendingApproval(opId);
		expect(column).toMatchObject({
			approvalId,
			toolName: "bash",
			toolCallId: "tc-1",
			argsPreview,
			context: "test ask",
		});
		expect(typeof column?.requestedAt).toBe("number");
		expect(column?.resolution).toBeUndefined();
		requestedAt = column!.requestedAt;

		const events = w.canonical.readCanonicalEvents(opId);
		expect(events.map(e => e.type)).toEqual(["approval_requested"]);
		expect(events[0].body).toEqual({ approvalId, toolName: "bash" });
	});

	it("step 2 — simulated crash: fresh process state, column + events survive on disk", async () => {
		// The "process" dies: pending map, resolve closures and the card's
		// timer all go. useRealTimers() discards the never-advanced fake timer,
		// so the dead card can never settle itself.
		vi.useRealTimers();
		vi.resetModules();
		w = await loadWorld();

		expect(w.mgr.pendingCount()).toBe(0);
		// The restarted manager has never heard of the pre-crash card.
		expect(w.mgr.resolveApproval(approvalId, true)).toBe(false);

		// Disk survivors: the column and the ask event.
		expect(w.canonical.readPendingApproval(opId)).toMatchObject({ approvalId, argsPreview });
		expect(w.canonical.readCanonicalEvents(opId).map(e => e.type)).toEqual(["approval_requested"]);
	});

	it("step 3 — rediscovery surfaces the card with the ORIGINAL window's expiresAt", () => {
		const entries = pendingFor(opId);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toEqual({
			opId,
			sessionId,
			approvalId,
			toolName: "bash",
			argsPreview,
			context: "test ask",
			requestedAt,
			expiresAt: requestedAt + APPROVAL_TIMEOUT_MS,
		});
	});

	it("step 4 — post-restart answer via WS durable resolve: decision stored ON the column, delivery recorded", async () => {
		const { ws, frames } = mkWs();
		await w.durable.resolveDurableApproval(ws, approvalId, true, false, opId);

		expect(frames()).toEqual([{
			type: "approval_resolved",
			approvalId,
			toolName: "bash",
			approved: true,
			delivery: "recorded",
		}]);

		// The column is NOT cleared — the decision rides on it for recovery's
		// re-ask to consume.
		const column = w.canonical.readPendingApproval(opId);
		expect(column?.approvalId).toBe(approvalId);
		expect(column?.resolution?.approved).toBe(true);
		expect(typeof column?.resolution?.resolvedAt).toBe("number");

		const resolved = resolvedEvents(opId);
		expect(resolved).toHaveLength(1);
		expect(resolved[0].body).toEqual({
			approvalId,
			toolName: "bash",
			approved: true,
			delivery: "recorded",
		});
	});

	it("step 5 — pending route hides the answered card (double-answer guard)", () => {
		expect(pendingFor(opId)).toEqual([]);
	});

	it("step 6 — recovery re-ask (same fingerprint, in window) applies the recorded decision without a new card", async () => {
		const logSpy = vi.spyOn(console, "log");
		try {
			const events: ServerEvent[] = [];
			const outcome = await w.mgr.requestApprovalDetailed({
				toolName: "bash",
				toolCallId: "tc-1",
				sessionId: uid("sess-redrive"),
				context: "test ask",
				args,
				alwaysAsk: true,
				opId,
				emit: (e) => events.push(e),
			});

			expect(outcome).toEqual({ approved: true });
			// No card went up, the column was consumed, and NO second
			// approval_resolved was appended (step 4's recorded event already
			// documents the settlement).
			expect(events).toHaveLength(0);
			expect(w.canonical.readPendingApproval(opId)).toBeNull();
			expect(resolvedEvents(opId)).toHaveLength(1);
			expect(w.canonical.readCanonicalEvents(opId).map(e => e.type))
				.toEqual(["approval_requested", "approval_resolved"]);
			expect(logSpy.mock.calls.some(c => String(c[0]).includes("applying recorded approval from restart"))).toBe(true);
		} finally {
			logSpy.mockRestore();
		}
	});

	it("negative twin — recorded decision whose window EXPIRED before the re-drive → fresh card, fresh window", async () => {
		const twinOpId = uid("op-twin");
		const twinSession = uid("sess-twin");
		const twinArgs = { command: `echo twin-${twinOpId}` };
		const twinPreview = JSON.stringify(twinArgs);
		const deadId = "apr-dead-twin";
		const twinRequestedAt = Date.now() - 60_000; // in window at answer time

		// Crash survivor written the way a dead process leaves it.
		w.opStore.writeOp(mkOp(twinOpId, {
			status: "running",
			canonical: {
				flagValue: true,
				state: "running",
				sessionId: twinSession,
				pendingApproval: {
					approvalId: deadId,
					toolName: "bash",
					toolCallId: "tc-crashed",
					argsPreview: twinPreview,
					context: "test ask",
					requestedAt: twinRequestedAt,
				},
			},
		}));

		// User answers the rediscovered card while its window is still open…
		expect(pendingFor(twinOpId)).toHaveLength(1);
		const { ws, frames } = mkWs();
		await w.durable.resolveDurableApproval(ws, deadId, true, false, twinOpId);
		expect(frames()[0]).toMatchObject({ type: "approval_resolved", approvalId: deadId, delivery: "recorded" });
		expect(resolvedEvents(twinOpId)).toHaveLength(1);

		// …but the window closes before recovery re-drives the turn.
		vi.useFakeTimers();
		try {
			vi.setSystemTime(Date.now() + APPROVAL_TIMEOUT_MS); // 60s past expiry
			const now = Date.now();

			const ask = await askOpScoped(twinOpId, twinSession, twinArgs);
			const freshId = ask.approvalId();

			// The stale decision is NOT applied: old record settles as timeout…
			expect(freshId).not.toBe(deadId);
			const resolved = resolvedEvents(twinOpId);
			expect(resolved).toHaveLength(2);
			expect(resolved[1].body).toEqual({
				approvalId: deadId,
				toolName: "bash",
				approved: false,
				reason: "timeout",
				delivery: "recorded",
			});

			// …and the fresh card owns a fresh, honest window.
			const column = w.canonical.readPendingApproval(twinOpId);
			expect(column?.approvalId).toBe(freshId);
			expect(column?.resolution).toBeUndefined();
			expect(column?.requestedAt).toBe(now);
			const entries = pendingFor(twinOpId, now);
			expect(entries).toHaveLength(1);
			expect(entries[0]).toMatchObject({ approvalId: freshId, expiresAt: now + APPROVAL_TIMEOUT_MS });

			// The fresh card is answerable end-to-end.
			expect(w.mgr.resolveApproval(freshId, true)).toBe(true);
			await expect(ask.outcome).resolves.toMatchObject({ approved: true });
			expect(w.canonical.readPendingApproval(twinOpId)).toBeNull();
			expect(resolvedEvents(twinOpId)).toHaveLength(3);
		} finally {
			vi.useRealTimers();
		}
	});
});
