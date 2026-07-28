/**
 * `app_rebuild` — rebuild an EXISTING workspace app's static bundle.
 *
 * Before this tool the only way to refresh a finished (static-build) app after
 * a source edit was `bash npx vite build` — which the shell guard can
 * false-block, and did: a live agent ended up hand-patching built JS in dist/.
 * This is a thin ADAPTER over the one canonical runner (runStaticBuild in
 * static-build-run.ts) — no new build system, no new command derivation; the
 * command still comes from staticBuildCommand() and the 240s deadline, env
 * hardening, and dist/index.html verification are the runner's.
 *
 * Skips the build when dist/ is already newer than the sources (distIsStale —
 * the same staleness rule the offline-bundle route applies); `force: true`
 * overrides. Refuses full-stack apps (a live backend means the app is served
 * through its dev server, not a static dist/), and after a successful build
 * writes the run-target marker and stops a lingering frontend dev server so
 * the /apps/<id>/ route serves the fresh dist/ instead of proxying stale HMR.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition, ToolResult } from "../types.js";
import { workspacePath } from "../config.js";
import { detectFramework, type DetectedFramework } from "./framework-detect.js";
import { supportsStaticBuild, staticBuildDistDir, writeRunTargetManifest } from "./app-run-target.js";
import { runStaticBuild, distIsStale, type StaticBuildResult } from "./static-build-run.js";
import { readDevServerRecord, stopDevServer, type DevServerRecord } from "./dev-server.js";
import { ok, err, timeout as timeoutResult } from "./result-helpers.js";

/** Injectable seams so tests don't spawn a real `vite build` or touch ~/.lax. */
export interface AppRebuildDeps {
	appsRoot?: string;
	runBuild?: (appDir: string, framework: DetectedFramework, opts: { signal?: AbortSignal; toolName?: string; onEvent?: (e: { type: string; [k: string]: unknown }) => void }) => Promise<StaticBuildResult>;
	readRecord?: (appId: string) => DevServerRecord | null;
	stopServer?: (appId: string) => void;
}

/** List the app directory names under `appsRoot`, for the not-found hint. */
function listAppDirs(appsRoot: string): string[] {
	try {
		return readdirSync(appsRoot, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name)
			.sort();
	} catch {
		return [];
	}
}

