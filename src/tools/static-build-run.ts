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
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DetectedFramework } from "./framework-detect.js";
import { staticBuildCommand } from "./app-run-target.js";
import { runCaged, type CagedRunOutcome } from "./caged-spawn.js";
import { npmCommandArgv } from "./program-argv.js";

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
	/** True when the failure was the 240s deadline expiring (ok === false).
	 *  Structured so callers (app_rebuild's 5-state envelope) can report
	 *  status "timeout" without pattern-matching the error text. */
	timedOut?: boolean;
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
	opts: { distDir?: string; signal?: AbortSignal; toolName?: string; onEvent?: (e: { type: string; [k: string]: unknown }) => void } = {},
): Promise<StaticBuildResult> {
	const command = staticBuildCommand(framework);
	if (!command) return { ok: false, error: `no static-build command for framework "${framework}"` };
	const distDir = opts.distDir ?? "dist";

	let runError: string | null = null;
	let timedOut = false;
	try {
		await runBuildCommand(command, appDir, opts);
	} catch (e) {
		runError = (e as Error).message;
		timedOut = (e as Error & { timedOut?: boolean }).timedOut === true;
	}
	if (runError) return { ok: false, error: runError, ...(timedOut ? { timedOut } : {}) };

	const index = resolve(appDir, distDir, "index.html");
	if (!existsSync(index)) {
		return { ok: false, error: `build succeeded but ${distDir}/index.html is missing — nothing to serve statically` };
	}
	return { ok: true, distDir };
}

async function runBuildCommand(
	command: string,
	cwd: string,
	opts: { signal?: AbortSignal; toolName?: string; onEvent?: (e: { type: string; [k: string]: unknown }) => void },
): Promise<void> {
	// Progress chips are labeled with the CALLING tool's name so the UI card
	// attributes output to the right call (build_app's finalize vs app_rebuild).
	const toolName = opts.toolName ?? "build_app";
	let seen = 0;
	let outcome: CagedRunOutcome;
	try {
		// The build executes the app's vite config and plugins, which the agent
		// wrote: it runs in the shell cage on the scrubbed env, never on the host
		// with the server's. A POSIX group kill takes vite down with npx.
		outcome = await runCaged(npmCommandArgv(command), {
			cwd,
			env: { NO_COLOR: "1" },
			detached: process.platform !== "win32",
			signal: opts.signal,
			timeoutMs: STATIC_BUILD_TIMEOUT_MS,
			onOutput: ({ stdout }) => {
				const last = stdout.slice(seen).split(/\r?\n/).filter((l) => l.trim()).pop();
				seen = stdout.length;
				if (last) opts.onEvent?.({ type: "tool_progress", toolName, message: `build: ${last.slice(0, 120)}` });
			},
		});
	} catch (e) {
		throw new Error(`static build failed to start (${command}): ${(e as Error).message}`);
	}
	if (outcome.kind === "abort") throw new Error(`static build was stopped: ${command}`);
	const tail = outcome.stderr.trim() ? `\n${outcome.stderr.trim().slice(-800)}` : "";
	// `timedOut` marks the deadline kill structurally (StaticBuildResult.timedOut)
	// and the stderr tail rides along so the caller can surface partial output.
	if (outcome.kind === "timeout") {
		throw Object.assign(new Error(`static build timed out after ${Math.round(STATIC_BUILD_TIMEOUT_MS / 1000)}s: ${command}${tail}`), { timedOut: true });
	}
	if (outcome.code !== 0) throw new Error(`static build exited ${outcome.code}: ${command}${tail}`);
}

// ── Staleness ────────────────────────────────────────────────────────────────
// Shared "is this dist worth keeping?" check for callers that build on demand
// (app_rebuild). Semantics mirror src/routes/apps-bundle-prepare.ts, which
// still carries a module-private copy — converge it onto this export the next
// time that file is touched (outside this module's change scope today).

// Bounded walk mirroring dev-server-proxy's source token: newest mtime under
// the app dir, skipping build output + deps so only real source edits count.
const STALENESS_SKIP = new Set(["node_modules", ".vite", "dist", "build", ".git", "target", ".lax", "_audit"]);

/** Newest source-file mtime (ms) under `appDir`, or 0 if none. Bounded so a
 *  huge tree can't stall the caller. */
function newestSourceMtime(appDir: string): number {
	let newest = 0;
	let seen = 0;
	const walk = (dir: string): void => {
		if (seen > 4000) return;
		let entries: string[];
		try { entries = readdirSync(dir); } catch { return; }
		for (const name of entries) {
			if (seen > 4000) return;
			if (name.startsWith(".") || STALENESS_SKIP.has(name)) continue;
			const full = join(dir, name);
			let st;
			try { st = statSync(full); } catch { continue; }
			if (st.isDirectory()) { walk(full); continue; }
			seen += 1;
			if (st.mtimeMs > newest) newest = st.mtimeMs;
		}
	};
	walk(appDir);
	return newest;
}

/** A static build is stale when there's no dist yet, or the app's source has
 *  been edited since the dist was produced — so a rebuild-on-demand caller
 *  rebuilds exactly when the built pages no longer match the source. */
export function distIsStale(appDir: string, distDir: string | null): boolean {
	if (!distDir) return true;
	const index = resolve(distDir, "index.html");
	let builtAt = 0;
	try { builtAt = statSync(index).mtimeMs; } catch { return true; }
	return newestSourceMtime(appDir) > builtAt;
}
