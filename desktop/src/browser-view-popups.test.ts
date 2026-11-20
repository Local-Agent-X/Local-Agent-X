// A popup's failures used to be INVISIBLE.
//
// Live incident 2026-09-22: a "Continue with Google" popup opened from the
// in-app browser and painted nothing but white. desktop-stdio.log recorded
// nothing at all — not the window opening, not what it loaded, not it closing.
// With no trace there was no way to separate "Google refused to serve an
// embedded browser" from "the page loaded fine and failed to paint", which are
// different bugs with different owners (docs/known-issues.md).
//
// Two properties matter and both are pinned here:
//   1. the SUCCESS path is logged, not only errors — `did-fail-load` alone
//      would have stayed silent for that incident, because the load did not
//      fail;
//   2. only the ORIGIN is ever written. A popup-mode OAuth URL carries `code`
//      / `id_token` / `access_token` / `state`; logging one whole would put a
//      live credential in a log file.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { managePopups, opensAsTab, popupOrigin, MAX_POPUPS_PER_VIEW } from "./browser-view-popups";

type Handler = (...args: unknown[]) => void;

/** Minimal WebContents double: records listeners so tests can fire events. */
function fakeContents() {
	const listeners = new Map<string, Handler[]>();
	let openHandler: ((d: { url: string; disposition?: string }) => unknown) | null = null;
	return {
		setWindowOpenHandler(fn: (d: { url: string; disposition?: string }) => unknown) { openHandler = fn; },
		on(event: string, fn: Handler) {
			const list = listeners.get(event) ?? [];
			list.push(fn);
			listeners.set(event, list);
			return this;
		},
		/** Drive the handler the real Electron would call. */
		requestOpen(url: string, disposition = "new-window") { return openHandler?.({ url, disposition }); },
		emit(event: string, ...args: unknown[]) {
			for (const fn of listeners.get(event) ?? []) fn(...args);
		},
		has(event: string) { return (listeners.get(event) ?? []).length > 0; },
	};
}

type FakeContents = ReturnType<typeof fakeContents>;

function fakeChild(contents: FakeContents) {
	const closeHandlers: Handler[] = [];
	return {
		webContents: contents,
		once(event: string, fn: Handler) { if (event === "closed") closeHandlers.push(fn); },
		close() { /* not exercised here */ },
		isDestroyed() { return false; },
		fireClosed() { for (const fn of closeHandlers) fn(); },
	};
}

let log: ReturnType<typeof vi.spyOn>;
let err: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	log = vi.spyOn(console, "log").mockImplementation(() => {});
	err = vi.spyOn(console, "error").mockImplementation(() => {});
	warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

const lines = (spy: ReturnType<typeof vi.spyOn>): string[] =>
	spy.mock.calls.map((c: unknown[]) => String(c[0]));

/** Open one popup through the real discipline and hand back its contents. */
function openPopup(url: string) {
	const parent = fakeContents();
	managePopups(parent as never, { webPreferences: () => ({}) });
	parent.requestOpen(url);
	const child = fakeContents();
	parent.emit("did-create-window", fakeChild(child));
	return { parent, child };
}

// The OAuth URL shape that made this worth pinning: a real authorization
// request, with a token in the fragment on the way back.
const OAUTH_URL =
	"https://accounts.google.com/o/oauth2/v2/auth?client_id=123.apps.googleusercontent.com" +
	"&state=SECRETSTATE&code=SECRETCODE#access_token=SECRETTOKEN";

describe("popupOrigin", () => {
	it("keeps the origin and drops every credential-bearing part", () => {
		expect(popupOrigin(OAUTH_URL)).toBe("https://accounts.google.com");
	});

	it("names an opaque origin by its scheme — `window.open()` with no URL is the common case", () => {
		// URL("about:blank").origin is the literal string "null", which would
		// print as "[browser-popup] null — opened" and read as a defect.
		expect(popupOrigin("about:blank#weird")).toBe("about:");
		expect(popupOrigin("data:text/html,<p>hi</p>")).toBe("data:");
	});

	it("does not throw on a URL it cannot parse", () => {
		expect(popupOrigin("")).toBe("(unparseable url)");
		expect(popupOrigin("not a url at all")).toBe("(unparseable url)");
	});
});

