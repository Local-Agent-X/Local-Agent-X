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

const here = dirname(fileURLToPath(import.meta.url));
const appsJs = readFileSync(join(here, "../public/js/apps.js"), "utf8");
const CAPABILITY = "connector-capability-value";

async function exportServed(served: string): Promise<string> {
	let blob: Blob | null = null;
	const URLShim = { createObjectURL: (b: Blob) => { blob = b; return "blob:x"; }, revokeObjectURL: () => {} };
	const fetchShim = async () => ({ ok: true, text: async () => served });
	const exportApp = new Function(
		"fetch", "URL", "laxAgentReady", "laxAgent", "alert",
		`${appsJs}\nreturn exportApp;`,
	)(fetchShim, URLShim, Promise.resolve(), { origin: "http://127.0.0.1:51234" }, (m: string) => { throw new Error(m); });
	await exportApp("demo", "Demo");
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
});
