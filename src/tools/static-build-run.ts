/**
 * Executes a finished app's PRODUCTION build so LAX can serve its static `dist/`
 * with no dev server behind it (see app-run-target.ts). The RUN side, kept in
 * src/tools/ (never src/canonical-loop/) so the finalize adapter reaches it by a
 * function-call/dynamic-import boundary and the canonical-loop subprocess audit
 * stays clean — the same arrangement framework-scaffold-run.ts and
 * build-app-spawn.ts use for their subprocesses.
 *
 * Framework-agnostic: the build COMMAND comes from staticBuildCommand(); this
 * module only spawns it, waits, and reports whether the expected dist/ landed.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { killProcessTree } from "../process-tree-kill.js";
import type { DetectedFramework } from "./framework-detect.js";
import { staticBuildCommand } from "./app-run-target.js";
import { hardenChildEnv } from "./env-contamination.js";

// A production bundle (esbuild/rollup over the whole tree) is quick relative to
// a cold install, but a large app on a slow box can still take a minute; 4 min
// is loose enough to finish yet still terminates a genuine hang.
const STATIC_BUILD_TIMEOUT_MS = 240_000;

export interface StaticBuildResult {
	ok: boolean;
	/** App-relative dist dir when the build produced it (ok === true). */
	distDir?: string;
	/** Human-readable failure reason when ok === false. */
	error?: string;
}

/**
 * Run the framework's production build in `appDir` and confirm `distDir/` (with
 * an index.html) actually landed. Never throws — a failed spawn, a non-zero
 * exit, or a missing dist all resolve to `{ ok: false, error }` so the caller
 * decides how to degrade (finalize keeps the dev server on failure).
 */
export async function runStaticBuild(
	appDir: string,
	framework: DetectedFramework,
	opts: { distDir?: string; signal?: AbortSignal; onEvent?: (e: { type: string; [k: string]: unknown }) => void } = {},
): Promise<StaticBuildResult> {
	const command = staticBuildCommand(framework);
	if (!command) return { ok: false, error: `no static-build command for framework "${framework}"` };
	const distDir = opts.distDir ?? "dist";

	let runError: string | null = null;
	try {
		await runBuildCommand(command, appDir, opts);
	} catch (e) {
		runError = (e as Error).message;
	}
	if (runError) return { ok: false, error: runError };

	const index = resolve(appDir, distDir, "index.html");
	if (!existsSync(index)) {
		return { ok: false, error: `build succeeded but ${distDir}/index.html is missing — nothing to serve statically` };
	}
	return { ok: true, distDir };
}

function runBuildCommand(
	command: string,
	cwd: string,
	opts: { signal?: AbortSignal; onEvent?: (e: { type: string; [k: string]: unknown }) => void },
): Promise<void> {
	return new Promise<void>((resolveP, rejectP) => {
		const proc = spawn(command, {
			cwd,
			shell: true,
			// hardenChildEnv: strip __CFBundleIdentifier + inject the process.title
			// crash guard so `vite build` can't SIGSEGV under the macOS app-bundle
			// context (env scrub alone is insufficient — see env-contamination.ts).
			env: { ...hardenChildEnv(process.env), NO_COLOR: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let errOut = "";
		proc.stdout?.on("data", (d: Buffer) => {
			const last = d.toString().split(/\r?\n/).filter((l) => l.trim()).pop();
			if (last) opts.onEvent?.({ type: "tool_progress", toolName: "build_app", message: `build: ${last.slice(0, 120)}` });
		});
		proc.stderr?.on("data", (d: Buffer) => { errOut += d.toString(); });

		const abortListener = (): void => { killProcessTree(proc); };
		if (opts.signal) {
			if (opts.signal.aborted) abortListener();
			else opts.signal.addEventListener("abort", abortListener);
		}
		const timer = setTimeout(() => {
			killProcessTree(proc);
			rejectP(new Error(`static build timed out after ${Math.round(STATIC_BUILD_TIMEOUT_MS / 1000)}s: ${command}`));
		}, STATIC_BUILD_TIMEOUT_MS);

		proc.on("error", (e) => {
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", abortListener);
			rejectP(new Error(`static build failed to start (${command}): ${e.message}`));
		});
		proc.on("close", (code) => {
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", abortListener);
			if (code === 0) resolveP();
			else rejectP(new Error(`static build exited ${code}: ${command}${errOut.trim() ? `\n${errOut.trim().slice(-800)}` : ""}`));
		});
	});
}
