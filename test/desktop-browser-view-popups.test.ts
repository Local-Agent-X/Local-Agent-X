// Regression: "Sign in with Google" on the in-app browser did nothing — the
// view's window-open handler denied every popup, so popup-mode OAuth died
// silently. managePopups replaces the deny while keeping the invariants the
// deny existed for: children are hardened per-webContents, carry the view's
// partition webPreferences, get the same discipline recursively, and are
// closed with the view.
import { describe, it, expect, vi } from "vitest";
import type { BrowserWindow, WebContents } from "electron";
import { managePopups, MAX_POPUPS_PER_VIEW, type PopupDeps } from "../desktop/src/browser-view-popups";

type OpenHandlerResult = { action: "allow" | "deny"; overrideBrowserWindowOptions?: { webPreferences?: unknown } };

interface FakeContents {
	wc: WebContents;
	/** Invoke the installed window-open handler as Electron would. */
	open(): OpenHandlerResult;
	/** Fire did-create-window for a child, as Electron does after an allow. */
	createWindow(child: FakeWindow): void;
}

interface FakeWindow {
	win: BrowserWindow;
	wc: FakeContents;
	close: ReturnType<typeof vi.fn>;
	emitClosed(): void;
}

function fakeContents(): FakeContents {
	let openHandler: (() => OpenHandlerResult) | null = null;
	const listeners = new Map<string, (...args: unknown[]) => void>();
	const wc = {
		setWindowOpenHandler: (fn: () => OpenHandlerResult) => { openHandler = fn; },
		on: (event: string, fn: (...args: unknown[]) => void) => { listeners.set(event, fn); },
	} as unknown as WebContents;
	return {
		wc,
		open: () => {
			if (!openHandler) throw new Error("no window-open handler installed");
			return openHandler();
		},
		createWindow: (child) => {
			const fn = listeners.get("did-create-window");
			if (!fn) throw new Error("no did-create-window listener installed");
			fn(child.win);
		},
	};
}

function fakeWindow(): FakeWindow {
	const wc = fakeContents();
	const close = vi.fn();
	let closedListener: (() => void) | null = null;
	const win = {
		webContents: wc.wc,
		isDestroyed: () => false,
		close,
		once: (event: string, fn: () => void) => {
			if (event === "closed") closedListener = fn;
		},
	} as unknown as BrowserWindow;
	return {
		win,
		wc,
		close,
		emitClosed: () => closedListener?.(),
	};
}

function deps(): PopupDeps & { hardened: WebContents[] } {
	const hardened: WebContents[] = [];
	return {
		hardened,
		webPreferences: () => ({ partition: "persist:lax-profile-test", sandbox: true }),
		harden: (wc) => { hardened.push(wc); },
	};
}

describe("managePopups", () => {
	it("allows a popup and stamps it with the view's webPreferences", () => {
		const view = fakeContents();
		managePopups(view.wc, deps());
		const result = view.open();
		expect(result.action).toBe("allow");
		expect(result.overrideBrowserWindowOptions?.webPreferences).toMatchObject({
			partition: "persist:lax-profile-test",
			sandbox: true,
		});
	});

	it("hardens every created child and tracks it", () => {
		const view = fakeContents();
		const d = deps();
		const tracker = managePopups(view.wc, d);
		const child = fakeWindow();
		view.open();
		view.createWindow(child);
		expect(d.hardened).toContain(child.wc.wc);
		expect(tracker.count()).toBe(1);
	});

	it("gives children the same discipline recursively", () => {
		const view = fakeContents();
		const d = deps();
		const tracker = managePopups(view.wc, d);
		const child = fakeWindow();
		view.createWindow(child);
		// The child's own window.open must be handled — and counted against the
		// SAME cap, not a fresh one.
		const grandchild = fakeWindow();
		expect(child.wc.open().action).toBe("allow");
		child.wc.createWindow(grandchild);
		expect(d.hardened).toContain(grandchild.wc.wc);
		expect(tracker.count()).toBe(2);
	});

	it("denies past the cap and frees a slot when a popup closes", () => {
		const view = fakeContents();
		managePopups(view.wc, deps());
		const children: FakeWindow[] = [];
		for (let i = 0; i < MAX_POPUPS_PER_VIEW; i++) {
			const child = fakeWindow();
			children.push(child);
			expect(view.open().action).toBe("allow");
			view.createWindow(child);
		}
		expect(view.open().action).toBe("deny");
		children[0].emitClosed();
		expect(view.open().action).toBe("allow");
	});

	it("closeAll closes every live popup", () => {
		const view = fakeContents();
		const tracker = managePopups(view.wc, deps());
		const a = fakeWindow();
		const b = fakeWindow();
		view.createWindow(a);
		view.createWindow(b);
		tracker.closeAll();
		expect(a.close).toHaveBeenCalled();
		expect(b.close).toHaveBeenCalled();
		expect(tracker.count()).toBe(0);
	});
});
