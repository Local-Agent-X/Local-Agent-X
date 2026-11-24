// @vitest-environment happy-dom
//
// The shell's half of the agent-origin split (src/server/agent-origin.ts):
// agent-built pages framed inside the shell must land on the agent origin, keep
// an origin only when it is not the shell's, never carry the operator token,
// and talk to the shell only by postMessage checked by origin on both sides.
// Each script is evaluated verbatim from public/ with its globals passed in.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(join(here, "../public", file), "utf8");

const UI = "http://127.0.0.1:7007";
const AGENT = "http://127.0.0.1:51234";
// Each app has an origin of its own; the server names it on request.
const APP_ORIGINS: Record<string, string> = { demo: "http://127.0.0.1:51300", board: "http://127.0.0.1:51301" };
const DEMO = APP_ORIGINS.demo;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const UI_ORIGINS = [UI, "http://localhost:7007"];
const OP_TOKEN = "operator-token-value";

type FrameTarget = { src: string; ownOrigin: boolean } | null;
type AgentState = { origin: string; filesLinkToken: string };

function loadSharedMd(answer: AgentState | null) {
	const lookup = answer ? Promise.resolve({ ok: true, json: () => answer }) : new Promise(() => {});
	const fetchStub = (url: string) => {
		const app = new URL(url, UI).searchParams.get("app");
		if (app === null || !answer) return lookup;
		return Promise.resolve({ ok: true, json: () => ({ ...answer, appOrigin: APP_ORIGINS[app] ?? null }) });
	};
	return new Function(
		"AUTH_TOKEN", "fetch", "location",
		`${read("js/shared-escape.js")}\n${read("js/shared-md.js")}\nreturn { agentFrameTarget, agentFrameTargetFor, isLaxAppOrigin, agentFilesHref, linkPath, ready: laxAgentReady, agent: () => laxAgent };`,
	)(OP_TOKEN, fetchStub, { origin: UI, href: `${UI}/` }) as {
		agentFrameTarget: (href: string) => FrameTarget;
		agentFrameTargetFor: (href: string) => Promise<FrameTarget>;
		isLaxAppOrigin: (origin: string) => boolean;
		agentFilesHref: (href: string) => string;
		linkPath: (href: string) => string;
		ready: Promise<void>;
		agent: () => AgentState;
	};
}

// The element exactly as app.html ships it, parsed into an inert template so
// happy-dom never loads it (or the rest of app.html's assets).
function appHtmlElement(id: string): HTMLIFrameElement {
	const tag = read("app.html").match(new RegExp(`<iframe id="${id}"[^>]*>`))?.[0];
	if (!tag) throw new Error(`app.html has no #${id}`);
	const template = document.createElement("template");
	template.innerHTML = `${tag}</iframe>`;
	return template.content.firstElementChild as HTMLIFrameElement;
}

describe("app.html frames agent content without the shell's origin", () => {
	it("#pin-iframe is sandboxed, without allow-same-origin or top navigation by default", () => {
		const flags = appHtmlElement("pin-iframe").getAttribute("sandbox")?.split(/\s+/) ?? null;
		expect(flags).not.toBeNull();
		expect(flags).toContain("allow-scripts");
		expect(flags).not.toContain("allow-same-origin");
		expect(flags!.some((f) => f.startsWith("allow-top-navigation"))).toBe(false);
	});

	it("#ide-preview-frame is sandboxed, without allow-same-origin or top navigation by default", () => {
		const flags = appHtmlElement("ide-preview-frame").getAttribute("sandbox")?.split(/\s+/) ?? null;
		expect(flags).not.toBeNull();
		expect(flags).toContain("allow-scripts");
		expect(flags).not.toContain("allow-same-origin");
		expect(flags!.some((f) => f.startsWith("allow-top-navigation"))).toBe(false);
	});
});

