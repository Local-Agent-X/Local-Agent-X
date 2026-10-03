// Download routing for the in-app browser: a POSITIVELY user-attributed
// webContents, or an agent view the user acted in after the agent's last
// command, routes to ~/Downloads; agent downloads, popups (unresolvable), and
// missing resolvers all fail safe into quarantine. Naming is collision-free
// and traversal-proof. Mirrors the trust split browser-loopback-policy pins.
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { isUserDownload, uniqueDownloadPath, viewTrust } from "../desktop/src/browser-download-routing";
import {
	createCoDriveState,
	humanActedLastIn,
	noteAgentAction,
	noteAgentDispatch,
	noteFocus,
	noteHumanNavigation,
	noteObservedInput,
	noteProgrammaticNavigation,
} from "../desktop/src/in-app-browser";

describe("isUserDownload — trust split", () => {
	const agentLast = () => false;
	const humanLast = () => true;

	it("routes a user view's download to Downloads, and an agent view's to quarantine", () => {
		expect(isUserDownload(7, () => "user", agentLast)).toBe(true);
		expect(isUserDownload(7, () => "agent", agentLast)).toBe(false);
	});

	// 2026-10-02: the agent opened a Twilio login, the user finished it and
	// saved the 2FA recovery code — it landed in the agent's workspace.
	it("routes an agent view's download to Downloads when the user acted after the agent", () => {
		expect(isUserDownload(7, () => "agent", humanLast)).toBe(true);
	});

	it("fails safe into quarantine for popups/unknown webContents (resolver → null), whoever acted", () => {
		expect(isUserDownload(7, () => null, humanLast)).toBe(false);
	});

	it("fails safe when there is no webContents or no resolver at all", () => {
		expect(isUserDownload(undefined, () => "user", humanLast)).toBe(false);
		expect(isUserDownload(7, null, humanLast)).toBe(false);
	});
});

describe("who acted last in a view (in-app-browser co-drive state)", () => {
	it("is nobody's on a fresh view", () => {
		expect(humanActedLastIn(createCoDriveState())).toBe(false);
	});

	it("is the human's after a real click following the agent's command, and the agent's after it acts again", () => {
		const s = createCoDriveState();
		noteAgentAction(s, 1_000);
		expect(noteObservedInput(s, 5_000, "mouseDown")).toBe(true);
		expect(humanActedLastIn(s)).toBe(true);
		noteAgentAction(s, 6_000);
		expect(humanActedLastIn(s)).toBe(false);
	});

	it("never credits the human with the agent's own input echo, or with a hover", () => {
		const s = createCoDriveState();
		noteAgentDispatch(s, 1_000);
		expect(noteObservedInput(s, 1_005, "mouseDown")).toBe(false);
		noteObservedInput(s, 5_000, "mouseMove");
		expect(humanActedLastIn(s)).toBe(false);
	});

	it("credits a focusing click, but not focus the agent's input pulled", () => {
		const s = createCoDriveState();
		noteAgentDispatch(s, 1_000);
		expect(noteFocus(s, 1_010)).toBe(false);
		expect(humanActedLastIn(s)).toBe(false);
		expect(noteFocus(s, 5_000)).toBe(true);
		expect(humanActedLastIn(s)).toBe(true);
	});

	it("counts a programmatic navigation (agent over CDP) as the agent's, but not the address bar's", () => {
		const s = createCoDriveState();
		noteObservedInput(s, 1_000, "mouseDown");
		noteProgrammaticNavigation(s, 2_000);
		expect(humanActedLastIn(s)).toBe(false);

		noteHumanNavigation(s, 3_000);
		noteProgrammaticNavigation(s, 3_050);
		expect(humanActedLastIn(s)).toBe(true);
		// The address bar's pass covers its own navigation only.
		noteProgrammaticNavigation(s, 3_100);
		expect(humanActedLastIn(s)).toBe(false);
	});
});

describe("viewTrust — adoption is load-bearing", () => {
	it("an agent-created view is agent trust, adopted or not", () => {
		expect(viewTrust(true, false)).toBe("agent");
		expect(viewTrust(true, true)).toBe("agent");
	});

	it("a user view flips to agent trust WHILE ADOPTED — the prompt-injected-agent-adopts-your-tab download bypass", () => {
		expect(viewTrust(false, false)).toBe("user");
		expect(viewTrust(false, true)).toBe("agent");
	});

	it("a non-pool webContents is unattributable → strict", () => {
		expect(viewTrust(undefined, false)).toBeNull();
		expect(viewTrust(undefined, true)).toBeNull();
	});
});

describe("uniqueDownloadPath — collision-free, traversal-proof naming", () => {
	const dir = join("/tmp", "dl");

	it("uses the filename as-is when free", () => {
		expect(uniqueDownloadPath(dir, "codes.txt", () => false)).toBe(join(dir, "codes.txt"));
	});

	it("counts up past existing files, preserving the extension", () => {
		const taken = new Set([join(dir, "codes.txt"), join(dir, "codes (1).txt")]);
		expect(uniqueDownloadPath(dir, "codes.txt", (p) => taken.has(p))).toBe(join(dir, "codes (2).txt"));
	});

	it("handles extensionless and dot-leading names", () => {
		expect(uniqueDownloadPath(dir, "README", () => false)).toBe(join(dir, "README"));
		const taken = new Set([join(dir, ".bashrc")]);
		expect(uniqueDownloadPath(dir, ".bashrc", (p) => taken.has(p))).toBe(join(dir, ".bashrc (1)"));
	});

	it("reduces a hostile Content-Disposition to a basename inside the directory", () => {
		expect(uniqueDownloadPath(dir, "../../etc/passwd", () => false)).toBe(join(dir, "passwd"));
		expect(uniqueDownloadPath(dir, "", () => false)).toBe(join(dir, "download"));
		expect(uniqueDownloadPath(dir, "   ", () => false)).toBe(join(dir, "download"));
	});

	it("clamps an oversized filename so the write cannot fail a 255-byte filesystem limit", () => {
		const monster = `${"a".repeat(300)}.pdf`;
		const got = uniqueDownloadPath(dir, monster, () => false);
		const base = got.slice(dir.length + 1);
		expect(base.length).toBeLessThanOrEqual(180);
		expect(base.endsWith(".pdf")).toBe(true);
	});

	it("de-reserves Windows device names", () => {
		expect(uniqueDownloadPath(dir, "CON.txt", () => false)).toBe(join(dir, "_CON.txt"));
		expect(uniqueDownloadPath(dir, "nul", () => false)).toBe(join(dir, "_nul"));
		expect(uniqueDownloadPath(dir, "console.log", () => false)).toBe(join(dir, "console.log"));
	});
});
