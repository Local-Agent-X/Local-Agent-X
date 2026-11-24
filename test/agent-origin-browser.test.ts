// The agent-origin split, observed in a real browser. A stand-in shell page on
// the UI origin holds what the real shell holds (an operator token in
// localStorage, a window.desktop with a terminal) and frames a pinned app
// exactly as app.js does: the real #pin-iframe markup from app.html, the real
// shared-md.js agentFrameTargetFor, and the real servers (routeUiAgentPaths on
// the UI side, startAgentOrigin on the other). The app then tries everything
// the agent-origin split exists to stop: reaching the shell, and reaching
// another app.
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
import { ensureAppOrigin } from "../src/server/app-origins.js";
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
const VICTIM_SECRET = "victim-secret-" + "fedcba9876543210";

// Another app: its page and its storage hold something of its own.
const VICTIM_HTML = `<!doctype html><html><head><title>victim app</title></head><body><p id="secret">${VICTIM_SECRET}</p><script>
localStorage.setItem('victim', ${JSON.stringify(VICTIM_SECRET)});
</script></body></html>`;

// The agent's app: it reports what it could reach, then tries to steer the
// shell. It is told the other app's origin, the most an attacker could know.
const APP_HTML = `<!doctype html><html><head><title>evil app</title></head><body><p>app</p><script>
function attempt(fn) { try { return { ok: true, value: String(fn()) }; } catch (e) { return { ok: false, error: String(e && e.name) }; } }
async function attemptAsync(fn) { try { return { ok: true, value: String(await fn()) }; } catch (e) { return { ok: false, error: String(e && e.name) }; } }
function framed(src) {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.onload = frame.onerror = () => resolve(attempt(() => frame.contentDocument.getElementById('secret').textContent));
    setTimeout(() => resolve(attempt(() => frame.contentDocument.getElementById('secret').textContent)), 1500);
    frame.src = src;
    document.body.appendChild(frame);
  });
}
localStorage.setItem('own', 'kept');
(async () => {
  const victim = new URLSearchParams(location.search).get('victim');
  const report = {
    terminal: attempt(() => parent.desktop.terminal.create()),
    parentStorage: attempt(() => parent.localStorage.getItem('lax_token')),
    parentDom: attempt(() => parent.document.title),
    ownStorage: attempt(() => localStorage.getItem('own')),
    connectorToken: typeof window.__LAX_CONNECTOR_TOKEN__,
    href: location.href,
    // Another app, by every route a page has to it.
    victimStorage: attempt(() => localStorage.getItem('victim')),
    victimByPath: await attemptAsync(() => fetch('/apps/victim/').then((r) => r.text())),
    victimByOrigin: await attemptAsync(() => fetch(victim + '/apps/victim/').then((r) => r.text())),
    victimNoCors: await attemptAsync(() => fetch(victim + '/apps/victim/', { mode: 'no-cors' }).then((r) => r.text())),
    victimFramedByPath: await framed('/apps/victim/'),
    victimFramedByOrigin: await framed(victim + '/apps/victim/'),
  };
  parent.postMessage({ type: 'report', report }, '*');
  console.error('captured by the frame bridge');
  try { top.location.href = 'about:blank#hijacked'; } catch (e) {}
})();
</script></body></html>`;

let root: string;
let agentServer: Server;
let uiServer: Server;
let uiBase: string;

