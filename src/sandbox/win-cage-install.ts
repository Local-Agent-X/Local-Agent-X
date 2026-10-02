// Installing and removing the Windows cage (win-cage.ts): the sandbox user and
// its network fence, provisioned by the one script the installer, Settings and
// the uninstaller all run (scripts/win-cage/provision.ps1), behind one
// administrator prompt each. A finished run forgets the memoized fence proof,
// so the next ask proves the cage as it now is.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
// Windows paths whatever the host, as in win-cage.ts.
import { join } from "node:path/win32";
import { _resetWinCageProbe, resolveWinCageHelper, winCageLoopbackPermit } from "./win-cage.js";

const INSTALL_EXIT: Record<number, string> = {
  0: "installed",
  2: "the cage helper is not present",
  3: "the cage helper's signature was rejected",
  10: "the administrator prompt was cancelled",
  12: "the network filters could not be installed",
  13: "already installed with a different port range or user; remove it first",
  14: "the sandbox user could not be provisioned",
};

export function installExitDetail(code: number): string {
  return INSTALL_EXIT[code] ?? `the helper exited with code ${code}`;
}

/** The one provisioning script (scripts/win-cage/provision.ps1): the installer,
 *  Settings and the uninstaller all run it, and it elevates itself once. */
function provisionScript(projectRoot = process.cwd()): string {
  return join(projectRoot, "scripts", "win-cage", "provision.ps1");
}

/** A helper the installer staged with this install, before any is installed
 *  machine-wide: `<installRoot>/vendor/srt-win/srt-win.exe`. */
export function stagedWinCageHelper(projectRoot = process.cwd()): string | null {
  const staged = join(projectRoot, "vendor", "srt-win", "srt-win.exe");
  return existsSync(staged) ? staged : null;
}

function runProvision(args: string[]): Promise<{ ok: boolean; code: number; detail: string }> {
  return new Promise((resolve) => {
    const child = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", provisionScript(), ...args],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout?.on("data", (d) => { out += d.toString(); });
    child.stderr?.on("data", (d) => { out += d.toString(); });
    child.once("error", (e) => resolve({ ok: false, code: -1, detail: e.message }));
    child.once("exit", (code) => {
      const c = code ?? -1;
      _resetWinCageProbe();
      const last = out.trim().split("\n").slice(-1)[0]?.trim();
      resolve({ ok: c === 0, code: c, detail: c === 0 ? installExitDetail(0) : `${installExitDetail(c)}${last ? ` — ${last}` : ""}` });
    });
  });
}

/** Provision the sandbox user and the fence. One administrator prompt. The
 *  helper comes from the machine-wide folder when it is already there, else
 *  from the copy the installer staged with this install. */
export function installWinCage(): Promise<{ ok: boolean; code: number; detail: string }> {
  const { from, to } = winCageLoopbackPermit();
  const helper = resolveWinCageHelper() ?? stagedWinCageHelper();
  if (!helper) return Promise.resolve({ ok: false, code: 2, detail: installExitDetail(2) });
  return runProvision(["-Helper", helper, "-PortRange", `${from}-${to}`]);
}

/** Remove the fence, the sandbox user and the machine-wide helper. One administrator prompt. */
export function uninstallWinCage(): Promise<{ ok: boolean; code: number; detail: string }> {
  return runProvision(["-Uninstall"]);
}
