/**
 * A browser view never takes focus by navigating (2026-11-23).
 *
 * Electron's default pulls OS focus into a webContents on every navigation:
 * the agent's loadURL, or a link the page follows after the agent's click.
 * That took the caret out of the chat box the user was typing in. Every view
 * and every popup child is built from viewWebPreferences, so it is pinned here.
 */
import { describe, expect, it, vi } from "vitest";

// A session that accepts any hardening call: this test is about the prefs.
const { anything } = vi.hoisted(() => {
	const anything: unknown = new Proxy(function () {}, {
		get: (_t, prop) => (prop === "then" ? undefined : anything),
		apply: () => anything,
	});
	return { anything };
});
vi.mock("electron", () => ({ app: anything, session: { fromPartition: () => anything }, dialog: anything }));
vi.mock("./config", () => ({ LAX_DIR: "/nonexistent-lax-dir", getLAXConfig: () => ({}) }));

import { SHARED_BROWSER_PARTITION, viewWebPreferences } from "./browser-partition";

describe("viewWebPreferences", () => {
	it("keeps views from taking focus on navigation", () => {
		expect(viewWebPreferences(SHARED_BROWSER_PARTITION).focusOnNavigation).toBe(false);
	});

	it("keeps the sandbox and input-delivery settings it already had", () => {
		expect(viewWebPreferences(SHARED_BROWSER_PARTITION)).toMatchObject({
			partition: SHARED_BROWSER_PARTITION,
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true,
			backgroundThrottling: false,
		});
	});
});
