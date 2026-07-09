/**
 * Offline-bundle preparation — the async step in front of the pure buildAppBundle
 * (apps-bundle.ts). A phone downloads an app to run it with the desktop
 * unreachable, but a React/Vite app is SOURCE that only runs under a dev server
 * the phone can't host. So before bundling we make sure a client-only SPA has a
 * FRESH static `dist/`, building it on demand:
 *
 *   - full-stack (a live backend) → blocked: can't run offline, honest message.
 *   - client-only SPA (Vite) → build to dist/ if missing OR stale (source newer
 *     than the last build), then bundle the dist/. Downloading = exporting static.
 *   - server-rendered framework (Next/Nuxt SSR, no static output) → blocked.
 *   - plain static HTML / registered app → already offline-capable, bundle as-is.
 *
 * The on-demand build is what makes "download a React app" work offline, and the
 * staleness check is what makes an UPDATED app download its new pages next time.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { detectFramework } from "../tools/framework-detect.js";
import { supportsStaticBuild, staticBuildDistDir, writeRunTargetManifest } from "../tools/app-run-target.js";
import { readDevServerRecord } from "../tools/dev-server.js";
import { buildAppBundle, type AppBundlePayload } from "./apps-bundle.js";
import type { AppRegistry } from "../app-runtime/index.js";

export type OfflineBundleResult =
  | { status: "ok"; bundle: AppBundlePayload }
  | { status: "not_found" }
  | { status: "blocked"; reason: string };

// Bounded walk mirroring dev-server-proxy's source token: newest mtime under the
// app dir, skipping build output + deps so only real source edits count.
const SKIP = new Set(["node_modules", ".vite", "dist", "build", ".git", "target", ".lax", "_audit"]);

/** Newest source-file mtime (ms) under `appDir`, or 0 if none. Bounded so a huge
 *  tree can't stall the download. */
function newestSourceMtime(appDir: string): number {
	let newest = 0;
	let seen = 0;
	const walk = (dir: string): void => {
		if (seen > 4000) return;
		let entries: string[];
		try { entries = readdirSync(dir); } catch { return; }
		for (const name of entries) {
			if (seen > 4000) return;
			if (name.startsWith(".") || SKIP.has(name)) continue;
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

/** A static build is stale when there's no dist yet, or the app's source has been
 *  edited since the dist was produced (an app UPDATE) — so the next download
 *  rebuilds and the phone gets the new pages. */
function distIsStale(appDir: string, distDir: string | null): boolean {
	if (!distDir) return true;
	const index = resolve(distDir, "index.html");
	let builtAt = 0;
	try { builtAt = statSync(index).mtimeMs; } catch { return true; }
	return newestSourceMtime(appDir) > builtAt;
}

/**
 * Resolve the offline bundle for `appId`, building a client-only SPA to static
 * `dist/` on demand (and rebuilding it when the app has been updated). Injectable
 * `runBuild` seam so tests don't spawn a real `vite build`.
 */
export async function prepareOfflineBundle(
	appReg: AppRegistry,
	workspaceDir: string,
	appId: string,
	port: number,
	runBuild?: (appDir: string, framework: ReturnType<typeof detectFramework>["framework"]) => Promise<{ ok: boolean; distDir?: string; error?: string }>,
): Promise<OfflineBundleResult> {
	const appDir = resolve(workspaceDir, "apps", appId);

	// Full-stack: a registered backend means the app talks to a live server the
	// phone can't carry offline.
	if (readDevServerRecord(appId)?.kind === "backend") {
		return { status: "blocked", reason: "This app needs the desktop running (it has a live backend), so it can't run offline yet. Open it while your computer is reachable." };
	}

	const detection = detectFramework(appDir);

	// Client-only SPA → ensure a fresh static dist/, building on demand.
	if (supportsStaticBuild(detection.framework)) {
		if (distIsStale(appDir, staticBuildDistDir(appDir))) {
			const build = runBuild ?? (async (dir, fw) => {
				const { runStaticBuild } = await import("../tools/static-build-run.js");
				return runStaticBuild(dir, fw);
			});
			const built = await build(appDir, detection.framework);
			if (!built.ok || !built.distDir) {
				return { status: "blocked", reason: `Couldn't build this app for offline use: ${built.error ?? "the production build failed"}. Fix the build, then download again.` };
			}
			writeRunTargetManifest(appDir, { mode: "static-build", distDir: built.distDir, framework: detection.framework });
		}
		const bundle = buildAppBundle(appReg, workspaceDir, appId, port);
		return bundle ? { status: "ok", bundle } : { status: "not_found" };
	}

	// A server-rendered framework (Next/Nuxt/…) with no static output can't run
	// without its server.
	if (detection.framework !== "static" && detection.framework !== "unknown") {
		return { status: "blocked", reason: "This app uses a server-rendered framework, so it needs the desktop running and can't run fully offline yet." };
	}

	// Plain static HTML app or a registered app — already offline-capable.
	const bundle = buildAppBundle(appReg, workspaceDir, appId, port);
	return bundle ? { status: "ok", bundle } : { status: "not_found" };
}
