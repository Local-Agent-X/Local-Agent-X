// @vitest-environment happy-dom
//
// Browser profile manager (public/js/browser-profiles.js) — the overlay behind
// the Browser tab's "Profiles" button. It is plain DOM (not a native view) and
// does CRUD over the /api/browser/profiles routes plus the desktop-only
// "Log in once" IPC. The real module source is loaded verbatim and driven
// against a fake authed-fetch + a fake desktop bridge, mirroring the
// browser-tab.test.ts / browser-profile-editors.test.ts pattern.
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const g = globalThis as Record<string, unknown>;

interface FetchCall { path: string; opts: { method?: string; body?: string } }

const PROFILES = [
	{ id: "default", name: "Default", lastUsedAt: Date.now(), createdAt: 0 },
	{ id: "p1", name: "Work", lastUsedAt: Date.now() - 3600_000, createdAt: 0 },
];

let calls: FetchCall[];
let openProfileView: Mock;

function loadModule() {
	const src = readFileSync(join(here, "../public/js/browser-profiles.js"), "utf8");
	new Function(src)();
}

function laxProfiles() {
	return (window as unknown as { laxBrowserProfiles: {
		toggle(): void; open(): void; close(): void; refresh(): Promise<void>;
		render(p: unknown[]): void; isOpen(): boolean;
	} }).laxBrowserProfiles;
}

// Let the microtask chain in refresh()/create()/… settle.
function flush() { return new Promise((r) => setTimeout(r, 0)); }

beforeEach(() => {
	calls = [];
	document.body.innerHTML = `<div id="browser-profiles-panel" style="display:none"></div>`;

	// Canonical authed fetch (shared-api.js) — the module calls it as a free
	// global. Record every call; answer GET with the profile list, mutations ok.
	g.apiFetch = vi.fn((path: string, opts: { method?: string; body?: string } = {}) => {
		calls.push({ path, opts });
		if (path === "/api/browser/profiles" && (!opts.method || opts.method === "GET")) {
			return Promise.resolve({ ok: true, json: () => Promise.resolve(PROFILES) } as Response);
		}
		return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) } as Response);
	});

	openProfileView = vi.fn().mockResolvedValue({ url: "https://x.test", title: "" });
	(window as unknown as { desktop: unknown }).desktop = { isDesktop: true, browser: { openProfileView } };

	window.confirm = vi.fn(() => true) as unknown as typeof window.confirm;
	window.prompt = vi.fn(() => "typed") as unknown as typeof window.prompt;

	loadModule();
});

afterEach(() => {
	for (const k of ["apiFetch", "API", "AUTH_TOKEN"]) delete g[k];
	delete (window as unknown as { laxBrowserProfiles?: unknown }).laxBrowserProfiles;
});

function rows() {
	return Array.from(document.querySelectorAll("#browser-profiles-list .browser-profile-row"));
}
function rowButton(row: Element, label: string): HTMLButtonElement | undefined {
	return Array.from(row.querySelectorAll("button")).find((b) => b.textContent === label) as HTMLButtonElement | undefined;
}
function mutationCalls() {
	return calls.filter((c) => c.opts.method && c.opts.method !== "GET");
}

describe("browser profile manager (browser-profiles.js)", () => {
	it("open() lists profiles with name + last-used", async () => {
		laxProfiles().open();
		await flush();
		expect(document.getElementById("browser-profiles-panel")!.style.display).toBe("block");
		const r = rows();
		expect(r.length).toBe(2);
		expect(r[0].querySelector(".browser-profile-name")!.textContent).toBe("Default");
		expect(r[1].querySelector(".browser-profile-name")!.textContent).toBe("Work");
		// The default row is labelled + carries a relative last-used stamp.
		expect(r[0].querySelector(".browser-profile-sub")!.textContent).toContain("Default");
		expect(r[1].querySelector(".browser-profile-sub")!.textContent).toContain("ago");
	});

	it("create posts the typed name", async () => {
		laxProfiles().open();
		await flush();
		(document.getElementById("browser-profiles-name-input") as HTMLInputElement).value = "  Personal  ";
		Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Create")!.click();
		await flush();
		const post = mutationCalls().find((c) => c.path === "/api/browser/profiles");
		expect(post).toBeTruthy();
		expect(post!.opts.method).toBe("POST");
		expect(JSON.parse(post!.opts.body!)).toEqual({ name: "Personal" });
	});

	it("rename PUTs the new name to the profile id", async () => {
		(window.prompt as unknown as Mock).mockReturnValue("Renamed");
		laxProfiles().open();
		await flush();
		rowButton(rows()[1], "Rename")!.click();
		await flush();
		const put = mutationCalls().find((c) => c.opts.method === "PUT");
		expect(put!.path).toBe("/api/browser/profiles/p1");
		expect(JSON.parse(put!.opts.body!)).toEqual({ name: "Renamed" });
	});

	it("delete is disabled for the default profile and enabled for others", async () => {
		laxProfiles().open();
		await flush();
		expect(rowButton(rows()[0], "Delete")!.disabled).toBe(true);
		const other = rowButton(rows()[1], "Delete")!;
		expect(other.disabled).toBe(false);
		other.click();
		await flush();
		const del = mutationCalls().find((c) => c.opts.method === "DELETE");
		expect(del!.path).toBe("/api/browser/profiles/p1");
		expect(window.confirm).toHaveBeenCalledTimes(2); // double-confirm
	});

	it("delete aborts when either confirm is declined", async () => {
		(window.confirm as unknown as Mock).mockReturnValueOnce(true).mockReturnValueOnce(false);
		laxProfiles().open();
		await flush();
		rowButton(rows()[1], "Delete")!.click();
		await flush();
		expect(mutationCalls().some((c) => c.opts.method === "DELETE")).toBe(false);
	});

	it("clear logins double-confirms and DELETEs :id/data — enabled for default too", async () => {
		laxProfiles().open();
		await flush();
		const clearDefault = rowButton(rows()[0], "Clear logins")!;
		expect(clearDefault.disabled).toBe(false);
		clearDefault.click();
		await flush();
		const del = mutationCalls().find((c) => c.opts.method === "DELETE");
		expect(del!.path).toBe("/api/browser/profiles/default/data");
		expect(window.confirm).toHaveBeenCalledTimes(2);
	});

	it("clear logins aborts when a confirm is declined", async () => {
		(window.confirm as unknown as Mock).mockReturnValue(false);
		laxProfiles().open();
		await flush();
		rowButton(rows()[1], "Clear logins")!.click();
		await flush();
		expect(mutationCalls().some((c) => c.path.endsWith("/data"))).toBe(false);
	});

	it("log in once opens a foreground view on the profile via the desktop bridge", async () => {
		(window.prompt as unknown as Mock).mockReturnValue("example.com");
		laxProfiles().open();
		await flush();
		rowButton(rows()[1], "Log in once")!.click();
		await flush();
		expect(openProfileView).toHaveBeenCalledWith("p1", "https://example.com");
		// Opening the login view closes the manager so it isn't hidden behind it.
		expect(laxProfiles().isOpen()).toBe(false);
	});

	it("toggle opens then closes the panel", async () => {
		laxProfiles().toggle();
		await flush();
		expect(laxProfiles().isOpen()).toBe(true);
		laxProfiles().toggle();
		expect(laxProfiles().isOpen()).toBe(false);
		expect(document.getElementById("browser-profiles-panel")!.style.display).toBe("none");
	});
});
