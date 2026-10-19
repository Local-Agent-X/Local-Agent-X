// Installing and removing the Windows cage (win-cage.ts): the sandbox user and
// its network fence, provisioned by the one script the installer, Settings and
// the uninstaller all run (scripts/win-cage/provision.ps1), behind one
// administrator prompt each. A finished run forgets the memoized fence proof,
// so the next ask proves the cage as it now is.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
// Windows paths whatever the host, as in win-cage.ts.
import { join } from "node:path/win32";
import { _resetWinCageProbe, resolveWinCageHelper, winCageLoopbackPermit, type WinCageStatus } from "./win-cage.js";
import type { PortRange } from "../net/shell-proxy-ports.js";
import { closeShellEgressProxy } from "../net/shell-egress-proxy.js";

const INSTALL_EXIT: Record<number, string> = {
  0: "installed",
  2: "the cage's helper is not on this computer; re-run the Local Agent X installer to add it",
  3: "the cage helper's signature was rejected",
  4: "no loopback port range for the shell egress proxy",
  10: "the administrator prompt was cancelled",
  12: "the network filters could not be installed",
  13: "already installed with a different port range or user; remove it first",
  14: "the sandbox user could not be provisioned",
  15: "installed, but Windows would not reserve the shell proxy's ports for it, so a restart that hands them to another program will need a repair",
};

/** Codes after which the cage is installed and working. */
const INSTALLED = new Set([0, 15]);

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

async function runProvision(args: string[]): Promise<{ ok: boolean; code: number; detail: string }> {
  // The script reserves (or releases) the proxy's port range, which Windows
  // may refuse while a port of it is bound. The proxy starts again for the
  // next shell that needs it.
  await closeShellEgressProxy();
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
      resolve({ ok: INSTALLED.has(c), code: c, detail: c === 0 ? installExitDetail(0) : `${installExitDetail(c)}${last ? ` — ${last}` : ""}` });
    });
  });
}

/** The helper an install would use: the machine-wide one when it is there
 *  (a removed cage keeps it), else the copy the installer staged with this
 *  install. Null: only re-running the installer can bring the cage. */
export function winCageInstallSource(): string | null {
  return resolveWinCageHelper() ?? stagedWinCageHelper();
}

/** Provision the sandbox user and the fence. One administrator prompt.
 *  `repair` reruns every install step over an installed cage (the helper's
 *  --force): it rewrites a permit that names a range the proxy no longer binds
 *  (the proxy moved off a range Windows reserved), which the helper otherwise
 *  refuses (exit 13), and completes a broken install. */
export async function installWinCage(opts: { repair?: boolean } = {}): Promise<{ ok: boolean; code: number; detail: string }> {
  const helper = winCageInstallSource();
  if (!helper) return { ok: false, code: 2, detail: installExitDetail(2) };
  let permit: PortRange;
  try {
    permit = await winCageLoopbackPermit();
  } catch (e) {
    return { ok: false, code: 4, detail: `${installExitDetail(4)} — ${(e as Error).message}` };
  }
  return runProvision(["-Helper", helper, "-PortRange", `${permit.from}-${permit.to}`, ...(opts.repair ? ["-Force"] : [])]);
}

/** Remove the fence and the sandbox user. One administrator prompt. The
 *  helper stays, so Settings can install the cage again; only the app's own
 *  uninstaller deletes it (scripts/uninstall/lax-uninstall.ps1). */
export function uninstallWinCage(): Promise<{ ok: boolean; code: number; detail: string }> {
  return runProvision(["-Uninstall"]);
}

/** What Settings needs beyond the helper's status: whether an install can
 *  run at all, and an installed permit that names a range the proxy no
 *  longer binds (readable only when the helper can read the filters), which
 *  a repair fixes in one prompt. */
export async function winCageInstallView(status: WinCageStatus): Promise<{ installable: boolean; detail?: string; permitMismatch?: { installed: string; proxy: string } }> {
  const installable = status.helper !== null || stagedWinCageHelper() !== null;
  if (!status.helper) {
    return {
      installable,
      detail: installable
        ? "Not installed: bash runs unconfined on this machine until the cage is installed (one administrator prompt)."
        : "Not installed, and the cage's helper is not on this computer. Re-run the Local Agent X installer to add the Windows network cage.",
    };
  }
  if (!status.installed || !status.portRange) return { installable };
  let proxy: PortRange;
  try {
    proxy = await winCageLoopbackPermit();
  } catch {
    return { installable };
  }
  const want = `${proxy.from}-${proxy.to}`;
  return status.portRange === want ? { installable } : { installable, permitMismatch: { installed: status.portRange, proxy: want } };
}
