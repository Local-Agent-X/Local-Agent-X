/**
 * The tool-layer sensitive-page gate at the REAL config default
 * (browserSecrecy="ask") — the security-critical execute() sequence that unit
 * tests on sensitive-pages.ts cannot see:
 *   - no approval channel (no _onEvent) → hard block, approval never asked;
 *   - declined approval → declined, the read never dispatched;
 *   - APPROVED secret read → content flows through the post-dispatch stub
 *     backstop (the read grant must cover the whole dispatch tail — a grant
 *     released too early would clobber the approved content with the stub);
 *   - an approved MUTATION does not unlock reads: its result still leaves
 *     through the stub backstop withheld.
 * The level ladder itself is pinned in src/browser/sensitive-pages.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const seam = vi.hoisted(() => ({
	approval: vi.fn<(req: unknown) => Promise<{ approved: boolean }>>(),
	manager: {} as Record<string, unknown>,
}));

vi.mock("../../browser/index.js", () => ({
	getBrowserManager: () => seam.manager,
	closeBrowser: vi.fn(),
	withBrowserLock: (_sid: string, fn: () => Promise<unknown>) => fn(),
	resetWedgedBrowser: vi.fn(async () => "soft-recovered"),
	BrowserWedgeError: class BrowserWedgeError extends Error {},
}));
vi.mock("../../approval-manager.js", () => ({
	getApprovalManager: () => ({ requestApprovalDetailed: seam.approval }),
}));

import { createBrowserTools } from "./index.js";

const VAULT = "https://vault.bitwarden.com/passwords";

function tool() {
	const [t] = createBrowserTools(() => "gate-sess");
	return t;
}

beforeEach(() => {
	seam.approval.mockReset();
	for (const k of Object.keys(seam.manager)) delete seam.manager[k];
	seam.manager.getCurrentUrl = () => VAULT;
});

describe("browser tool sensitive-page gate (browserSecrecy default = ask)", () => {
	it("hard-blocks a secret read when no approval channel exists (autonomous run)", async () => {
		const readConsole = vi.fn(async () => "SECRET-CONSOLE-LINE");
		seam.manager.readConsole = readConsole;
		const r = await tool().execute({ action: "read_console", _sessionId: "auto-sess" });
		expect(String(r.content)).toContain("approval is unavailable");
		expect(seam.approval).not.toHaveBeenCalled();
		expect(readConsole).not.toHaveBeenCalled();
	});

	it("a declined approval never dispatches the read", async () => {
		seam.approval.mockResolvedValue({ approved: false });
		const readConsole = vi.fn(async () => "SECRET-CONSOLE-LINE");
		seam.manager.readConsole = readConsole;
		const r = await tool().execute({ action: "read_console", _sessionId: "s-declined", _onEvent: () => {} });
		expect(String(r.content)).toContain("not approved");
		expect(readConsole).not.toHaveBeenCalled();
	});

	it("an APPROVED secret read flows through the post-dispatch stub backstop unclobbered", async () => {
		seam.approval.mockResolvedValue({ approved: true });
		seam.manager.readConsole = async () => "SECRET-CONSOLE-LINE";
		const r = await tool().execute({ action: "read_console", _sessionId: "s-approved", _onEvent: () => {} });
		expect(seam.approval).toHaveBeenCalledOnce();
		expect(String(r.content)).toContain("SECRET-CONSOLE-LINE");
		expect(String(r.content)).not.toContain("SENSITIVE PAGE CONTENT WITHHELD");
	});

	it("an approved MUTATION does not unlock reads — its result still leaves withheld", async () => {
		seam.approval.mockResolvedValue({ approved: true });
		seam.manager.click = async () => "Clicked: PAGE-DERIVED-TEXT";
		const r = await tool().execute({ action: "click", selector: "#save", _sessionId: "s-mut", _onEvent: () => {} });
		expect(seam.approval).toHaveBeenCalledOnce();
		expect(String(r.content)).toContain("SENSITIVE PAGE CONTENT WITHHELD");
		expect(String(r.content)).not.toContain("PAGE-DERIVED-TEXT");
	});

	it("ordinary pages pass with no approval traffic at all", async () => {
		seam.manager.getCurrentUrl = () => "https://example.com/docs";
		seam.manager.readConsole = async () => "Console: quiet";
		const r = await tool().execute({ action: "read_console", _sessionId: "s-plain" });
		expect(String(r.content)).toContain("Console: quiet");
		expect(seam.approval).not.toHaveBeenCalled();
	});
});