export async function executeAppRebuild(
	args: Record<string, unknown>,
	signal?: AbortSignal,
	deps: AppRebuildDeps = {},
): Promise<ToolResult> {
	const appId = String(args.app || "").replace(/[^a-zA-Z0-9_-]/g, "-");
	if (!appId) return err("`app` is required — the app's directory name under workspace/apps/.");
	const force = args.force === true;
	// workspacePath is the ONLY correct workspace resolver (config.ts) — NOT
	// getLaxDir, which is the registry-app tree, not the agent's workspace.
	const appsRoot = deps.appsRoot ?? workspacePath("apps");
	const appDir = join(appsRoot, appId);

	if (!existsSync(appDir)) {
		const available = listAppDirs(appsRoot);
		return err(
			`App "${appId}" not found under workspace/apps/. ` +
			(available.length > 0 ? `Available apps: ${available.slice(0, 30).join(", ")}${available.length > 30 ? ", …" : ""}.` : "No apps exist yet — use build_app to create one."),
		);
	}

	// A live backend record means this is a full-stack app: its frontend is
	// served through the dev-server path and a static dist/ would strand the
	// backend (precedent: apps-bundle-prepare.ts blocks the same shape).
	const readRecord = deps.readRecord ?? readDevServerRecord;
	const record = readRecord(appId);
	if (record?.kind === "backend") {
		return err(
			`"${appId}" is a full-stack app with a registered backend dev server — it is served live, not from a static dist/, so app_rebuild does not apply. ` +
			`After editing its source, re-run app_serve_backend({ app_id: "${appId}", command, port }) to restart the backend with the new code.`,
		);
	}

	const detection = detectFramework(appDir);
	if (!supportsStaticBuild(detection.framework)) {
		if (detection.framework === "static") {
			return err(
				`"${appId}" is a plain static app (${detection.evidence}) — there is no build step; LAX already serves its files directly at /apps/${appId}/. Just edit the files.`,
			);
		}
		return err(
			`"${appId}" is not a static-buildable app (detected "${detection.framework}": ${detection.evidence}) — app_rebuild only rebuilds client-only Vite apps.`,
			{ recovery: `Use build_app({ name: "${appId}", update: true, prompt: "<what to change>" }) to update it, or app_serve_frontend to serve it through its framework dev server.` },
		);
	}

	// Freshness gate: when dist/ is already newer than every source file there
	// is nothing to do — report that honestly instead of spending 240s of vite.
	if (!force && !distIsStale(appDir, staticBuildDistDir(appDir))) {
		return ok(
			`"${appId}" is already fresh — dist/ is newer than every source file, so no rebuild was needed. Pass force: true to rebuild anyway.`,
			{ duration_ms: 0 },
		);
	}

	const runBuild = deps.runBuild ?? runStaticBuild;
	const onEvent = typeof args._onEvent === "function"
		? (args._onEvent as (e: { type: string; [k: string]: unknown }) => void)
		: undefined;
	const startedAt = Date.now();
	const built = await runBuild(appDir, detection.framework, { signal, toolName: "app_rebuild", onEvent });
	const duration_ms = Date.now() - startedAt;

	if (!built.ok || !built.distDir) {
		const reason = built.error ?? "the production build failed";
		if (built.timedOut) {
			return timeoutResult(
				`Static build of "${appId}" hit the runner's deadline and was killed — the dist/ may be stale or partially written.`,
				{ duration_ms, partial_output: reason, recovery: "Check the app for a hung build step (a watch-mode script, a prompt); fix it and call app_rebuild again." },
			);
		}
		return err(`Static build of "${appId}" failed: ${reason}`, {
			duration_ms,
			recovery: "Fix the build error in the app's source (read the output above), then call app_rebuild again.",
		});
	}

	// Marker first, then stop a lingering frontend dev server: the /apps route
	// prefers a live frontend record, so leaving one running would shadow the
	// fresh dist/ (same order as the finalize path, app-build-finalize.ts).
	writeRunTargetManifest(appDir, { mode: "static-build", distDir: built.distDir, framework: detection.framework });
	let devServerNote = "";
	if (record?.kind === "frontend") {
		const stopServer = deps.stopServer ?? ((id: string) => stopDevServer(id, {}, { forget: true }));
		stopServer(appId);
		devServerNote = " The app's frontend dev server was stopped so /apps/ serves the fresh build instead of proxying it.";
	}
	return ok(
		`Rebuilt "${appId}" — fresh static bundle at ${built.distDir}/, served at /apps/${appId}/.${devServerNote}`,
		{ duration_ms },
	);
}

export const appRebuildTool: ToolDefinition = {
	name: "app_rebuild",
	effect: { class: "idempotent-mutation" },
	description:
		"Rebuild an EXISTING workspace app's static bundle (runs the framework's production build, e.g. `npx vite build`, via the canonical build runner). " +
		"Use this after editing a finished app's source — NEVER edit files under dist/ by hand and never run the build through bash. " +
		"Skips the build when dist/ is already newer than the sources (pass force: true to override). " +
		"Only for client-only Vite apps: full-stack apps are served live by their dev server (re-run app_serve_backend instead), and for framework updates use build_app with update: true.",
	parameters: {
		type: "object",
		properties: {
			app: { type: "string", description: "The app's directory name under workspace/apps/ (e.g. 'todo-app')." },
			force: { type: "boolean", description: "Rebuild even when dist/ is newer than every source file. Default false." },
		},
		required: ["app"],
	},
	async execute(args, signal): Promise<ToolResult> {
		return executeAppRebuild(args, signal);
	},
};
