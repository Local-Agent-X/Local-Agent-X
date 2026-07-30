import { beforeEach, describe, expect, it, vi } from "vitest";

const seam = vi.hoisted(() => ({
	manager: {} as Record<string, unknown>,
	closeBrowser: vi.fn(async () => {}),
}));

vi.mock("../../browser/index.js", () => ({
	getBrowserManager: () => seam.manager,
	closeBrowser: seam.closeBrowser,
	withBrowserLock: (_sid: string, fn: () => Promise<unknown>) => fn(),
	resetWedgedBrowser: vi.fn(async () => "recovered-in-place"),
	BrowserWedgeError: class BrowserWedgeError extends Error {},
}));

import { createBrowserTools } from "./index.js";

const CHALLENGE_OBSERVATION = {
	title: "Just a moment...",
	url: "https://dash.cloudflare.com/",
	currentRefs: [{ id: 1, role: "checkbox", name: "Verify you are human" }],
	crossOriginIframes: [],
};

function tool() {
	const [browser] = createBrowserTools(() => "challenge-session");
	return browser;
}

beforeEach(() => {
	for (const key of Object.keys(seam.manager)) delete seam.manager[key];
	seam.closeBrowser.mockClear();
	seam.manager.getCurrentUrl = () => "https://dash.cloudflare.com/";
	seam.manager.observe = vi.fn(async () => CHALLENGE_OBSERVATION);
});

describe("browser human-verification dispatch gate", () => {
	it.each([
		["click", { selector: "#verify" }, "click"],
		["click_text", { text: "Verify you are human" }, "clickText"],
		["fill", { selector: "#answer", value: "x" }, "fill"],
		["select", { selector: "#answer", value: "x" }, "select"],
		["scroll", { direction: "down" }, "scroll"],
		["act", { instruction: "complete the verification" }, "act"],
		["evaluate", { script: "document.title" }, "evaluate"],
		["dialog_accept", {}, "dialogAccept"],
		["dialog_dismiss", {}, "dialogDismiss"],
	])("blocks %s before backend dispatch", async (action, args, method) => {
		const dispatch = vi.fn(async () => "dispatched");
		seam.manager[method] = dispatch;

		const result = await tool().execute({ action, ...args, _sessionId: "challenge-session" });

		expect(result.metadata?.browserStatus).toBe("human-verification-required");
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("allows navigation away without scanning or interacting with the challenge", async () => {
		const navigate = vi.fn(async () => "Navigated away.");
		const snapshot = vi.fn(async () => "Page: Example — https://example.com/");
		seam.manager.navigate = navigate;
		seam.manager.snapshot = snapshot;

		const result = await tool().execute({
			action: "navigate",
			url: "https://example.com/",
			_sessionId: "challenge-session",
		});

		expect(navigate).toHaveBeenCalledWith("https://example.com/", undefined);
		expect(seam.manager.observe).not.toHaveBeenCalled();
		expect(result.isError).not.toBe(true);
	});

	it("allows closing the browser session", async () => {
		const result = await tool().execute({ action: "close", _sessionId: "challenge-session" });

		expect(seam.closeBrowser).toHaveBeenCalledWith("challenge-session");
		expect(seam.manager.observe).not.toHaveBeenCalled();
		expect(result.content).toBe("Browser session closed.");
	});

	it("keeps non-scripted reads available", async () => {
		const listTabs = vi.fn(async () => "* [0] Just a moment...");
		seam.manager.listTabs = listTabs;

		const result = await tool().execute({ action: "tabs", _sessionId: "challenge-session" });

		expect(listTabs).toHaveBeenCalledOnce();
		expect(seam.manager.observe).not.toHaveBeenCalled();
		expect(result.content).toContain("Just a moment");
	});
});
