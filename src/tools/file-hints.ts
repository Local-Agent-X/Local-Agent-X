import { runningSessionsForPath } from "./process-tools.js";
import { readDevServerRecord, type DevServerRecord } from "./dev-server.js";

/** When write/edit touches a file under workspace/apps/<name>/, append a
 *  hint with the app's served URL. Without this, models routinely answer
 *  "Built it at workspace/apps/foo/index.html" — a workspace path the
 *  user can't click. The hint nudges the model to surface a real URL. */
export function appUrlHint(absoluteFilePath: string): string {
  const appId = appIdFromPath(absoluteFilePath);
  if (!appId) return "";
  const port = process.env.LAX_PORT ?? "7007";
  const appUrl = `http://127.0.0.1:${port}/apps/${appId}/index.html`;
  return ` — App URL: ${appUrl} (include this URL verbatim in your reply to the user so it renders as a clickable link).`;
}

/** The app id when the path is inside an installed app's directory, else null. */
export function appIdFromPath(absoluteFilePath: string): string | null {
  const m = absoluteFilePath.replace(/\\/g, "/").match(/\/workspace\/apps\/([^/]+)\//);
  return m ? m[1] : null;
}

/** True when the path is under the app's server/ directory — the one part of
 *  an app a running dev server does NOT hot-reload. */
function isAppServerFile(absoluteFilePath: string, appId: string): boolean {
  return absoluteFilePath.replace(/\\/g, "/").includes(`/workspace/apps/${appId}/server/`);
}

/** Test seams — production callers pass nothing. */
export interface ServedFileHintDeps {
  sessionsForPath?: typeof runningSessionsForPath;
  devServerRecord?: (appId: string) => DevServerRecord | null;
}

/**
 * Right-time serving guidance appended to every write/edit result.
 *
 * Two opposite failure modes, both observed live:
 *  - BACKEND edits silently don't take effect: the running server keeps the
 *    OLD code until restarted, and the model tells the user "fixed" anyway.
 *  - FRONTEND edits to an installed app ARE live immediately (Vite HMR, or
 *    LAX serving the static file directly with an auto-reloading preview) —
 *    but the old undirected "restart it" hint made the model restart the dev
 *    server and re-verify a change the user could already see working. On
 *    the installed app that restart can hang for minutes (spawn never binds).
 *
 * So the hint is DIRECTIONAL: app frontend source → "already live, you're
 * done — don't restart or re-verify"; app server/ source (or a non-app file
 * a live process serves) → "old code until restart".
 */
export function servedFileHint(
  absoluteFilePath: string,
  deps: ServedFileHintDeps = {},
): string {
  const sessionsForPath = deps.sessionsForPath ?? runningSessionsForPath;
  const devServerRecord = deps.devServerRecord ?? readDevServerRecord;

  const appId = appIdFromPath(absoluteFilePath);
  if (appId) {
    if (isAppServerFile(absoluteFilePath, appId)) {
      const record = devServerRecord(appId);
      const viaSession = restartViaSession(absoluteFilePath, sessionsForPath);
      const restart = record?.kind === "backend"
        ? `re-run app_serve_backend({ app_id: "${appId}", command, port }) — it does a clean restart`
        : viaSession && `process_restart (${viaSession})`;
      return restart
        ? ` — Note: this is BACKEND source; the running dev server keeps the OLD code until restarted (${restart}). Don't report the backend fixed without restarting it.`
        : "";
    }
    // Frontend/static app source: live without any agent action — a
    // frontend dev server hot-reloads it, and a static file is served
    // directly by LAX with an auto-reloading preview. Either way there is
    // nothing to restart, and for a small edit nothing left to verify.
    return (
      ` — This change is already live (frontend app source hot-reloads/auto-reloads; no restart needed).` +
      ` Do NOT restart the dev server or re-verify a small edit — once it's applied you're done, unless the user asked for verification or you also changed ${appId}/server/ code.`
    );
  }

  const restart = restartViaSession(absoluteFilePath, sessionsForPath);
  return restart
    ? ` — Note: a running process (${restart}) may be serving this file; it will keep serving the OLD code until you restart it (process_restart).`
    : "";
}

/** "session <id>: <command>" for the first live session plausibly serving the
 *  file, or null when none is. Shared by the app-backend and generic branches. */
function restartViaSession(
  absoluteFilePath: string,
  sessionsForPath: typeof runningSessionsForPath,
): string | null {
  const sessions = sessionsForPath(absoluteFilePath);
  if (sessions.length === 0) return null;
  const s = sessions[0];
  const cmd = s.command.length > 60 ? s.command.slice(0, 60) + "..." : s.command;
  return `session ${s.sessionId}: ${cmd}`;
}
