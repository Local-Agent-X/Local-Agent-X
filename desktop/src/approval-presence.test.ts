// The three places a chat's approval card reaches its person (approval-presence.ts):
// the chat only while LAX is in front, a toast + taskbar flash while the
// computer is in use with LAX behind, the phone once nobody has touched the
// computer for a minute. Nothing reaches the phone while the computer is in use.
import { describe, expect, it, vi } from "vitest";
import {
	createApprovalPresence, PHONE_AFTER_IDLE_MS, PRESENCE_TICK_MS, TOAST_GRACE_MS, type PendingCard,
} from "./approval-presence";

const card: PendingCard = { approvalId: "apr-1", sessionId: "chat-1", context: "Sending key.json to expo.dev needs your approval.", toolName: "browser" };

function rig(opts: { inFront?: boolean; idleMs?: number } = {}) {
	let now = 1_000;
	const state = { inFront: opts.inFront ?? false, idleMs: opts.idleMs ?? 0 };
	const close = vi.fn();
	const deps = {
		now: () => now,
		inFront: () => state.inFront,
		idleMs: () => state.idleMs,
		toast: vi.fn(() => ({ close })),
		flash: vi.fn(),
		sendAway: vi.fn(),
	};
	const presence = createApprovalPresence(deps);
	const advance = (ms: number) => { now += ms; presence.tick(); };
	return { presence, deps, state, close, advance };
}

describe("approval presence", () => {
	it("LAX in front: no toast, no flash, no phone, however long the card waits", () => {
		const { presence, deps, advance } = rig({ inFront: true, idleMs: 0 });
		presence.pending(card);
		for (let t = 0; t < 4 * PHONE_AFTER_IDLE_MS; t += PRESENCE_TICK_MS) advance(PRESENCE_TICK_MS);
		expect(deps.toast).not.toHaveBeenCalled();
		expect(deps.flash).not.toHaveBeenCalledWith(true);
		expect(deps.sendAway).not.toHaveBeenCalled();
	});

	it("LAX behind another window, computer in use: one toast and a flash after the grace, never the phone", () => {
		const { presence, deps, advance } = rig({ inFront: false, idleMs: 500 });
		presence.pending(card);
		advance(TOAST_GRACE_MS - 1);
		expect(deps.toast).not.toHaveBeenCalled();
		advance(1);
		expect(deps.toast).toHaveBeenCalledTimes(1);
		expect(deps.toast).toHaveBeenCalledWith(card);
		expect(deps.flash).toHaveBeenLastCalledWith(true);
		for (let t = 0; t < 4 * PHONE_AFTER_IDLE_MS; t += PRESENCE_TICK_MS) advance(PRESENCE_TICK_MS);
		expect(deps.toast).toHaveBeenCalledTimes(1);
		expect(deps.sendAway).not.toHaveBeenCalled();
	});

	it("a card answered within the grace raises nothing", () => {
		const { presence, deps, advance } = rig({ inFront: false });
		presence.pending(card);
		advance(TOAST_GRACE_MS - 500);
		presence.settled(card.approvalId);
		advance(TOAST_GRACE_MS);
		expect(deps.toast).not.toHaveBeenCalled();
		expect(presence.size()).toBe(0);
	});

	it("nobody at the computer: the phone is told once, after the card and the computer have both waited a minute", () => {
		const { presence, deps, state, advance } = rig({ inFront: false, idleMs: 0 });
		presence.pending(card);
		advance(PHONE_AFTER_IDLE_MS); // the card has waited a minute, but the computer was in use
		expect(deps.sendAway).not.toHaveBeenCalled();
		state.idleMs = PHONE_AFTER_IDLE_MS;
		advance(PRESENCE_TICK_MS);
		expect(deps.sendAway).toHaveBeenCalledWith("apr-1");
		advance(PRESENCE_TICK_MS);
		expect(deps.sendAway).toHaveBeenCalledTimes(1);
	});

	it("an answer anywhere closes the toast and stops the flash", () => {
		const { presence, deps, close, advance } = rig({ inFront: false });
		presence.pending(card);
		advance(TOAST_GRACE_MS);
		presence.settled(card.approvalId);
		expect(close).toHaveBeenCalledTimes(1);
		expect(deps.flash).toHaveBeenLastCalledWith(false);
	});

	it("coming back to LAX stops the flash while the card still waits", () => {
		const { presence, deps, state, advance } = rig({ inFront: false });
		presence.pending(card);
		advance(TOAST_GRACE_MS);
		state.inFront = true;
		advance(PRESENCE_TICK_MS);
		expect(deps.flash).toHaveBeenLastCalledWith(false);
	});

	it("a card past its deadline leaves on its own when no settle arrives (its turn was torn down)", () => {
		const { presence, deps, close, advance } = rig({ inFront: false });
		presence.pending({ ...card, expiresAt: 1_000 + TOAST_GRACE_MS + 10 });
		advance(TOAST_GRACE_MS);
		expect(deps.toast).toHaveBeenCalledTimes(1);
		advance(PRESENCE_TICK_MS);
		expect(presence.size()).toBe(0);
		expect(close).toHaveBeenCalledTimes(1);
		expect(deps.flash).toHaveBeenLastCalledWith(false);
	});

	it("thresholds stay where Peter set them", () => {
		expect(TOAST_GRACE_MS).toBe(3_000);
		expect(PHONE_AFTER_IDLE_MS).toBe(60_000);
		expect(PRESENCE_TICK_MS).toBeLessThanOrEqual(TOAST_GRACE_MS);
	});
});
