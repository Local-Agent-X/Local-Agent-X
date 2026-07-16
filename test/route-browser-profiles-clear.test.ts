// Server route: DELETE /api/browser/profiles/:id/data — clear a profile's
// saved logins WITHOUT deleting the record (src/routes/browser/profiles.ts).
// A profile resolves to two physical stores keyed by the same id, so a clear
// must hit both: the Electron partition (over the bridge, browserClearPartition)
// AND the on-disk CDP userDataDir twin (rmSync). This test mocks the store, the
// bridge, and node:fs so it asserts the route's two-store contract hermetically.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockJsonRequest, mockResponse } from "./helpers/http-mocks.js";
import type { ServerContext } from "../src/server-context.js";

const bridge = vi.hoisted(() => ({ clear: vi.fn(async () => {}) }));
const fs = vi.hoisted(() => ({ removed: [] as string[] }));
const store = vi.hoisted(() => ({
	profiles: new Map<string, { id: string; name: string; partition: string; userDataDir: string; lastUsedAt: number; createdAt: number }>(),
}));

vi.mock("../src/browser/bridge-client.js", () => ({
	browserClearPartition: (partition: string) => bridge.clear(partition),
}));

// Real node:fs except rmSync, which we record instead of touching disk.
vi.mock("node:fs", async (orig) => {
	const actual = await orig<typeof import("node:fs")>();
	return { ...actual, rmSync: (p: string) => { fs.removed.push(String(p)); } };
});

vi.mock("../src/browser/profile-store.js", () => ({
	// Canonical dir derivation — the clear route compares against this before
	// the recursive delete, so the mock must mirror the paths seeded below.
	profileUserDataDir: (id: string) => `/lax/browser-profiles/${id}`,
	BrowserProfileStore: {
		getInstance: () => ({
			get: (id: string) => store.profiles.get(id) ?? null,
			// Mirror the real store: the built-in "default" profile can't be deleted.
			delete: (id: string) => {
				if (id === "default") return false;
				return store.profiles.delete(id);
			},
		}),
	},
}));

// Import AFTER the mocks are registered.
const { handleBrowserProfileRoutes } = await import("../src/routes/browser/profiles.js");

const ctx = {} as ServerContext;

function seed() {
	store.profiles.clear();
	store.profiles.set("default", { id: "default", name: "Default", partition: "persist:lax-profile-default", userDataDir: "/lax/browser-profiles/default", lastUsedAt: 1, createdAt: 0 });
	store.profiles.set("p1", { id: "p1", name: "Work", partition: "persist:lax-profile-p1", userDataDir: "/lax/browser-profiles/p1", lastUsedAt: 1, createdAt: 0 });
}

async function call(method: string, path: string) {
	const url = new URL("http://test" + path);
	const cap = mockResponse();
	const handled = await handleBrowserProfileRoutes(method, url, mockJsonRequest({}), cap.res, ctx, "user");
	return { handled, status: cap.status, body: cap.body ? JSON.parse(cap.body) : null };
}

beforeEach(() => {
	seed();
	bridge.clear.mockClear();
	fs.removed = [];
});
afterEach(() => vi.clearAllMocks());

describe("DELETE /api/browser/profiles/:id/data — clear saved logins", () => {
	it("clears BOTH stores: bridge partition wipe + userDataDir removal", async () => {
		const res = await call("DELETE", "/api/browser/profiles/p1/data");
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ ok: true });
		expect(bridge.clear).toHaveBeenCalledWith("persist:lax-profile-p1");
		expect(fs.removed).toEqual(["/lax/browser-profiles/p1"]);
	});

	it("the DEFAULT profile is clearable (you can log it out without deleting it)", async () => {
		const res = await call("DELETE", "/api/browser/profiles/default/data");
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ ok: true });
		expect(bridge.clear).toHaveBeenCalledWith("persist:lax-profile-default");
		expect(fs.removed).toEqual(["/lax/browser-profiles/default"]);
	});

	it("fail-safe: a bridge failure (no live view / off-desktop) still wipes the disk twin", async () => {
		bridge.clear.mockRejectedValueOnce(new Error("browser bridge unavailable"));
		const res = await call("DELETE", "/api/browser/profiles/p1/data");
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ ok: true });
		// Bridge threw, but the on-disk twin was still removed.
		expect(fs.removed).toEqual(["/lax/browser-profiles/p1"]);
	});

	it("clearing an unknown profile is a 404 and touches neither store", async () => {
		const res = await call("DELETE", "/api/browser/profiles/ghost/data");
		expect(res.status).toBe(404);
		expect(bridge.clear).not.toHaveBeenCalled();
		expect(fs.removed).toEqual([]);
	});

	it("refuses the recursive delete when userDataDir isn't the canonical dir for the id", async () => {
		// A corrupted config could carry a rogue path; the guard must never rm it.
		store.profiles.set("evil", { id: "evil", name: "Evil", partition: "persist:lax-profile-evil", userDataDir: "/", lastUsedAt: 1, createdAt: 0 });
		const res = await call("DELETE", "/api/browser/profiles/evil/data");
		expect(res.status).toBe(200);
		// Partition wipe still runs (harmless), but the on-disk rm is refused.
		expect(bridge.clear).toHaveBeenCalledWith("persist:lax-profile-evil");
		expect(fs.removed).toEqual([]);
	});
});

describe("DELETE /api/browser/profiles/:id — plain delete keeps default protected", () => {
	it("refuses to delete the default profile (409) — clear-vs-delete are disjoint", async () => {
		const res = await call("DELETE", "/api/browser/profiles/default");
		expect(res.status).toBe(409);
		expect(res.body.ok).toBeFalsy();
		expect(store.profiles.has("default")).toBe(true);
	});

	it("deletes a non-default profile (200)", async () => {
		const res = await call("DELETE", "/api/browser/profiles/p1");
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ ok: true });
		expect(store.profiles.has("p1")).toBe(false);
	});
});
