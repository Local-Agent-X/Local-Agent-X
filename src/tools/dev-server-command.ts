/**
 * Dev-server spawn hygiene (command + child env) — shared by the lazy-restart
 * path (dev-server.ts) and the app_serve_* tools (dev-server-tools.ts). Split
 * into its own tiny module so both can share one definition without
 * dev-server.ts crossing the 400-LOC source-hygiene cap.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { withNodeTitleGuard } from "./env-contamination.js";
import { deriveConnectorCapability } from "../server/app-connector-auth.js";
import { getRuntimeConfig } from "../config.js";
import type { DevServerKind } from "./dev-server.js";

// A leading `npm install && …` (or ci / i / yarn / pnpm equivalent) in a dev
// command. Harness-scaffolded apps already have node_modules (the scaffold ran
// install directly), so re-running install on every serve — and on every lazy
// restart — is pure overhead that, under the guarded sandbox, can wedge or crash
// the dev server before it ever binds.
const LEADING_INSTALL_RE = /^\s*(?:npm|pnpm|yarn)\s+(?:install|ci|i)\b[^&|]*&&\s*/i;

/** Drop a redundant leading install step when the deps are already present, so
 *  the dev server just runs its bind step (npx vite / npm run dev). No-op when
 *  node_modules is absent (a real install is still needed) or the command has no
 *  install prefix. */
export function stripRedundantInstall(command: string, appDir: string): string {
	if (!existsSync(join(appDir, "node_modules"))) return command;
	return command.replace(LEADING_INSTALL_RE, "");
}

/**
 * Env a dev-server child needs. A frontend gets:
 *   - LAX_DEV_PORT — the harness-owned vite.config points HMR at the actual dev
 *     port (the /apps proxy can't carry the HMR websocket);
 *   - LAX_SERVER_PORT + LAX_CONNECTOR_TOKEN — the same config's dev proxy
 *     forwards /api/connectors/* to LAX stamped with the SCOPED connector
 *     capability (connectors-only, already embedded in every served app page —
 *     never the operator token), so a page opened on the DEV origin (in-app
 *     browser, a pasted vite URL) still reaches its connectors instead of a
 *     vite 404 with no token.
 * BOTH kinds get the macOS process.title crash guard (withNodeTitleGuard): a
 * node dev server spawned under the desktop's app-bundle responsibility context
 * SIGSEGVs the instant it sets process.title. Returns undefined only when
 * there's nothing to add.
 */
export function frontendEnv(kind: DevServerKind, port: number): Record<string, string> | undefined {
	const base: Record<string, string> = {};
	if (kind === "frontend") {
		base.LAX_DEV_PORT = String(port);
		// Config load is a boundary that can fail in stripped-down spawns (tests,
		// early boot); a dev server must still start — it just loses the
		// direct-origin connector proxy, never the serve itself.
		try {
			const cfg = getRuntimeConfig();
			base.LAX_SERVER_PORT = String(cfg.port || Number(process.env.LAX_PORT) || 7007);
			if (cfg.authToken) base.LAX_CONNECTOR_TOKEN = deriveConnectorCapability(cfg.authToken);
		} catch { /* serve without the proxy env */ }
	}
	const env = withNodeTitleGuard(base) as Record<string, string>;
	return Object.keys(env).length ? env : undefined;
}
