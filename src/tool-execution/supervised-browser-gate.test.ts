import { describe, it, expect } from "vitest";
import { assertToolCallAllowed, ToolBlocked, type PreDispatchCtx } from "./pre-dispatch.js";
import type { PreDispatchDeps, PreDispatchRuntimeFlags } from "./pre-dispatch-deps.js";
import { supervisedEvaluateBlock } from "./supervised-browser-gate.js";

// Proves the supervised-browser gate END-TO-END through the shared pre-dispatch
// chain, driven entirely by injected deps (no vi.mock): the runtime flags and
// the current-URL lookup are seams. All other gates are permissive here, so the
// supervised gate is the only one that can fire.

const ALL_ON: PreDispatchRuntimeFlags = {
	localOnlyMode: false,
	enableShell: true,
	enableHttp: true,
	enableBrowser: true,
	enableComputerControl: true,
	supervisedBrowser: false,
};

function deps(over: {
	supervisedBrowser?: boolean;
	url?: string;
}): PreDispatchDeps {
	return {
		checkSessionPolicy: () => null,
		getRuntimeConfig: () => ({ ...ALL_ON, supervisedBrowser: over.supervisedBrowser ?? false }),
		localOnlyToolDecision: () => ({ allowed: true }),
		opForbidsCapability: () => false,
		planModeForbidsCapability: () => false,
		getBrowserCurrentUrl: () => over.url ?? "",
	};
}

function ctx(d: PreDispatchDeps): PreDispatchCtx {
	return { sessionId: "s", callContext: "local", skipSessionPolicy: true, deps: d };
}

const evaluateCall = { id: "e1", name: "browser", args: { action: "evaluate", script: "1+1" } };

describe("supervised browser gate (end-to-end pre-dispatch)", () => {
	it("(b) supervised=true + NON-trusted origin → forced to approval", async () => {
		try {
			await assertToolCallAllowed(evaluateCall, ctx(deps({ supervisedBrowser: true, url: "https://example.com/" })));
			throw new Error("expected ToolBlocked");
		} catch (e) {
			expect(e).toBeInstanceOf(ToolBlocked);
			expect((e as ToolBlocked).disposition).toBe("approval-required");
			expect((e as ToolBlocked).message).toContain("APPROVAL REQUIRED");
			expect((e as ToolBlocked).reason).toContain("Supervised browser mode");
		}
	});

	it("(b') supervised=true + UNKNOWABLE origin (empty url) → fail safe to approval", async () => {
		await expect(
			assertToolCallAllowed(evaluateCall, ctx(deps({ supervisedBrowser: true, url: "" }))),
		).rejects.toBeInstanceOf(ToolBlocked);
	});

	it("(c) supervised=true + TRUSTED origin → NOT forced to approval", async () => {
		await expect(
			assertToolCallAllowed(evaluateCall, ctx(deps({ supervisedBrowser: true, url: "https://x.com/compose" }))),
		).resolves.toBeUndefined();
		await expect(
			assertToolCallAllowed(evaluateCall, ctx(deps({ supervisedBrowser: true, url: "https://mobile.twitter.com/" }))),
		).resolves.toBeUndefined();
	});

	it("(d) supervised=false (default) → NO forcing regardless of origin", async () => {
		for (const url of ["https://example.com/", "https://x.com/", ""]) {
			await expect(
				assertToolCallAllowed(evaluateCall, ctx(deps({ supervisedBrowser: false, url }))),
			).resolves.toBeUndefined();
		}
	});

	it("only gates browser.evaluate — other browser actions pass even untrusted+supervised", async () => {
		const nav = { id: "n1", name: "browser", args: { action: "navigate", url: "https://example.com" } };
		await expect(
			assertToolCallAllowed(nav, ctx(deps({ supervisedBrowser: true, url: "https://example.com/" }))),
		).resolves.toBeUndefined();
	});
});

describe("supervisedEvaluateBlock (unit)", () => {
	const call = { name: "browser", args: { action: "evaluate" } };

	it("returns null when supervision is off", async () => {
		expect(await supervisedEvaluateBlock(false, call, () => "https://example.com/")).toBeNull();
	});

	it("returns a block on a non-trusted origin when supervised", async () => {
		const block = await supervisedEvaluateBlock(true, call, () => "https://example.com/");
		expect(block).not.toBeNull();
		expect(block!.reason).toContain("browser.evaluate");
	});

	it("returns null on a trusted origin when supervised", async () => {
		expect(await supervisedEvaluateBlock(true, call, () => "https://x.com/")).toBeNull();
	});

	it("ignores non-evaluate browser actions and non-browser tools", async () => {
		expect(await supervisedEvaluateBlock(true, { name: "browser", args: { action: "click" } }, () => "https://e.com/")).toBeNull();
		expect(await supervisedEvaluateBlock(true, { name: "read", args: {} }, () => "https://e.com/")).toBeNull();
	});
});
