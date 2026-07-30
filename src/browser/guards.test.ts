import { describe, expect, it, vi } from "vitest";
import { evaluateBlockMessage, installRequestGuard, scanEvaluateScript } from "./guards.js";

async function captureGuard() {
	let handler: ((route: any, request: any) => Promise<void>) | undefined;
	await installRequestGuard({
		route: vi.fn(async (_pattern: string, fn: typeof handler) => { handler = fn; }),
	} as never);
	if (!handler) throw new Error("guard did not register");
	return handler;
}

function request(url: string, navigation = true, resourceType = "document") {
	return {
		url: () => url,
		isNavigationRequest: () => navigation,
		resourceType: () => resourceType,
	};
}

function route() {
	return {
		abort: vi.fn().mockResolvedValue(undefined),
		continue: vi.fn().mockResolvedValue(undefined),
	};
}

describe("installRequestGuard", () => {
	it("continues an allowed document without rewriting its response", async () => {
		const handler = await captureGuard();
		const r = route();
		await handler(r, request("http://93.184.216.34/"));
		expect(r.continue).toHaveBeenCalledOnce();
		expect(r.abort).not.toHaveBeenCalled();
	});

	it("continues allowed subresources through the same URL policy", async () => {
		const handler = await captureGuard();
		const r = route();
		await handler(r, request("http://93.184.216.34/app.js", false, "script"));
		expect(r.continue).toHaveBeenCalledOnce();
	});

	it("still aborts SSRF destinations", async () => {
		const handler = await captureGuard();
		const r = route();
		await handler(r, request("http://169.254.169.254/latest/meta-data/"));
		expect(r.abort).toHaveBeenCalledWith("blockedbyclient");
		expect(r.continue).not.toHaveBeenCalled();
	});

	it("blocks dangerous top-level schemes but allows page-owned data resources", async () => {
		const handler = await captureGuard();
		const top = route();
		await handler(top, request("file:///etc/passwd"));
		expect(top.abort).toHaveBeenCalledWith("blockedbyclient");

		const image = route();
		await handler(image, request("data:image/png;base64,AA==", false, "image"));
		expect(image.continue).toHaveBeenCalledOnce();
	});
});

describe("scanEvaluateScript", () => {
	it.each([
		"(function(){ return document.title; })()",
		"document.querySelector('main')?.textContent",
		"fetch('/api/data').then(r => r.status)",
	])("allows ordinary DOM inspection: %s", (script) => {
		expect(scanEvaluateScript(script)).toBeNull();
	});

	it.each([
		"document.cookie",
		"localStorage.getItem('token')",
		"new Function('return 1')()",
		"eval('1+1')",
		"new RTCPeerConnection()",
		"new Worker('/worker.js')",
		"window.open('https://example.com')",
	])("blocks restricted evaluate primitive: %s", (script) => {
		expect(scanEvaluateScript(script)).not.toBeNull();
	});

	it("blocks escaped and concatenated spellings", () => {
		expect(scanEvaluateScript("window['ev' + 'al']('1')")).not.toBeNull();
		expect(scanEvaluateScript("window['loc' + '\\u0061lStorage']")).not.toBeNull();
	});
});

describe("evaluateBlockMessage", () => {
	it("gives read-safe guidance for storage access", () => {
		const message = evaluateBlockMessage("\\blocalStorage\\b", "localStorage.getItem('x')");
		expect(message).toContain("extract");
		expect(message).toContain("snapshot");
		expect(message).not.toContain("http_request");
	});

	it("keeps diagnostic excerpts bounded and single-line", () => {
		const message = evaluateBlockMessage("\\beval\\s*\\(", `\n${"x".repeat(500)}eval("1")\n`);
		expect(message).not.toContain("\n");
		expect(message.length).toBeLessThan(600);
	});
});