// apps-ide-tools-files.js ideLoadPreview, the one loader for the IDE preview
// (entering the IDE and every refresh after an edit).
describe("the IDE preview loads the app off the shell's origin", () => {
	it("from the app's own origin, which the frame may keep, with no token", async () => {
		const md = loadSharedMd({ origin: AGENT, filesLinkToken: "ft-cap" });
		const frame = appHtmlElement("ide-preview-frame");
		const win: Record<string, unknown> = {};
		const onLoad = vi.fn();
		const { ideLoadPreview } = new Function(
			"window", "_ideAppId", "agentFrameTargetFor", "_ideOnPreviewLoad",
			`${read("js/apps-ide-tools-files.js")}\nreturn { ideLoadPreview };`,
		)(win, "demo", md.agentFrameTargetFor, onLoad) as { ideLoadPreview: (f: HTMLIFrameElement) => void };
		ideLoadPreview(frame);
		await settle();
		const src = new URL(frame.src);
		expect(src.origin).toBe(DEMO);
		expect(src.pathname).toBe("/apps/demo/index.html");
		expect(frame.src).not.toContain("token=");
		expect(frame.src).not.toContain(OP_TOKEN);
		expect(frame.sandbox.contains("allow-same-origin")).toBe(true);
		// Pop Out opens the app through the UI's redirect, never with a token.
		expect(win._ideAppUrl).toBe("/apps/demo/index.html");
	});
});

