/**
 * Unit tests for app-run-target — the static-build marker that tells the
 * request handler to serve a finished app from its built dist/ with no dev
 * server. Pure filesystem; every case runs against a real temp dir.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	RUN_TARGET_MANIFEST_REL,
	supportsStaticBuild,
	staticBuildCommand,
	writeRunTargetManifest,
	readRunTargetManifest,
	staticBuildDistDir,
} from "./app-run-target.js";

const dirs: string[] = [];
function makeDir(): string {
	const d = mkdtempSync(join(tmpdir(), "run-target-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	while (dirs.length) { try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* best-effort */ } }
});

describe("supportsStaticBuild / staticBuildCommand", () => {
	it("Vite is static-buildable and builds WITHOUT tsc (loose-TS tolerant)", () => {
		expect(supportsStaticBuild("vite")).toBe(true);
		expect(staticBuildCommand("vite")).toBe("npx vite build");
	});
	it("SSR frameworks and static/unknown are not static-buildable", () => {
		for (const f of ["nextjs", "nuxt", "sveltekit", "astro", "remix", "static", "unknown"] as const) {
			expect(supportsStaticBuild(f)).toBe(false);
			expect(staticBuildCommand(f)).toBeNull();
		}
	});
});

describe("write / read round-trip", () => {
	it("writes the marker under .lax/ and reads it back", () => {
		const dir = makeDir();
		writeRunTargetManifest(dir, { mode: "static-build", distDir: "dist", framework: "vite" });
		expect(readRunTargetManifest(dir)).toEqual({ mode: "static-build", distDir: "dist", framework: "vite" });
		expect(RUN_TARGET_MANIFEST_REL).toBe(".lax/run-target.json");
	});

	it("absent marker → null", () => {
		expect(readRunTargetManifest(makeDir())).toBeNull();
	});

	it("malformed JSON → null (never throws)", () => {
		const dir = makeDir();
		mkdirSync(join(dir, ".lax"), { recursive: true });
		writeFileSync(join(dir, RUN_TARGET_MANIFEST_REL), "{not json");
		expect(readRunTargetManifest(dir)).toBeNull();
	});
});

describe("staticBuildDistDir", () => {
	it("returns the absolute dist dir when the marker AND the built dist/ both exist", () => {
		const dir = makeDir();
		writeRunTargetManifest(dir, { mode: "static-build", distDir: "dist", framework: "vite" });
		mkdirSync(join(dir, "dist"), { recursive: true });
		writeFileSync(join(dir, "dist", "index.html"), "<!doctype html>");
		expect(staticBuildDistDir(dir)).toBe(join(dir, "dist"));
	});

	it("marker present but dist/ missing (e.g. cleaned) → null, so the route never serves a gone directory", () => {
		const dir = makeDir();
		writeRunTargetManifest(dir, { mode: "static-build", distDir: "dist", framework: "vite" });
		expect(staticBuildDistDir(dir)).toBeNull();
	});

	it("no marker → null even if a dist/ happens to exist", () => {
		const dir = makeDir();
		mkdirSync(join(dir, "dist"), { recursive: true });
		expect(staticBuildDistDir(dir)).toBeNull();
	});
});
