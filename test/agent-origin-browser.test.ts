// The agent-origin split, observed in a real browser. A stand-in shell page on
// the UI origin holds what the real shell holds (an operator token in
// localStorage, a window.desktop with a terminal) and frames a pinned app
// exactly as app.js does: the real #pin-iframe markup from app.html, the real
// shared-md.js agentFrameTarget, and the real servers (routeUiAgentPaths on
// the UI side, startAgentOrigin on the other). The app then tries everything
// the agent-origin split exists to stop.
//
// Gated on a launchable chromium, like the smoke-gate browser tests.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentOrigin, routeUiAgentPaths, startAgentOrigin } from "../src/server/agent-origin.js";
import type { ServerContext } from "../src/server-context.js";
import type { LAXConfig } from "../src/types.js";

const chromiumAvailable = await (async () => {
	try {
		const { chromium } = await import("playwright");
		await (await chromium.launch({ headless: true })).close();
		return true;
	} catch {
		return false;
	}
})();

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const OP_TOKEN = "op-token-browser-" + "0123456789abcdef";

// The agent's app: it reports what it could reach, then tries to steer the shell.
const APP_HTML = `<!doctype html><html><head><title>evil app</title></head><body><p>app</p><script>
function attempt(fn) { try { return { ok: true, value: String(fn()) }; } catch (e) { return { ok: false, error: String(e && e.name) }; } }
localStorage.setItem('own', 'kept');
const report = {
  terminal: attempt(() => parent.desktop.terminal.create()),
  parentStorage: attempt(() => parent.localStorage.getItem('lax_token')),
  parentDom: attempt(() => parent.document.title),
  ownStorage: attempt(() => localStorage.getItem('own')),
  connectorToken: typeof window.__LAX_CONNECTOR_TOKEN__,
  href: location.href,
};
parent.postMessage({ type: 'report', report }, '*');
console.error('captured by the frame bridge');
try { top.location.href = 'about:blank#hijacked'; } catch (e) {}
</script></body></html>`;

let root: string;
let agentServer: Server;
let uiServer: Server;
let uiBase: string;

beforeAll(async () => {
	if (!chromiumAvailable) return;
	root = mkdtempSync(join(tmpdir(), "agent-origin-browser-"));
	const workspace = join(root, "workspace");
	mkdirSync(join(workspace, "apps", "evil"), { recursive: true });
	writeFileSync(join(workspace, "apps", "evil", "index.html"), APP_HTML);
	const config = { authToken: OP_TOKEN, workspace } as LAXConfig;
	const ctx = { config, appRegistry: { get: () => undefined } } as unknown as ServerContext;
	agentServer = await startAgentOrigin({ config, publicDir, getCtx: () => ctx });

	const pinIframe = readFileSync(join(publicDir, "app.html"), "utf8").match(/<iframe id="pin-iframe"[^>]*><\/iframe>/)?.[0];
	if (!pinIframe) throw new Error("app.html has no #pin-iframe");
	const shell = `<!doctype html><html><head><title>shell</title></head><body>${pinIframe}
<script>localStorage.setItem('lax_token', ${JSON.stringify(OP_TOKEN)}); var AUTH_TOKEN = ${JSON.stringify(OP_TOKEN)};
window.__escaped = false; window.desktop = { terminal: { create() { window.__escaped = true; return 'pty'; } } };
window.__messages = []; addEventListener('message', (e) => window.__messages.push({ origin: e.origin, data: e.data }));</script>
<script src="/js/shared-escape.js"></script><script src="/js/shared-md.js"></script>
<script>laxAgentReady.then(() => { const frame = document.getElementById('pin-iframe'); const target = agentFrameTarget('/apps/evil/');
frame.sandbox.toggle('allow-same-origin', target.ownOrigin); frame.src = target.src; });</script></body></html>`;

	uiServer = createServer((req, res) => {
		const url = new URL(req.url || "/", "http://127.0.0.1");
		if (url.pathname === "/") { res.writeHead(200, { "Content-Type": "text/html" }); res.end(shell); return; }
		if (url.pathname.startsWith("/js/")) {
			res.writeHead(200, { "Content-Type": "application/javascript" });
			res.end(readFileSync(join(publicDir, url.pathname)));
			return;
		}
		if (!routeUiAgentPaths(req.method || "GET", url, req, res, config, "operator")) { res.writeHead(404); res.end(); }
	});
	await new Promise<void>((resolve) => uiServer.listen(0, "127.0.0.1", resolve));
	const port = (uiServer.address() as AddressInfo).port;
	config.port = port; // the frame bridge addresses the UI by this port
	uiBase = `http://127.0.0.1:${port}`;
}, 30_000);

afterAll(async () => {
	if (!chromiumAvailable) return;
	for (const server of [agentServer, uiServer]) {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!chromiumAvailable)("a pinned agent app in a real browser", () => {
	it("runs on the agent origin and cannot reach the shell's bridge, token, DOM or location", async () => {
		const { chromium } = await import("playwright");
		const browser = await chromium.launch({ headless: true });
		try {
			const page = await browser.newPage();
			await page.goto(`${uiBase}/`);
			await page.waitForFunction(() => (window as unknown as { __messages: Array<{ data: { type?: string } }> }).__messages
				.some((m) => m.data?.type === "report") && (window as unknown as { __messages: Array<{ data: { type?: string } }> }).__messages
				.some((m) => m.data?.type === "lax-ide-runtime-error"), undefined, { timeout: 15_000 });
			await page.waitForTimeout(300); // give the top-navigation attempt its chance
			const state = await page.evaluate(() => {
				const w = window as unknown as { __escaped: boolean; __messages: Array<{ origin: string; data: Record<string, unknown> }> };
				return { escaped: w.__escaped, messages: w.__messages, shellUrl: location.href, frameSrc: (document.getElementById("pin-iframe") as HTMLIFrameElement).src };
			});
			const report = state.messages.find((m) => m.data.type === "report")!;
			const piped = state.messages.find((m) => m.data.type === "lax-ide-runtime-error" && m.data.kind === "console")!;
			const r = report.data.report as Record<string, { ok: boolean; value?: string; error?: string } | string>;

			expect(report.origin).toBe(agentOrigin());
			expect(new URL(state.frameSrc).origin).toBe(agentOrigin());
			expect(state.escaped).toBe(false);
			expect(r.terminal).toMatchObject({ ok: false });
			expect(r.parentStorage).toMatchObject({ ok: false });
			expect(r.parentDom).toMatchObject({ ok: false });
			expect(r.ownStorage).toEqual({ ok: true, value: "kept" });
			expect(r.connectorToken).toBe("string");
			expect(String(r.href)).not.toContain(OP_TOKEN);
			expect(state.shellUrl).toBe(`${uiBase}/`);
			// The frame bridge reached the shell, addressed to the shell's origin.
			expect(piped.origin).toBe(agentOrigin());
			expect(piped.data.message).toBe("captured by the frame bridge");
		} finally {
			await browser.close();
		}
	}, 60_000);
});