describe("every /files link the UI opens carries the files-link capability, never the operator token", () => {
	it("agentFilesHref adds it once, to a path on this origin only", async () => {
		const md = loadSharedMd({ origin: AGENT, filesLinkToken: "ft-cap" });
		await md.ready;
		expect(md.agentFilesHref("/files/a.html")).toBe("/files/a.html?ft=ft-cap");
		expect(md.agentFilesHref("/files/a.html?x=1")).toBe("/files/a.html?x=1&ft=ft-cap");
		expect(md.agentFilesHref("/files/a.html?ft=ft-cap")).toBe("/files/a.html?ft=ft-cap");
		expect(md.agentFilesHref("https://evil.example/files/a.html")).toBe("https://evil.example/files/a.html");
		expect(md.agentFilesHref("/apps/demo/")).toBe("/apps/demo/");
	});

	it("agentFilesHref adds it to this UI's own full /files address too (a bare one returned 401)", async () => {
		const md = loadSharedMd({ origin: AGENT, filesLinkToken: "ft-cap" });
		await md.ready;
		expect(md.agentFilesHref(`${UI}/files/a.html`)).toBe(`${UI}/files/a.html?ft=ft-cap`);
		expect(md.agentFilesHref(`${UI}/files/Invoice%20%2342.docx?x=1`)).toBe(`${UI}/files/Invoice%20%2342.docx?x=1&ft=ft-cap`);
		expect(md.agentFilesHref(`${AGENT}/files/a.html`)).toBe(`${AGENT}/files/a.html`);
	});

	it("refreshLaxAgent picks up a new agent origin, and the chat socket asks for it on every (re)connect", async () => {
		const answers = [
			{ origin: AGENT, filesLinkToken: "ft-1" },
			{ origin: "http://127.0.0.1:51999", filesLinkToken: "ft-2" },
		];
		const lib = new Function(
			"AUTH_TOKEN", "fetch", "location",
			`${read("js/shared-escape.js")}\n${read("js/shared-md.js")}\nreturn { refreshLaxAgent, ready: laxAgentReady, agent: () => laxAgent };`,
		)(OP_TOKEN, () => Promise.resolve({ ok: true, json: () => answers.shift() }), { origin: UI, href: `${UI}/` }) as {
			refreshLaxAgent: () => Promise<void>; ready: Promise<void>; agent: () => AgentState;
		};
		await lib.ready;
		expect(lib.agent().origin).toBe(AGENT);
		await lib.refreshLaxAgent();
		expect(lib.agent()).toEqual({ origin: "http://127.0.0.1:51999", filesLinkToken: "ft-2" });

		// The one place the UI learns the server came back is the chat socket's
		// open handler; it must refresh there, ahead of anything that frames content.
		const onopen = read("js/chat-ws.js").match(/ws\.onopen = \(\) => \{([\s\S]*?)\n  \};/)?.[1] ?? "";
		expect(onopen).toContain("refreshLaxAgent()");
	});

	it("a chat link rendered before the agent origin was known gets the capability when clicked", async () => {
		let answer: (value: unknown) => void = () => {};
		const lookup = new Promise((resolve) => { answer = resolve; });
		const md = new Function(
			"AUTH_TOKEN", "fetch", "location",
			`${read("js/shared-escape.js")}\n${read("js/shared-md.js")}\nreturn { md, linkPath, agentFilesHref, ready: laxAgentReady };`,
		)(OP_TOKEN, () => lookup, { origin: UI, href: `${UI}/` }) as {
			md: (s: string) => string; linkPath: (h: string) => string; agentFilesHref: (h: string) => string; ready: Promise<void>;
		};
		const host = document.createElement("div");
		host.innerHTML = md.md("[out](workspace/out.html)");
		const link = host.querySelector("a")!;
		expect(link.getAttribute("href")).toBe("/files/out.html");
		answer({ ok: true, json: () => ({ origin: AGENT, filesLinkToken: "ft-cap" }) });
		await md.ready;

		const clicks: Array<(e: unknown) => void> = [];
		const open = vi.fn();
		new Function("document", "window", "linkPath", "agentFilesHref", read("js/shared-dom.js"))(
			{ addEventListener: (type: string, fn: (e: unknown) => void) => { if (type === "click") clicks.push(fn); }, getElementById: () => null },
			{ open }, md.linkPath, md.agentFilesHref,
		);
		clicks[0]({ target: link, preventDefault() {} });
		expect(open).toHaveBeenCalledWith("/files/out.html?ft=ft-cap", "_blank", "noopener,noreferrer");
	});

	it("result links to agent apps and files carry no operator token", async () => {
		const md = loadSharedMd({ origin: AGENT, filesLinkToken: "ft-cap" });
		await md.ready;
		const { resultLinkHtml } = new Function(
			"AUTH_TOKEN", "agentFilesHref",
			`${read("js/shared-escape.js")}\n${read("js/chat-agent-feeds-render.js")}\nreturn { resultLinkHtml };`,
		)(OP_TOKEN, md.agentFilesHref) as { resultLinkHtml: (url: string) => string };
		const hrefOf = (url: string) => {
			const host = document.createElement("div");
			host.innerHTML = resultLinkHtml(url);
			return host.querySelector("a")!.getAttribute("href")!;
		};
		expect(hrefOf("http://127.0.0.1:7007/apps/demo/")).toBe("http://127.0.0.1:7007/apps/demo/");
		expect(hrefOf("/dashboards/board")).toBe("/dashboards/board");
		expect(hrefOf("/files/out.html")).toBe("/files/out.html?ft=ft-cap");
		expect(hrefOf("/api/cron/j1/reports/latest")).toContain(`token=${OP_TOKEN}`);
		// The agent picks resultUrl, so a listener it started on another
		// loopback port must never receive the operator token.
		expect(hrefOf("http://127.0.0.1:9999/")).toBe("http://127.0.0.1:9999/");
		expect(hrefOf("http://localhost:5173/x")).toBe("http://localhost:5173/x");
		expect(hrefOf(`${location.origin}/api/status`)).toContain(`token=${OP_TOKEN}`);
	});

	it("an app's result link also offers Open in Code for that app, and no other link does", () => {
		const { resultLinkHtml } = new Function(
			"AUTH_TOKEN", "agentFilesHref",
			`${read("js/shared-escape.js")}
${read("js/chat-agent-feeds-render.js")}
return { resultLinkHtml };`,
		)(OP_TOKEN, (u: string) => u) as { resultLinkHtml: (url: string) => string };
		const openCodeOf = (url: string) => {
			const host = document.createElement("div");
			host.innerHTML = resultLinkHtml(url);
			return host.querySelector("[data-open-code]")?.getAttribute("data-open-code") ?? null;
		};
		expect(openCodeOf("http://127.0.0.1:7007/apps/demo/")).toBe("demo");
		expect(openCodeOf("http://127.0.0.1:62044/apps/my-app/index.html")).toBe("my-app");
		expect(openCodeOf("/apps/notes")).toBe("notes");
		expect(openCodeOf("/dashboards/board")).toBeNull();
		expect(openCodeOf("/files/out.html")).toBeNull();
		expect(openCodeOf("http://evil.test/x/apps/demo/")).toBeNull();
		expect(openCodeOf('/apps/a"onclick="x/')).toBeNull();
	});

	// The artifacts panel opens workspace files with the chat link's opener
	// (shared-dom.js openFileLink): a viewable file renders with the
	// capability, and on the desktop an Office file goes to desktop.openFile,
	// never window.open, which no longer opens a document natively.
	async function artifactsPanel(desktop: { isDesktop: boolean; openFile: ReturnType<typeof vi.fn> } | undefined) {
		const md = loadSharedMd({ origin: AGENT, filesLinkToken: "ft-cap" });
		await md.ready;
		const open = vi.fn();
		const win = { open, addEventListener: () => {}, desktop };
		const doc = { addEventListener: () => {}, getElementById: () => null };
		const panel = new Function(
			"AUTH_TOKEN", "agentFilesHref", "linkPath", "window", "document",
			`${read("js/shared-escape.js")}\n${read("js/shared-dom.js")}\n${read("js/chat-artifacts.js")}\nreturn { openArtifact, setCache: (c) => { artifactsCache = c; } };`,
		)(OP_TOKEN, md.agentFilesHref, md.linkPath, win, doc) as { openArtifact: (f: string, i: number) => void; setCache: (c: unknown) => void };
		return { ...panel, open };
	}

	it("the artifacts panel opens a viewable workspace file with the capability", async () => {
		const { openArtifact, setCache, open } = await artifactsPanel(undefined);
		setCache([{ type: "file", ref: "/files/out.html" }]);
		openArtifact("all", 0);
		expect(open).toHaveBeenCalledWith("/files/out.html?ft=ft-cap", "_blank", "noopener,noreferrer");
	});

	it("the artifacts panel hands an Office file to desktop.openFile, not window.open", async () => {
		const openFile = vi.fn();
		const { openArtifact, setCache, open } = await artifactsPanel({ isDesktop: true, openFile });
		setCache([{ type: "file", ref: "/files/report.docx" }]);
		openArtifact("all", 0);
		expect(openFile).toHaveBeenCalledWith("workspace/report.docx");
		expect(open).not.toHaveBeenCalled();
	});
});

