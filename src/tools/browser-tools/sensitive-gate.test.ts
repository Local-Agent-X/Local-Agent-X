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
import { setSessionProfile, clearSessionProfile } from "../../autonomy/profile-store.js";

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

// A high-risk ACTION on a sensitive page is governed by the autonomy profile,
// like every other tool — it used to prompt unconditionally, so a profile set
// to never ask still raised a card on every cloud-console click and the user
// had no way to turn it off (live 2026-09-16). Reading a credential page's
// CONTENTS is a different concern and stays on browserSecrecy's ladder.
describe("sensitive-page ACTIONS follow the user's autonomy profile", () => {
	const CONSOLE_PAGE = "https://console.cloud.google.com/apis/library";
	const BANK_PAGE = "https://www.chase.com/accounts";

	// The gate itself, not a whole browser dispatch: the question is only
	// whether a card is raised.
	async function gate(page: string, sessionId: string): Promise<boolean> {
		const { runPreDispatchGates } = await import("./gates.js");
		const manager = { getCurrentUrl: () => page } as unknown as Parameters<typeof runPreDispatchGates>[2];
		await runPreDispatchGates("click", { selector: "#go" }, manager, sessionId, () => {});
		return seam.approval.mock.calls.length > 0;
	}

	it("Power (network-write allowed) clicks an admin console with no card", async () => {
		setSessionProfile("prof-power", "Power");
		try { expect(await gate(CONSOLE_PAGE, "prof-power")).toBe(false); }
		finally { clearSessionProfile("prof-power"); }
	});

	it("Safe still asks for the same click", async () => {
		setSessionProfile("prof-safe", "Safe");
		seam.approval.mockResolvedValue({ approved: true });
		try { expect(await gate(CONSOLE_PAGE, "prof-safe")).toBe(true); }
		finally { clearSessionProfile("prof-safe"); }
	});

	it("a bank still asks under Power — money is not network-write", async () => {
		setSessionProfile("prof-bank", "Power");
		seam.approval.mockResolvedValue({ approved: true });
		try { expect(await gate(BANK_PAGE, "prof-bank")).toBe(true); }
		finally { clearSessionProfile("prof-bank"); }
	});
});

// In an unattended run (a scheduled job) the event sink exists but nobody
// answers a card. Each card-raising gate returns its refusal marked needsUser
// instead, which the dispatch pipeline parks in the user's inbox
// (tool-execution/deferred-call.ts), and the user's Approve re-runs the call
// with `_userGrant`, which stands in for the card.
describe("in an unattended run, a card becomes a needs-you refusal", () => {
	const BANK_PAGE = "https://www.chase.com/pay";
	const unattended = { _sessionId: "cron-bank", _onEvent: () => {}, _callContext: "cron" };

	it("a bank click under Power: no card, the refusal says why a person is needed, nothing dispatched", async () => {
		setSessionProfile("cron-bank", "Power");
		try {
			seam.manager.getCurrentUrl = () => BANK_PAGE;
			const click = vi.fn(async () => "Clicked: Pay");
			seam.manager.click = click;
			const r = await tool().execute({ action: "click", selector: "#pay", ...unattended });
			expect(seam.approval).not.toHaveBeenCalled();
			expect(click).not.toHaveBeenCalled();
			expect(r.status).toBe("blocked");
			expect(r.metadata).toMatchObject({ browserStatus: "approval-required", needsUser: expect.stringContaining("financial account page") });
			expect(String(r.metadata?.needsUser)).toContain("click on https://www.chase.com/pay");
		} finally { clearSessionProfile("cron-bank"); }
	});

	it("the user's grant stands in for the card: the click runs, still with no card", async () => {
		setSessionProfile("cron-bank", "Power");
		try {
			seam.manager.getCurrentUrl = () => BANK_PAGE;
			// The dispatch tail past the gate: the CAPTCHA check observes, the
			// progress guard fingerprints.
			seam.manager.observe = async () => ({ title: "Pay", currentRefs: [], crossOriginIframes: [] });
			seam.manager.fingerprint = async () => "fp-1";
			const click = vi.fn(async () => "Clicked: Pay");
			seam.manager.click = click;
			const r = await tool().execute({ action: "click", selector: "#pay", ...unattended, _userGrant: "grant-1" });
			expect(seam.approval).not.toHaveBeenCalled();
			expect(click).toHaveBeenCalledOnce();
			expect(r.metadata?.needsUser).toBeUndefined();
		} finally { clearSessionProfile("cron-bank"); }
	});

	it("a secret read on a vault page is marked, and the grant unlocks the read for that one call", async () => {
		seam.manager.readConsole = async () => "SECRET-CONSOLE-LINE";
		const parked = await tool().execute({ action: "read_console", ...unattended });
		expect(seam.approval).not.toHaveBeenCalled();
		expect(parked.metadata).toMatchObject({ browserStatus: "approval-required", needsUser: expect.stringContaining("password manager") });
		expect(String(parked.content)).not.toContain("SECRET-CONSOLE-LINE");
		const granted = await tool().execute({ action: "read_console", ...unattended, _userGrant: "grant-2" });
		expect(String(granted.content)).toContain("SECRET-CONSOLE-LINE");
		expect(seam.approval).not.toHaveBeenCalled();
	});

	it("a quarantined download's release is marked, and the grant releases it", async () => {
		seam.manager.getCurrentUrl = () => "https://example.com/files";
		const binding = { id: "d1", digest: "sha256:abc" };
		seam.manager.getDownloadApproval = () => binding;
		const release = vi.fn(async () => "released d1");
		seam.manager.releaseDownload = release;
		const parked = await tool().execute({ action: "release_download", download_id: "d1", ...unattended });
		expect(seam.approval).not.toHaveBeenCalled();
		expect(release).not.toHaveBeenCalled();
		expect(parked.metadata).toMatchObject({ browserStatus: "approval-required", needsUser: expect.stringContaining("download d1") });
		const granted = await tool().execute({ action: "release_download", download_id: "d1", ...unattended, _userGrant: "grant-3" });
		expect(release).toHaveBeenCalledWith("d1", binding);
		expect(String(granted.content)).toContain("released d1");
	});

	it("an attended run with a sink still gets the card, as before", async () => {
		seam.approval.mockResolvedValue({ approved: true });
		seam.manager.readConsole = async () => "SECRET-CONSOLE-LINE";
		const r = await tool().execute({ action: "read_console", _sessionId: "chat-1", _onEvent: () => {}, _callContext: "local" });
		expect(seam.approval).toHaveBeenCalledOnce();
		expect(r.metadata?.needsUser).toBeUndefined();
	});
});
