/**
 * ElectronInAppBackend (chunk A1) — bridge fully mocked. Proves:
 *   - observe round-trip: bridge RawElements → ObservationRegistry refs →
 *     formatted output BYTE-IDENTICAL to ObservationRegistry.format (the
 *     same formatter+registry the CDP backend uses).
 *   - navigate / newTab / screenshot / getInfo / tabs result shapes match
 *     the CDP backend's strings.
 *   - evaluate guard rejects blocked scripts BEFORE any bridge call.
 *   - A2 methods (clickByRef/scroll) route through the resolution chain; the
 *     KB1 credential-focus guard blocks screenshot capture; dialogs/downloads
 *     report their not-supported state honestly.
 *   - hostile-page invariant: every page-script execution flows through
 *     browserExec (isolated-world-only transport); no main-world path exists.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./bridge-client.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./bridge-client.js")>();
	return {
		...actual,
		browserLifecycle: vi.fn(),
		browserNavigate: vi.fn(),
		browserExec: vi.fn(),
		browserInput: vi.fn(),
		browserCapture: vi.fn(),
		browserAbort: vi.fn(),
		browserReadConsole: vi.fn(),
		browserReadNetwork: vi.fn(),
	};
});

import {
	browserCapture,
	browserExec,
	browserInput,
	browserLifecycle,
	browserNavigate,
	browserReadConsole,
	browserReadNetwork,
} from "./bridge-client.js";
import {
	ElectronInAppBackend,
	EvaluateBlockedError,
	InAppDownloadsUnavailableError,
} from "./in-app-backend.js";
import { CREDENTIAL_CAPTURE_BLOCKED } from "./in-app-actions.js";
import { ObservationRegistry, type DurableRef } from "./observation.js";
import type { RawElement } from "./extract.js";

const PAGE_URL = "https://example.com/";
const PAGE_TITLE = "Example Domain";
const VIEW_ID = "view-sess-1-work";
// 1×1 transparent PNG.
const TINY_PNG_B64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

// "Transfer funds" is the element a poisoned MAIN world would hide from the
// agent; it must survive because extraction runs in the isolated world.
const RAW_ELEMENTS: RawElement[] = [
	{
		role: "button",
		name: "Transfer funds",
		tag: "BUTTON",
		type: "",
		xpath: "/form[1]/button[1]",
		signature: "button|Transfer funds|BUTTON|form>div",
		inViewport: true,
		rect: { x: 60, y: 40, width: 100, height: 30 },
	},
	{
		role: "textbox",
		name: "Email",
		tag: "INPUT",
		type: "email",
		xpath: "/form[1]/input[1]",
		signature: "textbox|Email|INPUT|form>div",
		inViewport: true,
		rect: { x: 60, y: 80, width: 200, height: 24 },
	},
];

/** Routes mocked exec calls by distinctive markers in the canonical scripts. */
function routeExec(script: string): unknown {
	if (script.includes("computeSignature")) return RAW_ELEMENTS; // extract.ts extractor
	if (script.includes("location.href")) return `${PAGE_URL}|${PAGE_TITLE}|1234|56`; // fingerprint
	if (script.includes("document.title")) return PAGE_TITLE;
	if (script.includes("MutationObserver")) return true; // stability DOM-quiet wait
	if (script.includes("readyState")) return true; // stability spinner poll
	if (script.includes("xpathOf")) return []; // modal-detector
	if (script.includes("'iframe, frame'")) return []; // iframe-detector
	if (script.includes('"not-clickable"')) return { ok: true }; // A1 click script
	if (script.includes('"not-fillable"')) return { ok: true, actual: "hello", type: "" }; // A1 fill
	if (script.includes('"no-matching-option"')) return { ok: true, selected: ["opt1"] }; // A1 select
	return undefined;
}

