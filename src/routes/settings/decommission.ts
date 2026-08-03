// Decommission (uninstall) API for the Settings → HQ page.
//
// The ONLY uninstall implementation is scripts/uninstall/lax-uninstall.{ps1,sh}
// (see scripts/uninstall/README.md — the Windows Settings entry, the macOS
// .command shim, the NSIS hook and `npm run uninstall` all run the same
// scripts). This route is one more caller of that single implementation:
// it never removes anything itself, it only launches the script.
//
// The staged copy at ~/.lax/uninstall/ is preferred because it survives
// rolling updates; the checkout copy is the fallback for dev installs.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, readBody, safeErrorMessage } from "../../server-utils.js";
import { getLaxDir } from "../../lax-data-dir.js";

/** The phrase the UI must send back before the destructive launch happens. */
export const DECOMMISSION_CONFIRM_PHRASE = "DECOMMISSION";

export interface UninstallLaunch {
  command: string;
  args: string[];
}

export function resolveUninstallScript(
  platform: NodeJS.Platform,
  laxDir: string,
  repoRoot: string,
): string | null {
  const name = platform === "win32" ? "lax-uninstall.ps1" : "lax-uninstall.sh";
  const staged = join(laxDir, "uninstall", name);
  if (existsSync(staged)) return staged;
  const checkout = join(repoRoot, "scripts", "uninstall", name);
  if (existsSync(checkout)) return checkout;
  return null;
}

export function buildUninstallLaunch(
  platform: NodeJS.Platform,
  script: string,
  options: { dryRun?: boolean; deleteData?: boolean },
): UninstallLaunch {
  if (platform === "win32") {
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script];
    if (options.dryRun) args.push("-DryRun");
    else args.push("-Yes");
    if (options.deleteData) args.push("-DeleteData");
    return { command: "powershell", args };
  }
  const args = [script];
  if (options.dryRun) args.push("--dry-run");
  else args.push("--yes");
  if (options.deleteData) args.push("--delete-data");
  return { command: "bash", args };
}

export const handleDecommissionRoutes: RouteHandler = async (method, url, req, res, _ctx, role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  // Dry-run preview: runs the script with its preview flag, which prints the
  // removal plan and changes nothing, then returns the report verbatim.
  if (method === "GET" && url.pathname === "/api/decommission/plan") {
    if (role !== "operator") { json(403, { error: "Operator access required" }); return true; }
    const script = resolveUninstallScript(process.platform, getLaxDir(), process.cwd());
    if (!script) { json(404, { error: "Uninstall script not found (neither staged in ~/.lax/uninstall nor in the checkout)." }); return true; }
    try {
      const { execFile } = await import("node:child_process");
      const { command, args } = buildUninstallLaunch(process.platform, script, { dryRun: true });
      const report = await new Promise<string>((resolve, reject) => {
        execFile(command, args, { timeout: 30_000, windowsHide: true }, (error, stdout, stderr) => {
          if (error) reject(new Error(stderr.trim() || error.message));
          else resolve(stdout.trim());
        });
      });
      json(200, { script, report });
    } catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }

  // The real thing. Spawns the uninstaller detached and returns immediately —
  // the script stops the app processes itself (it re-execs from TEMP first so
  // deleting the install tree can never kill it mid-removal).
  if (method === "POST" && url.pathname === "/api/decommission/run") {
    if (role !== "operator") { json(403, { error: "Operator access required" }); return true; }
    try {
      const body = JSON.parse((await readBody(req)) || "{}") as { deleteData?: boolean; confirm?: string };
      if (body.confirm !== DECOMMISSION_CONFIRM_PHRASE) {
        json(400, { error: `Confirmation phrase missing — send confirm: "${DECOMMISSION_CONFIRM_PHRASE}".` });
        return true;
      }
      const script = resolveUninstallScript(process.platform, getLaxDir(), process.cwd());
      if (!script) { json(404, { error: "Uninstall script not found (neither staged in ~/.lax/uninstall nor in the checkout)." }); return true; }
      const { spawn } = await import("node:child_process");
      const { command, args } = buildUninstallLaunch(process.platform, script, { deleteData: body.deleteData === true });
      const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
      child.unref();
      json(200, { ok: true, script, deleteData: body.deleteData === true });
    } catch (e) { json(500, { ok: false, error: safeErrorMessage(e) }); }
    return true;
  }

  return false;
};
