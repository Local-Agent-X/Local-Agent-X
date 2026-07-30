import { acquireDesktopPackage } from "./desktop-package.mjs";
import { findWindowsDesktop, windowsDesktopCandidates } from "./windows-desktop-location.mjs";

export async function installWindowsDesktop(context) {
  const { reporter, processes, env = process.env } = context;
  if (env.LAX_SKIP_APP) return { appInstalled: false, appBuildPath: null };
  reporter.log("Downloading the signed Local Agent X desktop app…");
  let acquired;
  try {
    acquired = await acquireDesktopPackage({
      platform: "win32",
      arch: context.arch || process.arch,
      fetchImpl: context.fetchImpl || globalThis.fetch,
      temporaryRoot: context.temporaryRoot,
    });
  } catch (error) {
    reporter.fail(`Desktop app download failed: ${error.message}`);
  }
  try {
    const quote = (value) => String(value).replace(/'/g, "''");
    // The release workflow pins the expected certificate subject while signing.
    // The migration installer independently fails closed unless Windows reports
    // that the downloaded executable's Authenticode chain is Valid.
    const signatureScript = `$s=Get-AuthenticodeSignature -LiteralPath '${quote(acquired.packagePath)}'; if ($s.Status -ne 'Valid') { Write-Error ('Invalid Authenticode signature: ' + $s.Status); exit 2 }`;
    const signature = processes.spawnSync("powershell", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", signatureScript,
    ], { stdio: "inherit" });
    if (signature.status !== 0) {
      reporter.fail("The downloaded Windows installer does not have a valid Authenticode signature.");
    }
    const install = await processes.runStreaming(`"${acquired.packagePath}"`, ["/S"]);
    if (install.status !== 0) reporter.fail(`The signed desktop installer failed (exit ${install.status}).`);
  } finally {
    acquired.cleanup();
  }
  const locationOptions = { env, homeDirectory: context.homeDirectory };
  const appPath = findWindowsDesktop(locationOptions);
  if (!appPath) {
    reporter.fail(
      `The desktop installer completed but LocalAgentX.exe is missing from: ${
        windowsDesktopCandidates(locationOptions).join(" or ")
      }. Check Windows Security → Protection history in case antivirus quarantined it.`,
    );
  }
  reporter.ok("Signed Local Agent X desktop app installed");
  return { appInstalled: true, appBuildPath: appPath };
}
