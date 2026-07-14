// Shared guard for tests that launch a REAL browser (not the mocked ones).
// Playwright is a dependency, but its browser binaries are not installed in
// CI or on machines that only run the non-browser suite. Tests that drive a
// live chromium must skip — not fail — when no browser executable is present.
//
// Mirrors the repo's "guard environmental tests" convention (see the OS-guard
// notes in .github/workflows/security.yml) rather than mocking, because these
// tests exist to exercise the real launch/isolation/persistence behavior.

import { existsSync } from "node:fs";
import { chromium } from "playwright";

let cached: boolean | undefined;

export function browserAvailable(): boolean {
	if (cached !== undefined) return cached;
	try {
		const path = chromium.executablePath();
		cached = Boolean(path) && existsSync(path);
	} catch {
		cached = false;
	}
	return cached;
}