describe("a popup's lifetime is traceable", () => {
	it("logs the SUCCESS path — a load that worked is the evidence a white window needs", () => {
		const { child } = openPopup(OAUTH_URL);
		child.emit("did-navigate", {}, OAUTH_URL);
		child.emit("did-finish-load");

		const out = lines(log).join("\n");
		expect(out).toContain("opened");
		expect(out).toContain("navigated https://accounts.google.com");
		expect(out).toContain("finished load");
	});

	it("never writes a credential — no line carries anything past the origin", () => {
		const { child } = openPopup(OAUTH_URL);
		child.emit("did-navigate", {}, OAUTH_URL);
		child.emit("did-finish-load");
		child.emit("did-fail-load", {}, -2, "ERR_FAILED", OAUTH_URL, true);

		const every = [...lines(log), ...lines(err), ...lines(warn)].join("\n");
		for (const secret of ["SECRETSTATE", "SECRETCODE", "SECRETTOKEN", "client_id"]) {
			expect(every).not.toContain(secret);
		}
	});

	it("reports a real main-frame load failure", () => {
		const { child } = openPopup("https://accounts.google.com/signin");
		child.emit("did-fail-load", {}, -2, "ERR_FAILED", "https://accounts.google.com/signin", true);
		expect(lines(err).join("\n")).toContain("load FAILED https://accounts.google.com: -2 ERR_FAILED");
	});

	it("stays quiet for a subframe failure and for ABORTED, which every OAuth redirect emits", () => {
		const { child } = openPopup("https://accounts.google.com/signin");
		child.emit("did-fail-load", {}, -2, "ERR_FAILED", "https://tracker.example/pixel", false);
		child.emit("did-fail-load", {}, -3, "ERR_ABORTED", "https://accounts.google.com/signin", true);
		expect(err).not.toHaveBeenCalled();
	});

	it("reports a dead renderer and an unresponsive one", () => {
		const { child } = openPopup("https://accounts.google.com/signin");
		child.emit("render-process-gone", {}, { reason: "crashed", exitCode: 133 });
		child.emit("unresponsive");
		const out = lines(err).join("\n");
		expect(out).toContain("renderer gone: crashed (exit 133)");
		expect(out).toContain("unresponsive");
	});

	it("logs the close, so an abandoned popup is distinguishable from a hung one", () => {
		const parent = fakeContents();
		managePopups(parent as never, { webPreferences: () => ({}) });
		parent.requestOpen("https://accounts.google.com/signin");
		const child = fakeChild(fakeContents());
		parent.emit("did-create-window", child);
		child.fireClosed();
		expect(lines(log).join("\n")).toContain("closed");
	});
});

describe("the popup cap", () => {
	it("says so when it denies, instead of the silent nothing the site sees", () => {
		const parent = fakeContents();
		managePopups(parent as never, { webPreferences: () => ({}) });
		for (let i = 0; i < MAX_POPUPS_PER_VIEW; i++) {
			parent.requestOpen("https://accounts.google.com/signin");
			parent.emit("did-create-window", fakeChild(fakeContents()));
		}
		warn.mockClear();
		const verdict = parent.requestOpen("https://accounts.google.com/signin") as { action: string };
		expect(verdict.action).toBe("deny");
		expect(lines(warn).join("\n")).toContain("DENIED");
	});

	it("still allows a popup under the cap", () => {
		const parent = fakeContents();
		managePopups(parent as never, { webPreferences: () => ({}) });
		const verdict = parent.requestOpen(OAUTH_URL) as { action: string };
		expect(verdict.action).toBe("allow");
	});
});

// Live 2026-11-19: OneDrive's "Sign in" link opened a small separate window,
// and after sign-in the user's whole OneDrive session lived in it instead of
// the pane. A link that asks for a TAB must become a pane tab; a sized
// popup-mode sign-in must stay a window, or it loses the opener it reports to.
describe("a new-tab open becomes a pane tab", () => {
	type Verdict = { action: string; createWindow?: (o: unknown) => unknown };

	function viewWithTabs(opener: ((o: unknown) => unknown) | null) {
		const parent = fakeContents();
		const tracker = managePopups(parent as never, {
			webPreferences: () => ({ partition: "persist:test" }),
			tabOpener: () => opener as never,
		});
		return { parent, tracker };
	}

	it("routes a foreground or background tab open to the pane, keeping the opener's webContents", () => {
		const hosted: unknown[] = [];
		const tab = { id: 7 };
		const { parent, tracker } = viewWithTabs((o) => { hosted.push(o); return tab; });
		for (const disposition of ["foreground-tab", "background-tab"]) {
			const verdict = parent.requestOpen("https://onedrive.live.com/", disposition) as Verdict;
			expect(verdict.action).toBe("allow");
			const options = { webContents: { id: 7 } };
			expect(verdict.createWindow?.(options)).toBe(tab);
			expect(hosted.at(-1)).toBe(options);
		}
		// A tab is the pool's, not a popup: it does not count against the cap.
		expect(tracker.count()).toBe(0);
	});

	it("keeps a sized popup (new-window) a managed window, so sign-in popups still report back", () => {
		const { parent } = viewWithTabs(() => ({}));
		const verdict = parent.requestOpen("https://login.live.com/oauth20_authorize.srf", "new-window") as Verdict;
		expect(verdict.action).toBe("allow");
		expect(verdict.createWindow).toBeUndefined();
	});

	it("keeps popups when there is no pane to host a tab (agent views, nothing wired)", () => {
		const { parent } = viewWithTabs(null);
		const verdict = parent.requestOpen("https://onedrive.live.com/", "foreground-tab") as Verdict;
		expect(verdict.createWindow).toBeUndefined();
	});

	it("leaves a popup's own tab opens as windows — the sign-in flow owns them", () => {
		const { parent } = viewWithTabs(() => ({}));
		parent.requestOpen("https://login.live.com/", "new-window");
		const child = fakeContents();
		parent.emit("did-create-window", fakeChild(child));
		const verdict = child.requestOpen("https://login.live.com/help", "foreground-tab") as Verdict;
		expect(verdict.createWindow).toBeUndefined();
	});

	it("names only the two tab dispositions as tabs", () => {
		expect(opensAsTab("foreground-tab")).toBe(true);
		expect(opensAsTab("background-tab")).toBe(true);
		for (const d of ["new-window", "default", "other", ""]) expect(opensAsTab(d)).toBe(false);
	});
});
