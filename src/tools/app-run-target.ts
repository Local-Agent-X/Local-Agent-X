/**
 * Run-target marker for a finished app — the one source of truth for "how does
 * LAX serve this app's /apps/<id>/ URL?". Two shapes:
 *
 *   - dev-server  → a live framework dev server LAX reverse-proxies (the record
 *     lives in dev-server.ts; no marker written — that's the historical default).
 *   - static-build → the app was built to a static `dist/`; LAX serves those
 *     files directly, with NO dev server behind it. That's what this marker
 *     records, so the request handler knows to rebase /apps/<id>/… under dist/.
 *
 * Kept in src/tools/ (not canonical-loop/ or server/) as a neutral shared spot:
 * the finalize path (canonical-loop) WRITES it, the request handler and smoke
 * resolver (server / canonical-loop) READ it, and neither side has to import the
 * other. Pure filesystem — no exec, never throws.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { DetectedFramework } from "./framework-detect.js";

/** App-relative path of the run-target marker (sits beside .lax/scaffold.json). */
export const RUN_TARGET_MANIFEST_REL = ".lax/run-target.json";

export interface RunTargetManifest {
	mode: "static-build";
	/** App-relative directory holding the built static output (Vite → "dist"). */
	distDir: string;
	framework: DetectedFramework;
}

/** Frameworks whose finished build is a client-only static bundle LAX can serve
 *  with no dev server. Vite (LAX's harness-owned SPA stack) only, for now —
 *  metaframeworks default to SSR and can't honestly go static without explicit
 *  export config, so they keep the dev-server path. Extend by adding a row here
 *  plus a staticBuildCommand entry. */
export function supportsStaticBuild(framework: DetectedFramework): boolean {
	return framework === "vite";
}

/** The production-build command for a static-buildable framework, or null.
 *  Vite runs `npx vite build` (NOT the template's `npm run build`, which
 *  prepends `tsc -b`): esbuild strips types without type-checking, so the
 *  static build tolerates the same loose TS the dev server does — switching a
 *  rendering-fine app to static never regresses it on a stray type error. */
export function staticBuildCommand(framework: DetectedFramework): string | null {
	if (framework === "vite") return "npx vite build";
	return null;
}

/** Write the static-build marker for an app. Creates .lax/ if absent. */
export function writeRunTargetManifest(appDir: string, manifest: RunTargetManifest): void {
	const p = resolve(appDir, RUN_TARGET_MANIFEST_REL);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, JSON.stringify(manifest, null, 2), "utf-8");
}

/** Read an app's run-target marker, or null when absent/unparseable. */
export function readRunTargetManifest(appDir: string): RunTargetManifest | null {
	try {
		const raw = readFileSync(resolve(appDir, RUN_TARGET_MANIFEST_REL), "utf-8");
		const m = JSON.parse(raw) as RunTargetManifest;
		if (m && m.mode === "static-build" && typeof m.distDir === "string") return m;
	} catch { /* absent or bad JSON → not a static-build app */ }
	return null;
}

/** Absolute path of an app's built static-serve directory, or null when the app
 *  is not a finished static-build (no marker) or its dist/ is missing. The dist/
 *  check guards against a marker that outlived a `rm -rf dist` — a stale marker
 *  alone must not make the route serve a directory that isn't there. */
export function staticBuildDistDir(appDir: string): string | null {
	const m = readRunTargetManifest(appDir);
	if (!m) return null;
	const dist = resolve(appDir, m.distDir);
	return existsSync(dist) ? dist : null;
}
