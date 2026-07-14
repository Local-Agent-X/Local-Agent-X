import { existsSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { execFile } from "node:child_process";

function shell(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: 120000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.toString().trim());
    });
  });
}

/**
 * Tar binaries to try, in order. On Windows the installed app can inherit a
 * PATH without System32 (field failure: both bare `tar` and a `powershell
 * -Command tar …` fallback died with CommandNotFound — PowerShell resolves
 * through the same broken PATH), and even a healthy PATH can put Git-for-
 * Windows GNU tar ahead of System32 bsdtar. So prefer the absolute
 * %SystemRoot%\System32\tar.exe (bsdtar, ships on every Win10 17063+/Win11
 * host) and only then fall back to PATH resolution.
 */
export function resolveTarBinaries(): string[] {
  const candidates: string[] = [];
  if (process.platform === "win32") {
    const sysTar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    if (existsSync(sysTar)) candidates.push(sysTar);
  }
  candidates.push("tar");
  return candidates;
}

/**
 * Extract a .tar.gz into `extractDir`, stripping the single top-level dir.
 *
 * Runs with a RELATIVE archive name (from the tarball's own dir) so no
 * Windows drive letter reaches tar's `-f` arg — GNU tar reads the colon in
 * `xzf C:\…` as a remote rsh host ("Cannot connect to C:") and aborts.
 * `-C <abs dir>` is safe (only the archive arg is rsh-parsed), and a relative
 * archive name works for GNU tar and bsdtar alike. Binaries are tried in
 * resolveTarBinaries order — absolute System32 bsdtar first on Windows, so
 * neither a mangled PATH nor GNU-tar shadowing can break OTA.
 */
export async function extractTarball(tarPath: string, extractDir: string): Promise<void> {
  const tarDir = dirname(tarPath);
  const tarName = basename(tarPath);
  const tarArgs = ["xzf", tarName, "-C", extractDir, "--strip-components=1"];
  let lastTarError: Error | undefined;
  for (const bin of resolveTarBinaries()) {
    try {
      await shell(bin, tarArgs, tarDir);
      return;
    } catch (e) {
      lastTarError = e as Error;
    }
  }
  throw new Error(
    `Update failed: could not extract ${tarName} — no working tar binary (tried: ${resolveTarBinaries().join(", ")}). Last error: ${lastTarError?.message}`
  );
}
