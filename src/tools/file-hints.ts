import { runningSessionsForPath } from "./process-tools.js";

/** When write/edit touches a file under workspace/apps/<name>/, append a
 *  hint with the app's served URL. Without this, models routinely answer
 *  "Built it at workspace/apps/foo/index.html" — a workspace path the
 *  user can't click. The hint nudges the model to surface a real URL. */
export function appUrlHint(absoluteFilePath: string): string {
  const m = absoluteFilePath.replace(/\\/g, "/").match(/\/workspace\/apps\/([^/]+)\//);
  if (!m) return "";
  const port = process.env.LAX_PORT ?? "7007";
  const appUrl = `http://127.0.0.1:${port}/apps/${m[1]}/index.html`;
  return ` — App URL: ${appUrl} (include this URL verbatim in your reply to the user so it renders as a clickable link).`;
}

/** If a live process_start session plausibly serves the just-written file, warn
 *  that it keeps serving the OLD code until restarted. Right-time guidance so an
 *  edit doesn't silently appear to "not take effect" against a stale server. */
export function servedFileHint(absoluteFilePath: string): string {
  const sessions = runningSessionsForPath(absoluteFilePath);
  if (sessions.length === 0) return "";
  const s = sessions[0];
  const cmd = s.command.length > 60 ? s.command.slice(0, 60) + "..." : s.command;
  return ` — Note: a running process (session ${s.sessionId}: ${cmd}) may be serving this file; it will keep serving the OLD code until you restart it (process_restart).`;
}