describe("agentFrameTarget", () => {
	it("loads /apps and /dashboards from that app's own origin, which the frame may keep", async () => {
		const md = loadSharedMd({ origin: AGENT, filesLinkToken: "ft-cap" });
		for (const [href, origin] of [["/apps/demo/", DEMO], ["/dashboards/board", APP_ORIGINS.board], [`${UI}/apps/demo/?x=1`, DEMO]]) {
			const target = (await md.agentFrameTargetFor(href))!;
			expect(new URL(target.src).origin, href).toBe(origin);
			expect(target.ownOrigin, href).toBe(true);
			expect(new URL(target.src).searchParams.get("_t"), href).toMatch(/^\d+$/);
		}
		expect(md.isLaxAppOrigin(DEMO)).toBe(true);
		expect(md.isLaxAppOrigin(AGENT)).toBe(false);
	});

	it("an app the server does not know goes through the UI's redirect with no origin", async () => {
		const md = loadSharedMd({ origin: AGENT, filesLinkToken: "ft-cap" });
		const target = (await md.agentFrameTargetFor("/apps/ghost/"))!;
		expect(new URL(target.src).origin).toBe(UI);
		expect(target.ownOrigin).toBe(false);
	});

	it("gives a page this UI's origin would render no origin at all", async () => {
		const md = loadSharedMd({ origin: AGENT, filesLinkToken: "ft-cap" });
		await md.ready;
		const files = md.agentFrameTarget("/files/report.html")!;
		expect(new URL(files.src).origin).toBe(UI);
		expect(new URL(files.src).searchParams.get("ft")).toBe("ft-cap");
		expect(files.ownOrigin).toBe(false);
		expect(md.agentFrameTarget("/tasks.html")!.ownOrigin).toBe(false);
		expect(md.agentFrameTarget("https://example.com/")!.ownOrigin).toBe(true);
	});

	it("before the agent origin is known, /apps goes through the UI's redirect with no origin", () => {
		const md = loadSharedMd(null);
		const target = md.agentFrameTarget("/apps/demo/")!;
		expect(new URL(target.src).origin).toBe(UI);
		expect(target.ownOrigin).toBe(false);
	});

	it("refuses anything but http(s), so a javascript: pin cannot run in the frame", async () => {
		const md = loadSharedMd({ origin: AGENT, filesLinkToken: "ft-cap" });
		await md.ready;
		expect(md.agentFrameTarget("javascript:parent.desktop.terminal.create()")).toBeNull();
		expect(md.agentFrameTarget("data:text/html,<script>1</script>")).toBeNull();
	});

	it("never puts the operator token in a frame URL", async () => {
		const md = loadSharedMd({ origin: AGENT, filesLinkToken: "ft-cap" });
		await md.ready;
		for (const href of ["/apps/demo/", "/dashboards/board", "/files/a.html", "/tasks.html"]) {
			const src = (await md.agentFrameTargetFor(href))!.src;
			expect(src, href).not.toContain(OP_TOKEN);
			expect(src, href).not.toContain("token=");
		}
	});
});

