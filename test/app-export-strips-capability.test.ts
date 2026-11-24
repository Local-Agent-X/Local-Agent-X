// @vitest-environment happy-dom
//
// Exporting an app downloads a standalone HTML file the user may share. The
// served page carries the live connector capability, injected by the server;
// the exported file must not.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectorBootstrapScript } from "../src/server/app-serving-policy.js";
import { appChatClientScript } from "../src/server/app-chat-inject.js";
import { deriveAppChatCapability } from "../src/server/app-connector-auth.js";

const here = dirname(fileURLToPath(import.meta.url));
const appsJs = readFileSync(join(here, "../public/js/apps.js"), "utf8");
const CAPABILITY = "connector-capability-value";
const APP_ORIGIN = "http://127.0.0.1:51300";

async function exportServed(served: string): Promise<string> {
	let blob: Blob | null = null;
	const URLShim = { createObjectURL: (b: Blob) => { blob = b; return "blob:x"; }, revokeObjectURL: () => {} };
	const fetched: string[] = [];
	const fetchShim = async (url: string) => { fetched.push(url); return { ok: true, text: async () => served }; };
	const exportApp = new Function(
		"fetch", "URL", "laxAgentReady", "laxAppOrigin", "alert",
		`${appsJs}\nreturn exportApp;`,
	)(fetchShim, URLShim, Promise.resolve(), async (id: string) => (id === "demo" ? APP_ORIGIN : ""), (m: string) => { throw new Error(m); });
	await exportApp("demo", "Demo");
	// Read from the app's own origin, the one that serves it.
	expect(fetched).toEqual([`${APP_ORIGIN}/apps/demo`]);
	if (!blob) throw new Error("no download");
	return (blob as Blob).text();
}

describe("app export", () => {
	it("drops the connector capability the server injected and keeps the app", async () => {
		const served = `<html><head>${connectorBootstrapScript(CAPABILITY)}<title>Demo</title></head><body><h1>Hi</h1></body></html>`;
		const out = await exportServed(served);
		expect(out).not.toContain(CAPABILITY);
		expect(out).not.toContain("__LAX_CONNECTOR_TOKEN__");
		expect(out).toContain("<title>Demo</title>");
		expect(out).toContain("<h1>Hi</h1>");
	});

	it("drops the app's chat client and its capability, and leaves the app's own scripts", async () => {
		const chat = appChatClientScript(join(here, "../public"), "operator-token", "demo");
		expect(chat).toContain("__laxInstallAppChat(");
		const own = "<script>window.mine = 1;</script>";
		const served = `<html><head>${connectorBootstrapScript(CAPABILITY)}${chat}<title>Demo</title>${own}</head><body><h1>Hi</h1></body></html>`;
		const out = await exportServed(served);
		expect(out).not.toContain(deriveAppChatCapability("operator-token", "demo"));
		expect(out).not.toContain("data-lax-app-chat");
		expect(out).not.toContain("__laxInstallAppChat");
		expect(out).toContain(own);
		expect(out).toContain("<h1>Hi</h1>");
	});

	it("the injected chat client cannot close its own script tag, and is injected for an app id only", () => {
		const source = readFileSync(join(here, "../public/js/app-chat-client.js"), "utf8");
		expect(source).not.toMatch(/<\/script/i);
		for (const bad of ["", "a.b", "../x", "a\"b", "x".repeat(65)]) {
			expect(appChatClientScript(join(here, "../public"), "operator-token", bad), bad).toBe("");
		}
	});
});
