/**
 * Dev-server command hygiene — shared by the lazy-restart path (dev-server.ts)
 * and the app_serve_frontend tool (dev-server-tools.ts). Split into its own tiny
 * module so both can share one definition without dev-server.ts crossing the
 * 400-LOC source-hygiene cap.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

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