// app.js's navigate() is the everyday, card-free pin path. It is evaluated with
// its boot dependencies stubbed and the real pin iframe markup from app.html,
// detached so happy-dom never tries to load the URL.
function loadAppJs(pins: Array<{ name: string; url: string }>) {
	const md = loadSharedMd({ origin: AGENT, filesLinkToken: "ft-cap" });
	const frame = appHtmlElement("pin-iframe");
	const page = document.createElement("div");
	const doc = new Proxy(document, {
		get(target, prop) {
			if (prop === "getElementById") {
				return (id: string) => (id === "pin-iframe" ? frame : id === "page-pin" ? page : target.getElementById(id));
			}
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const noop = () => {};
	const api = new Function(
		"document", "AUTH_TOKEN", "fetch", "agentFrameTargetFor",
		"renderSidebar", "checkAuth", "syncChatsFromServer", "migrateLegacyLocalStorageProjects", "syncProjectsFromServer",
		"renderChatList", "apiFetch", "esc", "setTimeout", "setInterval",
		`${read("js/app.js")}\nreturn { navigate, setPins: (p) => { _sidebarPins = p; } };`,
	)(
		doc, OP_TOKEN, () => new Promise(noop), md.agentFrameTargetFor,
		noop, noop, () => Promise.resolve(), () => Promise.resolve(), noop,
		noop, () => Promise.reject(new Error("offline")), (s: string) => s, noop, noop,
	) as { navigate: (route: string) => void; setPins: (p: unknown) => void };
	api.setPins(pins);
	return { api, frame, ready: md.ready };
}

describe("app.js pins load agent content off the shell's origin", () => {
	it("a pinned app loads from its own origin, keeps that origin, and carries no token", async () => {
		const { api, frame } = loadAppJs([{ name: "Demo", url: "/apps/demo/" }]);
		api.navigate("pin:Demo");
		await settle();
		expect(new URL(frame.src).origin).toBe(DEMO);
		expect(frame.src).not.toContain(OP_TOKEN);
		expect(frame.src).not.toContain("token=");
		expect(frame.sandbox.contains("allow-same-origin")).toBe(true);
	});

	it("a pin this UI's origin would render keeps no origin", async () => {
		const { api, frame } = loadAppJs([{ name: "Shell", url: "/tasks.html" }]);
		frame.sandbox.add("allow-same-origin");
		api.navigate("pin:Shell");
		await settle();
		expect(new URL(frame.src).origin).toBe(UI);
		expect(frame.sandbox.contains("allow-same-origin")).toBe(false);
	});

	it("a javascript: pin is never loaded", async () => {
		const { api, frame } = loadAppJs([{ name: "Evil", url: "javascript:parent.desktop.terminal.create()" }]);
		api.navigate("pin:Evil");
		await settle();
		expect(frame.getAttribute("src")).toBeNull();
		expect(frame.sandbox.contains("allow-same-origin")).toBe(false);
	});
});

// The shell half: apps-ide-picker.js + apps-ide-errors.js, against stand-in
// preview frames whose windows the test controls: the App IDE's, and the right
// panel's Preview tab, whose picks go into the main chat's composer.
function loadIdeShell(previewSrc = `${DEMO}/apps/demo/index.html`) {
	const previewWindow = { postMessage: vi.fn() };
	const tabWindow = { postMessage: vi.fn() };
	const input = document.createElement("textarea");
	const composer = document.createElement("textarea");
	const messages = document.createElement("div");
	const frames: Record<string, unknown> = {
		"ide-preview-frame": { contentWindow: previewWindow, src: previewSrc },
		"preview-tab-frame": { contentWindow: tabWindow, src: `${DEMO}/apps/demo/index.html` },
		"ide-chat-input": input,
		"msg-input": composer,
		"ide-chat-messages": messages,
	};
	const handlers: Array<(e: unknown) => void> = [];
	const doc = {
		getElementById: (id: string) => frames[id] ?? null,
		querySelector: () => null,
		createElement: (tag: string) => document.createElement(tag),
	};
	const win = { addEventListener: (type: string, fn: (e: unknown) => void) => { if (type === "message") handlers.push(fn); } };
	const api = new Function(
		"document", "window", "isLaxAppOrigin", "chatWs", "_ideSessionId",
		`${read("js/apps-ide-picker.js")}\n${read("js/apps-ide-errors.js")}\nreturn { ideTogglePicker, togglePicker, ideMessageFromPreview, ideDrainErrorsForAgent };`,
	)(doc, win, (origin: string) => Object.values(APP_ORIGINS).includes(origin), undefined, undefined) as {
		ideTogglePicker: () => void;
		togglePicker: (surface: string, on?: boolean) => void;
		ideMessageFromPreview: (e: unknown) => boolean;
		ideDrainErrorsForAgent: () => string;
	};
	const deliver = (data: unknown, origin: string, source: unknown) => { for (const h of handlers) h({ data, origin, source }); };
	return { api, previewWindow, tabWindow, input, composer, messages, deliver };
}

describe("the shell takes IDE messages only from the preview frame at its app's origin", () => {
	const pick = { type: "lax-ide-pick", selector: "#buy", text: "Buy", dims: "10x10px" };
	const error = { type: "lax-ide-runtime-error", kind: "error", message: "boom", source: "app.js", line: 1, col: 2 };

	it("toggling the picker posts to the previewed app's origin only", () => {
		const { api, previewWindow } = loadIdeShell();
		api.ideTogglePicker();
		expect(previewWindow.postMessage).toHaveBeenCalledWith({ type: "lax-ide-picker", on: true }, DEMO);
		for (const call of previewWindow.postMessage.mock.calls) expect(call[1]).not.toBe("*");
	});

	it("a pick from the preview at its app's origin fills the chat input", () => {
		const { previewWindow, input, deliver } = loadIdeShell();
		deliver(pick, DEMO, previewWindow);
		expect(input.value).toContain("`#buy`");
	});

	it("a pick from the wrong origin or the wrong window is ignored", () => {
		const { previewWindow, input, deliver } = loadIdeShell();
		deliver(pick, UI, previewWindow);
		deliver(pick, "null", previewWindow);
		deliver(pick, AGENT, previewWindow); // the shared agent origin serves no app
		deliver(pick, APP_ORIGINS.board, previewWindow); // another app's origin
		deliver(pick, DEMO, { postMessage: () => {} }); // a pinned app, or a frame nested in the preview
		expect(input.value).toBe("");
	});

	it("the Preview tab's picker posts to its own frame, and its pick fills the main composer", () => {
		const { api, previewWindow, tabWindow, input, composer, deliver } = loadIdeShell();
		api.togglePicker("preview");
		expect(tabWindow.postMessage).toHaveBeenCalledWith({ type: "lax-ide-picker", on: true }, DEMO);
		expect(previewWindow.postMessage).not.toHaveBeenCalled();
		deliver(pick, DEMO, tabWindow);
		expect(composer.value).toContain("`#buy`");
		expect(input.value).toBe("");
		// A pick turns the picker off.
		expect(tabWindow.postMessage).toHaveBeenLastCalledWith({ type: "lax-ide-picker", on: false }, DEMO);
	});

	it("the Preview tab's frame is not the App IDE's for its errors", () => {
		const { api, tabWindow, messages, deliver } = loadIdeShell();
		expect(api.ideMessageFromPreview({ data: error, origin: DEMO, source: tabWindow })).toBe(false);
		deliver(error, DEMO, tabWindow);
		expect(messages.children.length).toBe(0);
	});

	it("a frame not showing an app's own origin is neither ordered nor heard", () => {
		for (const src of ["", `${UI}/apps/demo/index.html`, `${AGENT}/apps/demo/index.html`, "http://127.0.0.1:9999/"]) {
			const { api, previewWindow, input, deliver } = loadIdeShell(src);
			api.ideTogglePicker();
			expect(previewWindow.postMessage, src).not.toHaveBeenCalled();
			deliver(pick, src ? new URL(src).origin : DEMO, previewWindow);
			expect(input.value, src).toBe("");
		}
	});

	it("runtime errors are taken only from the preview at its app's origin", () => {
		const { api, previewWindow, messages, deliver } = loadIdeShell();
		deliver(error, "http://127.0.0.1:9999", previewWindow);
		deliver(error, DEMO, { postMessage: () => {} });
		expect(messages.children.length).toBe(0);
		deliver(error, DEMO, previewWindow);
		expect(messages.children.length).toBe(1);
		expect(api.ideDrainErrorsForAgent()).toContain("boom");
	});
});

// The page half: apps-error-pipe-core.js + apps-ide-frame-bridge.js as the
// server injects them, inside a stand-in framed page.
function loadFrameBridge() {
	const parent = { postMessage: vi.fn() };
	const handlers: Array<(e: unknown) => void> = [];
	const win: Record<string, unknown> = {
		parent,
		addEventListener: (type: string, fn: (e: unknown) => void) => { if (type === "message") handlers.push(fn); },
	};
	const fakeConsole = { error: () => {} };
	new Function(
		"window", "console", "setTimeout",
		`${read("js/apps-error-pipe-core.js")}\n${read("js/apps-ide-frame-bridge.js")}\n__laxInstallIdeFrameBridge(${JSON.stringify(UI_ORIGINS)});`,
	)(win, fakeConsole, () => {});
	const deliver = (data: unknown, origin: string, source: unknown) => { for (const h of handlers) h({ data, origin, source }); };
	return { parent, deliver, fakeConsole };
}

describe("the framed page talks only to the shell's origins", () => {
	it("posts captured errors to the UI origins by name, never to *", () => {
		const { parent, fakeConsole } = loadFrameBridge();
		fakeConsole.error("broken");
		expect(parent.postMessage).toHaveBeenCalledTimes(UI_ORIGINS.length);
		expect(parent.postMessage.mock.calls.map((c) => c[1])).toEqual(UI_ORIGINS);
		expect(parent.postMessage.mock.calls[0][0]).toMatchObject({ type: "lax-ide-runtime-error", kind: "console", message: "broken" });
	});

	it("starts the picker only on an order from its parent at a UI origin", () => {
		const { parent, deliver } = loadFrameBridge();
		const button = document.createElement("button");
		button.id = "buy";
		document.body.appendChild(button);
		try {
			deliver({ type: "lax-ide-picker", on: true }, AGENT, parent); // another agent page
			deliver({ type: "lax-ide-picker", on: true }, UI, { postMessage: () => {} }); // not the parent
			button.click();
			expect(parent.postMessage).not.toHaveBeenCalled();

			deliver({ type: "lax-ide-picker", on: true }, UI, parent);
			button.click();
			expect(parent.postMessage.mock.calls.map((c) => c[1])).toEqual(UI_ORIGINS);
			expect(parent.postMessage.mock.calls[0][0]).toMatchObject({ type: "lax-ide-pick", selector: "#buy" });
		} finally {
			deliver({ type: "lax-ide-picker", on: false }, UI, parent);
			button.remove();
		}
	});

	it("the injected source cannot close its own script tag", () => {
		for (const file of ["js/apps-ide-frame-bridge.js", "js/apps-error-pipe-core.js"]) {
			expect(read(file), file).not.toMatch(/<\/script/i);
		}
	});
});

// 2026-10-24: the agent wrote this app's own address in full,
// [resume](http://127.0.0.1:7007/files/resume-agency/resume.pdf), and the
// document-link rule took any link ending in .pdf for a workspace path, so the
// link became /files/http://127.0.0.1:7007/files/… and opened "File not found".
describe("document links written as full addresses", () => {
	function render(markdown: string): string {
		const lib = new Function(
			"AUTH_TOKEN", "fetch", "location",
			`${read("js/shared-escape.js")}\n${read("js/shared-md.js")}\nreturn { md };`,
		)(OP_TOKEN, () => new Promise(() => {}), { origin: UI, href: `${UI}/` }) as { md: (s: string) => string };
		const host = document.createElement("div");
		host.innerHTML = lib.md(markdown);
		return host.querySelector("a")!.getAttribute("href")!;
	}

	it("this app's own /files/ address is the /files/ link it names", () => {
		expect(render(`[resume](${UI}/files/resume-agency/resume.pdf)`)).toBe("/files/resume-agency/resume.pdf");
	});

	it("a PDF on another site stays a link to that site", () => {
		expect(render("[paper](https://example.com/papers/paper.pdf)")).toBe("https://example.com/papers/paper.pdf");
	});

	it("a workspace-relative document is still a /files/ link", () => {
		expect(render("[report](reports/q3.pdf)")).toBe("/files/reports/q3.pdf");
	});
});
