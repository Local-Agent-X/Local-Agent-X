import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, it, expect, beforeEach, vi } from "vitest";

let body: unknown = {};
const jsonResponse = vi.fn();
vi.mock("../../server-utils.js", () => ({
	safeParseBody: vi.fn(async () => body),
	jsonResponse: (...args: unknown[]) => jsonResponse(...args),
}));

const restoreDeleted = vi.fn((path: string, _opts: unknown) =>
	path.endsWith("gone.json") ? { error: "The trashed copy is gone." } : { restored: path, tier: "os" });
vi.mock("../../trash-restore.js", () => ({ restoreDeleted: (p: string, o: unknown) => restoreDeleted(p, o) }));

const { handleTrashRestoreRoute } = await import("./trash-restore-route.js");

const req = {} as IncomingMessage;
const res = {} as ServerResponse;
const call = (method: string, path: string) => handleTrashRestoreRoute(method, new URL(`http://x${path}`), req, res);
const reply = () => ({ status: jsonResponse.mock.calls.at(-1)![1] as number, data: jsonResponse.mock.calls.at(-1)![2] as Record<string, unknown> });

describe("POST /api/trash/restore — the Undo on a delete notice", () => {
	beforeEach(() => { jsonResponse.mockClear(); restoreDeleted.mockClear(); });

	it("restores each path through restoreDeleted, the same restore restore_file runs, one result per path", async () => {
		body = { paths: ["C:/w/ns_tmp.json", "C:/w/gone.json"], sessionId: "s1" };
		expect(await call("POST", "/api/trash/restore")).toBe(true);
		expect(restoreDeleted).toHaveBeenCalledWith("C:/w/ns_tmp.json", { sessionId: "s1" });
		expect(reply()).toEqual({ status: 200, data: { results: [
			{ path: "C:/w/ns_tmp.json", restored: "C:/w/ns_tmp.json", tier: "os" },
			{ path: "C:/w/gone.json", error: "The trashed copy is gone." },
		] } });
	});

	it("refuses a missing, empty, non-string or oversized path list without touching the trash", async () => {
		for (const bad of [{}, { paths: [] }, { paths: [3] }, { paths: [""] }, { paths: Array(51).fill("x") }]) {
			body = bad;
			await call("POST", "/api/trash/restore");
			expect(reply().status).toBe(400);
		}
		expect(restoreDeleted).not.toHaveBeenCalled();
	});

	it("leaves every other path and method to the next handler", async () => {
		expect(await call("GET", "/api/trash/restore")).toBe(false);
		expect(await call("POST", "/api/trash")).toBe(false);
	});
});