describe("ElectronInAppBackend (A1)", () => {
	let backend: ElectronInAppBackend;
	let laxDir: string;
	let prevLaxDir: string | undefined;

	beforeEach(() => {
		laxDir = mkdtempSync(join(tmpdir(), "lax-inapp-test-"));
		prevLaxDir = process.env.LAX_DATA_DIR;
		process.env.LAX_DATA_DIR = laxDir;

		vi.mocked(browserLifecycle).mockImplementation(async (op) => {
			if (op === "ping") return { ping: { ok: true, url: PAGE_URL, title: PAGE_TITLE } };
			if (op === "create") {
				return {
					view: { viewId: VIEW_ID, partition: "persist:lax-profile-work", url: "", title: "", attached: false, agentDriven: true },
				};
			}
			return {};
		});
		vi.mocked(browserNavigate).mockResolvedValue({ url: PAGE_URL, title: PAGE_TITLE });
		vi.mocked(browserExec).mockImplementation(async (_viewId, script) => routeExec(script));
		vi.mocked(browserCapture).mockResolvedValue(TINY_PNG_B64);

		backend = new ElectronInAppBackend("sess-1", "work", VIEW_ID);
	});

	afterEach(() => {
		if (prevLaxDir === undefined) delete process.env.LAX_DATA_DIR;
		else process.env.LAX_DATA_DIR = prevLaxDir;
		rmSync(laxDir, { recursive: true, force: true });
		vi.clearAllMocks();
	});

	// ── Navigation ─────────

	it("navigate creates the view on the profile partition and returns the CDP-shaped string", async () => {
		const out = await backend.navigate(PAGE_URL);
		expect(out).toBe(`Navigated to: ${PAGE_URL}\nStatus: unknown\nTitle: ${PAGE_TITLE}`);
		expect(browserLifecycle).toHaveBeenCalledWith("create", VIEW_ID, {
			partition: "persist:lax-profile-work",
		});
		expect(browserNavigate).toHaveBeenCalledWith(VIEW_ID, PAGE_URL);
		expect(backend.getCurrentUrl()).toBe(PAGE_URL);
		expect(backend.isActive()).toBe(true);
	});

	it("navigate prints the REAL HTTP status when the bridge reply carries one", async () => {
		vi.mocked(browserNavigate).mockResolvedValue({ url: PAGE_URL, title: PAGE_TITLE, status: 404 });
		const out = await backend.navigate(PAGE_URL);
		expect(out).toBe(`Navigated to: ${PAGE_URL}\nStatus: 404\nTitle: ${PAGE_TITLE}`);
	});

	it("new_tab prints the REAL HTTP status when the bridge reply carries one", async () => {
		vi.mocked(browserNavigate).mockResolvedValue({ url: PAGE_URL, title: PAGE_TITLE, status: 200 });
		const out = await backend.newTab(PAGE_URL);
		expect(out).toBe(`Opened new tab (1 tabs total)\nURL: ${PAGE_URL}\nStatus: 200\nTitle: ${PAGE_TITLE}`);
	});

	it("navigate surfaces cross-host redirects like the CDP backend", async () => {
		vi.mocked(browserNavigate).mockResolvedValue({ url: "https://other.example.net/", title: "Other" });
		const out = await backend.navigate("https://example.com/login");
		expect(out).toContain("⚠ REDIRECTED: requested example.com, landed on other.example.net");
	});

	it("newTab as the FIRST action materializes the first view (no current tab to keep)", async () => {
		const out = await backend.newTab(PAGE_URL);
		expect(out).toBe(`Opened new tab (1 tabs total)\nURL: ${PAGE_URL}\nStatus: unknown\nTitle: ${PAGE_TITLE}`);
		expect(browserLifecycle).toHaveBeenCalledWith("create", VIEW_ID, {
			partition: "persist:lax-profile-work",
		});
	});

	it("newTab opens a REAL second view (-t2), makes it active, and reports the tab count", async () => {
		await backend.navigate(PAGE_URL);
		const out = await backend.newTab(PAGE_URL);
		expect(out).toBe(`Opened new tab (2 tabs total)\nURL: ${PAGE_URL}\nStatus: unknown\nTitle: ${PAGE_TITLE}`);
		expect(browserLifecycle).toHaveBeenCalledWith("create", `${VIEW_ID}-t2`, {
			partition: "persist:lax-profile-work",
		});
		expect(browserNavigate).toHaveBeenLastCalledWith(`${VIEW_ID}-t2`, PAGE_URL);
		// Active tab followed: subsequent ops target the NEW view.
		await backend.screenshot();
		expect(browserCapture).toHaveBeenCalledWith(`${VIEW_ID}-t2`);
	});

	// ── Observe round-trip / format parity ─────────

	it("snapshot ingests bridge RawElements through ObservationRegistry and formats identically to the CDP path", async () => {
		await backend.navigate(PAGE_URL);
		const snap = await backend.snapshot();

		// Expected output computed with the SAME canonical formatter the CDP
		// backend uses, over the refs the registry must mint from RAW_ELEMENTS.
		const expectedRefs: DurableRef[] = RAW_ELEMENTS.map((el, i) => ({
			id: i + 1,
			signature: el.signature,
			role: el.role,
			name: el.name,
			tag: el.tag,
			type: el.type,
			xpath: el.xpath,
			inViewport: el.inViewport,
			lastSeen: 1,
			rect: el.rect,
		}));
		const expected = ObservationRegistry.format({
			url: PAGE_URL,
			title: PAGE_TITLE,
			isInitial: true,
			full: expectedRefs,
			added: [],
			removed: [],
			changed: [],
			offscreenCount: 0,
			totalCount: 2,
			currentRefs: expectedRefs,
			obstructions: [],
			dialogs: [],
			crossOriginIframes: [],
		});
		expect(snap).toBe(expected);
		expect(snap).toContain(`Page: ${PAGE_TITLE} — ${PAGE_URL}`);
		expect(snap).toContain("[1]<button>Transfer funds</button>");
		expect(snap).toContain("[2]<textbox type=email>Email</textbox>");
	});

	it("second observe with the same DOM reports 'unchanged' with durable refs (diff semantics)", async () => {
		await backend.navigate(PAGE_URL);
		await backend.snapshot();
		const second = await backend.snapshot();
		expect(second).toContain("Page unchanged since last observation — same refs still valid.");
	});

	it("observe() returns a BrowserObservation with durable refs resolvable for A2", async () => {
		await backend.navigate(PAGE_URL);
		const obs = await backend.observe();
		expect(obs.url).toBe(PAGE_URL);
		expect(obs.isInitial).toBe(true);
		expect(obs.currentRefs.map((r) => r.name)).toEqual(["Transfer funds", "Email"]);
	});

	it("fingerprint reuses the canonical fingerprint script over the bridge", async () => {
		await backend.navigate(PAGE_URL);
		const fp = await backend.fingerprint();
		expect(fp).toBe(`${PAGE_URL}|${PAGE_TITLE}|1234|56`);
	});

	// ── Evaluate guard ─────────

	it("evaluate rejects blocked scripts before ANY bridge call", async () => {
		await expect(backend.evaluate("fetch('https://evil.example/x')")).rejects.toBeInstanceOf(
			EvaluateBlockedError,
		);
		await expect(backend.evaluate("document.cookie")).rejects.toThrow(/restricted pattern/);
		expect(browserExec).not.toHaveBeenCalled();
		expect(browserLifecycle).not.toHaveBeenCalled();
		expect(browserNavigate).not.toHaveBeenCalled();
	});

	it("evaluate runs safe scripts through the isolated exec channel", async () => {
		const out = await backend.evaluate("document.title");
		expect(out).toBe(PAGE_TITLE);
		expect(browserExec).toHaveBeenCalled();
	});

	// ── Screenshot ─────────

	it("screenshot captures via the bridge and returns the CDP-shaped saved-file report", async () => {
		await backend.navigate(PAGE_URL);
		const out = await backend.screenshot();
		expect(out).toMatch(
			/^Screenshot captured\nURL: https:\/\/example\.com\/\nTitle: Example Domain\nEngine: electron\nSize: \d+ bytes\nSaved: /,
		);
		expect(out).toContain("view_image");
		expect(browserCapture).toHaveBeenCalledWith(VIEW_ID);
	});

	// ── Simple A1 interactions ─────────

	it("click runs the selector script and returns the CDP click shape with a snapshot", async () => {
		await backend.navigate(PAGE_URL);
		const out = await backend.click("#submit");
		expect(out.startsWith(`Clicked: #submit\nPage: ${PAGE_URL}\n\n`)).toBe(true);
		expect(out).toContain("interactive elements:");
	});

	it("fill verifies the value landed and matches the CDP fill shape", async () => {
		await backend.navigate(PAGE_URL);
		const out = await backend.fill("#email", "hello");
		expect(out).toBe(`Filled "#email" with value (5 chars)`);
	});

	it("fill surfaces a mismatch as 'Fill did not land'", async () => {
		await backend.navigate(PAGE_URL);
		vi.mocked(browserExec).mockResolvedValueOnce({ ok: true, actual: "other", type: "" });
		await expect(backend.fill("#email", "hello")).rejects.toThrow(
			"Fill did not land: expected 'hello' got 'other'",
		);
	});

	it("select returns the CDP select shape", async () => {
		await backend.navigate(PAGE_URL);
		const out = await backend.select("#country", "opt1");
		expect(out).toBe(`Selected "opt1" in #country`);
	});

	it("click/fill on a missing element throws Element not found", async () => {
		await backend.navigate(PAGE_URL);
		vi.mocked(browserExec).mockResolvedValueOnce({ ok: false, error: "not-found" });
		await expect(backend.click("#ghost")).rejects.toThrow("Element not found: #ghost");
	});

	// ── A2 wiring / KB1 credential guard ─────────

	it("clickByRef routes through the A2 resolution chain over browserExec + browserInput", async () => {
		await backend.navigate(PAGE_URL);
		await backend.snapshot(); // mint refs [1]=button, [2]=textbox
		// Resolution round-trip resolves ref [1] at CSS (110,55); real input events follow.
		vi.mocked(browserExec).mockImplementation(async (_viewId, script) => {
			if (script.includes("occluded")) {
				return { found: true, via: "role", x: 110, y: 55, w: 100, h: 30, dpr: 1, zoom: 1, tag: "BUTTON", type: "", editable: false };
			}
			return routeExec(script);
		});
		vi.mocked(browserInput).mockResolvedValue(undefined);
		const res = await backend.clickByRef(1);
		expect(res.ok).toBe(true);
		expect(res.text).toContain("[1] click via role/name");
		// mouseMove → mouseDown → mouseUp at the converted DIP coords (zoom 1 ⇒ identity).
		const inputTypes = vi.mocked(browserInput).mock.calls.map(([, e]) => e.type);
		expect(inputTypes).toEqual(["mouseMove", "mouseDown", "mouseUp"]);
	});

	it("KB1: screenshot is blocked while a credential field is focused — browserCapture is NOT called", async () => {
		await backend.navigate(PAGE_URL);
		vi.mocked(browserExec).mockImplementation(async (_viewId, script) => {
			if (script.includes("current-password")) return true; // credential focus probe
			return routeExec(script);
		});
		const out = await backend.screenshot();
		expect(out).toBe(CREDENTIAL_CAPTURE_BLOCKED);
		expect(browserCapture).not.toHaveBeenCalled();
	});

	it("KB1: screenshot proceeds when no credential field is focused", async () => {
		await backend.navigate(PAGE_URL);
		// routeExec returns undefined for the credential probe (not === true) → proceed.
		const out = await backend.screenshot();
		expect(out).toContain("Screenshot captured");
		expect(browserCapture).toHaveBeenCalledWith(VIEW_ID);
	});

	// ── Perception (chunk E) ─────────

	it("readConsole reads the ACTIVE tab's ring and formats a compact report", async () => {
		vi.mocked(browserReadConsole).mockResolvedValue([
			{ level: "warning", message: "slow asset", ts: 1 },
			{ level: "error", message: "TypeError: boom", ts: 2 },
		]);
		await backend.navigate(PAGE_URL);
		await backend.newTab(PAGE_URL); // active tab: -t2
		const out = await backend.readConsole();
		expect(browserReadConsole).toHaveBeenCalledWith(`${VIEW_ID}-t2`);
		expect(out).toContain("Console: 2 message(s) (1 error(s), 1 warning(s)), newest last:");
		expect(out.endsWith("[error] TypeError: boom")).toBe(true);
	});

	it("readNetwork reads the ACTIVE tab's partition ring with in-flight count", async () => {
		vi.mocked(browserReadNetwork).mockResolvedValue({
			entries: [
				{ url: "https://api.example/x", method: "GET", status: 500, ts: 1 },
				{ url: "https://api.example/y", method: "POST", error: "net::ERR_FAILED", ts: 2 },
			],
			inFlight: 3,
		});
		await backend.navigate(PAGE_URL);
		const out = await backend.readNetwork();
		expect(browserReadNetwork).toHaveBeenCalledWith(VIEW_ID);
		expect(out).toContain("GET 500 https://api.example/x");
		expect(out).toContain("POST FAILED (net::ERR_FAILED) https://api.example/y");
		expect(out).toContain("3 request(s) in flight");
	});

	it("readConsole/readNetwork report empty states honestly", async () => {
		vi.mocked(browserReadConsole).mockResolvedValue([]);
		vi.mocked(browserReadNetwork).mockResolvedValue({ entries: [], inFlight: 0 });
		await backend.navigate(PAGE_URL);
		expect(await backend.readConsole()).toBe("No console messages captured for this tab.");
		expect(await backend.readNetwork()).toBe("No network requests captured for this tab. 0 request(s) in flight");
	});

	it("dialogs report not-supported without pretending to act", async () => {
		expect(await backend.dialogAccept()).toContain("No dialog was accepted");
		expect(await backend.dialogDismiss()).toContain("No dialog was dismissed");
	});

	it("downloads: list is the canonical empty state; approval/release fail closed", async () => {
		expect(backend.getDownloads()).toBe("No browser downloads recorded for this session.");
		expect(() => backend.getDownloadApproval("dl-1")).toThrow(InAppDownloadsUnavailableError);
		await expect(
			backend.releaseDownload("dl-1", {
				download_id: "dl-1",
				digest: "x",
				size: 1,
				filename: "f",
				content_type: "text/plain",
				detected_type: "text",
			}),
		).rejects.toBeInstanceOf(InAppDownloadsUnavailableError);
	});

	// ── Info / tabs ─────────

	it("getInfo mirrors the CDP shapes for inactive and active states", async () => {
		expect(await backend.getInfo()).toBe("No browser session active. Use 'navigate' to open a page.");
		await backend.navigate(PAGE_URL);
		const info = await backend.getInfo();
		expect(info).toBe(`Browser active\nEngine: electron\nURL: ${PAGE_URL}\nTitle: ${PAGE_TITLE}`);
	});

	it("listTabs/switchTab expose the single view as tab [0]", async () => {
		expect(await backend.listTabs()).toBe("No browser session active.");
		await backend.navigate(PAGE_URL);
		const tabs = await backend.listTabs();
		expect(tabs).toContain("1 tab(s) open:");
		expect(tabs).toContain(`[0] ${PAGE_TITLE} — ${PAGE_URL} ← active`);
		expect(await backend.switchTab(0)).toContain("Switched to tab [0]");
		expect(await backend.switchTab(3)).toContain("Invalid tab index 3");
	});

	// ── Lifecycle ─────────

	it("close tears down the view and resets state; a second close is a no-op", async () => {
		await backend.navigate(PAGE_URL);
		await backend.close();
		expect(browserLifecycle).toHaveBeenCalledWith("close", VIEW_ID);
		expect(backend.isActive()).toBe(false);
		expect(backend.getCurrentUrl()).toBe("");
		const closeCalls = vi.mocked(browserLifecycle).mock.calls.filter(([op]) => op === "close").length;
		await backend.close();
		expect(
			vi.mocked(browserLifecycle).mock.calls.filter(([op]) => op === "close").length,
		).toBe(closeCalls);
	});

	it("navigate after close recreates the view", async () => {
		await backend.navigate(PAGE_URL);
		await backend.close();
		await backend.navigate(PAGE_URL);
		expect(backend.isActive()).toBe(true);
		const createCalls = vi.mocked(browserLifecycle).mock.calls.filter(([op]) => op === "create").length;
		expect(createCalls).toBe(2);
	});

	it("adopts a view another instance already created (create → already exists)", async () => {
		vi.mocked(browserLifecycle).mockImplementation(async (op) => {
			if (op === "create") throw new Error(`browser view "${VIEW_ID}" already exists`);
			if (op === "ping") return { ping: { ok: true, url: PAGE_URL, title: PAGE_TITLE } };
			return {};
		});
		const out = await backend.navigate(PAGE_URL);
		expect(out).toContain("Navigated to:");
		expect(backend.isActive()).toBe(true);
	});

	// ── Hostile page: isolated-world invariant ─────────

	it("all page-script execution flows through browserExec (isolated-only) — a poisoned MAIN world cannot hide elements", async () => {
		await backend.navigate(PAGE_URL);
		const snap = await backend.snapshot();
		await backend.fingerprint();
		await backend.evaluate("document.title");
		await backend.extractText();

		// The extractor result comes from the ISOLATED world: the element a
		// poisoned main world would have hidden is present in the snapshot.
		expect(snap).toContain("Transfer funds");

		// Every script went through browserExec — the transport that the desktop
		// side executes ONLY in isolated world 1901 — and no call asked for any
		// other world (the opts type doesn't even admit one).
		const calls = vi.mocked(browserExec).mock.calls;
		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) {
			const opts = call[2];
			expect(opts === undefined || opts.world === undefined || opts.world === "isolated").toBe(true);
		}
		// No other channel that could carry a script: input events carry no code
		// and were never used in A1; there is no main-world API on the bridge.
		expect(browserInput).not.toHaveBeenCalled();
	});

	// ── Multi-tab + user-tab takeover (chunk B) ─────────

	describe("multi-tab / user-tab takeover", () => {
		const USER_URL = "https://user.example/inbox";
		const USER_TITLE = "User Inbox";
		const USER_VIEW = {
			viewId: "view-user-main", partition: "persist:lax-profile-work",
			url: USER_URL, title: USER_TITLE, attached: true, agentDriven: false,
		};
		const OTHER_AGENT_VIEW = {
			viewId: "view-other-sess-work", partition: "persist:lax-profile-work",
			url: "https://other-session.example/", title: "Other Session Page", attached: false, agentDriven: true,
		};

		/** Lifecycle mock with a populated desktop pool listing and per-view pings. */
		function mockDesktopPool(views: Array<typeof USER_VIEW>): void {
			vi.mocked(browserLifecycle).mockImplementation(async (op, viewId) => {
				if (op === "list") return { views };
				if (op === "ping") {
					const v = views.find((x) => x.viewId === viewId);
					return { ping: { ok: true, url: v?.url ?? PAGE_URL, title: v?.title ?? PAGE_TITLE } };
				}
				if (op === "create") {
					return {
						view: { viewId, partition: "persist:lax-profile-work", url: "", title: "", attached: false, agentDriven: true },
					};
				}
				return {};
			});
		}

		it("listTabs merges the user's own views (marked as takeover) and EXCLUDES other sessions' agent views", async () => {
			mockDesktopPool([USER_VIEW, OTHER_AGENT_VIEW]);
			await backend.navigate(PAGE_URL);
			const tabs = await backend.listTabs();
			expect(tabs).toContain("2 tab(s) open:");
			expect(tabs).toContain(`[0] ${PAGE_TITLE} — ${PAGE_URL} ← active`);
			expect(tabs).toContain(`[1] ${USER_TITLE} — ${USER_URL} [user tab — switch_tab(1) takes control]`);
			expect(tabs).not.toContain("Other Session Page");
			expect(tabs).not.toContain("view-other-sess-work");
		});

		it("switch_tab onto a user view ADOPTS it (owned:false): active follows, no create, no re-listing as user tab", async () => {
			mockDesktopPool([USER_VIEW, OTHER_AGENT_VIEW]);
			await backend.navigate(PAGE_URL);
			await backend.listTabs(); // pins the merged ordering — takeover requires a current listing
			const msg = await backend.switchTab(1);
			expect(msg).toBe(`Switched to tab [1]: ${USER_TITLE} — ${USER_URL}`);
			// Adoption, not creation: the user's view was never re-created.
			const creates = vi.mocked(browserLifecycle).mock.calls.filter(([op]) => op === "create");
			expect(creates.map(([, id]) => id)).not.toContain("view-user-main");
			// The active tab now IS the user's view: ops target it.
			expect(backend.getCurrentUrl()).toBe(USER_URL);
			await backend.screenshot();
			expect(browserCapture).toHaveBeenCalledWith("view-user-main");
			// And the listing shows it as an owned row (adopted — no takeover marker, not duplicated).
			const tabs = await backend.listTabs();
			expect(tabs).toContain("2 tab(s) open:");
			expect(tabs).toContain(`[1] ${USER_TITLE} — ${USER_URL} ← active`);
			expect(tabs).not.toContain("takes control");
		});

		it("switch_tab back to an agent tab retargets every viewId-keyed op, including secretOps (call-time resolution)", async () => {
			mockDesktopPool([USER_VIEW]);
			await backend.navigate(PAGE_URL);
			await backend.newTab(PAGE_URL); // active: -t2
			const ops = backend.secretOps();
			await ops.currentOrigin();
			expect(vi.mocked(browserExec).mock.calls.at(-1)?.[0]).toBe(`${VIEW_ID}-t2`);
			await backend.switchTab(0); // back to the first tab
			await ops.currentOrigin(); // SAME ops object — must follow the switch
			expect(vi.mocked(browserExec).mock.calls.at(-1)?.[0]).toBe(VIEW_ID);
		});

		it("close() closes OWNED views only — the adopted user view is dropped, never closed", async () => {
			mockDesktopPool([USER_VIEW]);
			await backend.navigate(PAGE_URL);
			await backend.newTab(PAGE_URL); // -t2 (owned)
			await backend.listTabs(); // pins the merged ordering — takeover requires a current listing
			await backend.switchTab(2); // merged: [0]=first, [1]=t2, [2]=user → adopt
			expect(backend.getCurrentUrl()).toBe(USER_URL);
			await backend.close();
			const closed = vi.mocked(browserLifecycle).mock.calls.filter(([op]) => op === "close").map(([, id]) => id);
			expect(closed.sort()).toEqual([VIEW_ID, `${VIEW_ID}-t2`].sort());
			expect(closed).not.toContain("view-user-main");
			expect(backend.isActive()).toBe(false);
			expect(backend.getCurrentUrl()).toBe("");
		});

		it("never reuses a tab number within the backend's lifetime, even across close()", async () => {
			await backend.navigate(PAGE_URL);
			await backend.newTab(PAGE_URL); // -t2
			await backend.close();
			await backend.navigate(PAGE_URL);
			await backend.newTab(PAGE_URL); // must be -t3, never -t2 again
			const creates = vi.mocked(browserLifecycle).mock.calls.filter(([op]) => op === "create").map(([, id]) => id);
			expect(creates).toContain(`${VIEW_ID}-t3`);
			expect(creates.filter((id) => id === `${VIEW_ID}-t2`)).toHaveLength(1);
		});

		it("a failed new_tab create rolls the minted tab back (no ghost row, N still not reused)", async () => {
			await backend.navigate(PAGE_URL);
			vi.mocked(browserLifecycle).mockImplementationOnce(async () => {
				throw new Error("view pool exhausted");
			});
			await expect(backend.newTab(PAGE_URL)).rejects.toThrow("view pool exhausted");
			const tabs = await backend.listTabs();
			expect(tabs).toContain("1 tab(s) open:");
			expect(tabs).not.toContain("-t2");
			await backend.newTab(PAGE_URL);
			expect(browserLifecycle).toHaveBeenCalledWith("create", `${VIEW_ID}-t3`, expect.anything());
		});

		it("sensitive user rows are withheld in the listing and on switch (same rule as page-ops)", async () => {
			const vaultView = {
				...USER_VIEW,
				viewId: "view-user-vault",
				url: "https://vault.bitwarden.com/passwords",
				title: "My Vault",
			};
			mockDesktopPool([vaultView]);
			await backend.navigate(PAGE_URL);
			const tabs = await backend.listTabs();
			expect(tabs).toContain("[1] [sensitive page withheld] [user tab — switch_tab(1) takes control]");
			expect(tabs).not.toContain("bitwarden");
			expect(tabs).not.toContain("My Vault");
			const msg = await backend.switchTab(1);
			expect(msg).toContain("[SENSITIVE PAGE CONTENT WITHHELD]");
			expect(msg).not.toContain("My Vault");
		});
	});
});