beforeAll(async () => {
	if (!chromiumAvailable) return;
	root = mkdtempSync(join(tmpdir(), "agent-origin-browser-"));
	const workspace = join(root, "workspace");
	for (const [id, html] of [["evil", APP_HTML], ["victim", VICTIM_HTML]]) {
		mkdirSync(join(workspace, "apps", id), { recursive: true });
		writeFileSync(join(workspace, "apps", id, "index.html"), html);
	}
	const config = { authToken: OP_TOKEN, workspace } as LAXConfig;
	const ctx = { config, appRegistry: { get: () => undefined } } as unknown as ServerContext;
	agentServer = await startAgentOrigin({ config, publicDir, getCtx: () => ctx, appPortsFile: join(root, "app-origin-ports.json") });

	const pinIframe = readFileSync(join(publicDir, "app.html"), "utf8").match(/<iframe id="pin-iframe"[^>]*><\/iframe>/)?.[0];
	if (!pinIframe) throw new Error("app.html has no #pin-iframe");
	const shell = `<!doctype html><html><head><title>shell</title></head><body>${pinIframe}
<script>localStorage.setItem('lax_token', ${JSON.stringify(OP_TOKEN)}); var AUTH_TOKEN = ${JSON.stringify(OP_TOKEN)};
window.__escaped = false; window.desktop = { terminal: { create() { window.__escaped = true; return 'pty'; } } };
window.__messages = []; addEventListener('message', (e) => window.__messages.push({ origin: e.origin, data: e.data }));</script>
<script src="/js/shared-escape.js"></script><script src="/js/shared-md.js"></script>
<script>laxAppOrigin('victim').then((victim) => agentFrameTargetFor('/apps/evil/?victim=' + encodeURIComponent(victim))).then((target) => {
const frame = document.getElementById('pin-iframe'); frame.sandbox.toggle('allow-same-origin', target.ownOrigin); frame.src = target.src; });</script></body></html>`;

	uiServer = createServer(async (req, res) => {
		const url = new URL(req.url || "/", "http://127.0.0.1");
		if (url.pathname === "/") { res.writeHead(200, { "Content-Type": "text/html" }); res.end(shell); return; }
		if (url.pathname.startsWith("/js/")) {
			res.writeHead(200, { "Content-Type": "application/javascript" });
			res.end(readFileSync(join(publicDir, url.pathname)));
			return;
		}
		if (!await routeUiAgentPaths(req.method || "GET", url, req, res, config, "operator")) { res.writeHead(404); res.end(); }
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

type Attempt = { ok: boolean; value?: string; error?: string };

describe.skipIf(!chromiumAvailable)("a pinned agent app in a real browser", () => {
	it("runs on its own origin and cannot reach the shell, or another app's page, frame or storage", async () => {
		const { chromium } = await import("playwright");
		const browser = await chromium.launch({ headless: true });
		try {
			const evilOrigin = await ensureAppOrigin("evil");
			const victimOrigin = await ensureAppOrigin("victim");
			expect(evilOrigin).not.toBe(victimOrigin);
			const context = await browser.newContext();
			// The other app has run in this browser profile: its storage holds its secret.
			const victimPage = await context.newPage();
			await victimPage.goto(`${uiBase}/apps/victim/`);
			expect(new URL(victimPage.url()).origin).toBe(victimOrigin);
			expect(await victimPage.evaluate(() => localStorage.getItem("victim"))).toBe(VICTIM_SECRET);

			const page = await context.newPage();
			await page.goto(`${uiBase}/`);
			await page.waitForFunction(() => (window as unknown as { __messages: Array<{ data: { type?: string } }> }).__messages
				.some((m) => m.data?.type === "report") && (window as unknown as { __messages: Array<{ data: { type?: string } }> }).__messages
				.some((m) => m.data?.type === "lax-ide-runtime-error"), undefined, { timeout: 20_000 });
			await page.waitForTimeout(300); // give the top-navigation attempt its chance
			const state = await page.evaluate(() => {
				const w = window as unknown as { __escaped: boolean; __messages: Array<{ origin: string; data: Record<string, unknown> }> };
				return { escaped: w.__escaped, messages: w.__messages, shellUrl: location.href, frameSrc: (document.getElementById("pin-iframe") as HTMLIFrameElement).src };
			});
			const report = state.messages.find((m) => m.data.type === "report")!;
			const piped = state.messages.find((m) => m.data.type === "lax-ide-runtime-error" && m.data.kind === "console")!;
			const r = report.data.report as Record<string, Attempt | string>;

			expect(report.origin).toBe(evilOrigin);
			expect(report.origin).not.toBe(agentOrigin());
			expect(new URL(state.frameSrc).origin).toBe(evilOrigin);
			expect(state.escaped).toBe(false);
			expect(r.terminal).toMatchObject({ ok: false });
			expect(r.parentStorage).toMatchObject({ ok: false });
			expect(r.parentDom).toMatchObject({ ok: false });
			expect(r.ownStorage).toEqual({ ok: true, value: "kept" });
			expect(r.connectorToken).toBe("string");
			expect(String(r.href)).not.toContain(OP_TOKEN);
			expect(state.shellUrl).toBe(`${uiBase}/`);
			// The frame bridge reached the shell, addressed to the shell's origin.
			expect(piped.origin).toBe(evilOrigin);
			expect(piped.data.message).toBe("captured by the frame bridge");

			// Another app: nothing of it is readable, by any route.
			expect(r.victimStorage).toEqual({ ok: true, value: "null" });
			for (const route of ["victimByPath", "victimByOrigin", "victimNoCors", "victimFramedByPath", "victimFramedByOrigin"]) {
				const tried = r[route] as Attempt;
				expect(tried.ok && tried.value !== "", route).toBe(false);
			}
			expect(JSON.stringify(report.data)).not.toContain(VICTIM_SECRET);
		} finally {
			await browser.close();
		}
	}, 90_000);
});
