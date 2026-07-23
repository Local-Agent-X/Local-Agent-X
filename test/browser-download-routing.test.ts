// Download routing for the in-app browser: only a POSITIVELY user-attributed
// webContents routes to ~/Downloads; agent views, popups (unresolvable), and
// missing resolvers all fail safe into quarantine. Naming is collision-free
// and traversal-proof. Mirrors the trust split browser-loopback-policy pins.
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { isUserDownload, uniqueDownloadPath, viewTrust } from "../desktop/src/browser-download-routing";

describe("isUserDownload — trust split", () => {
	it("routes to Downloads only on a positive 'user' attribution", () => {
		expect(isUserDownload(7, () => "user")).toBe(true);
		expect(isUserDownload(7, () => "agent")).toBe(false);
	});

	it("fails safe into quarantine for popups/unknown webContents (resolver → null)", () => {
		expect(isUserDownload(7, () => null)).toBe(false);
	});

	it("fails safe when there is no webContents or no resolver at all", () => {
		expect(isUserDownload(undefined, () => "user")).toBe(false);
		expect(isUserDownload(7, null)).toBe(false);
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
