import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { acquireDesktopPackage } from "./desktop-package.mjs";
import { UNINSTALL_COMMAND } from "./uninstall-templates.mjs";

export async function installMacDesktop({
  reporter,
  processes,
  env = process.env,
  arch = process.arch,
  fetchImpl = globalThis.fetch,
  temporaryRoot,
}) {
  if (env.LAX_SKIP_APP) return { appInstalled: false, appBuildPath: null };
  reporter.log("Downloading the signed Local Agent X desktop app…");
  let acquired;
  try {
    acquired = await acquireDesktopPackage({ platform: "darwin", arch, fetchImpl, temporaryRoot });
  } catch (error) {
    reporter.fail(`Desktop app download failed: ${error.message}`);
  }
  try {
  const extractDirectory = join(dirname(acquired.packagePath), "extracted");
  mkdirSync(extractDirectory, { recursive: true, mode: 0o700 });
  const extract = processes.run("ditto", ["-x", "-k", acquired.packagePath, extractDirectory]);
  if (extract.status !== 0) {
    reporter.fail("The verified desktop package could not be extracted.");
  }
  const apps = readdirSync(extractDirectory, { recursive: true })
    .map((entry) => join(extractDirectory, String(entry)))
    .filter((entry) => entry.endsWith("Local Agent X.app") && statSync(entry).isDirectory());
  if (apps.length !== 1) {
    reporter.fail(`Expected exactly one Local Agent X.app in the desktop package; found ${apps.length}.`);
  }
  const appBuildPath = apps[0];
  // macOS 26 can attach com.apple.provenance to every file while expanding or
  // copying a downloaded app. codesign then treats the otherwise byte-identical
  // bundle as modified. Remove only that generated marker; keep quarantine and
  // every other Gatekeeper attribute intact, then verify the signed bundle.
  processes.run("xattr", ["-dr", "com.apple.provenance", appBuildPath], { stdio: "ignore" });
  if (processes.has("codesign")
    && processes.run("codesign", ["--verify", "--deep", "--strict", appBuildPath]).status !== 0) {
    reporter.fail("The downloaded Local Agent X.app has an invalid code signature.");
  }
  const installApp = (target) => {
    const backup = `${target}.installer-backup`;
    try {
      rmSync(backup, { recursive: true, force: true });
      if (existsSync(target)) renameSync(target, backup);
      const result = processes.run("ditto", [appBuildPath, target]);
      if (result.status !== 0) {
        rmSync(target, { recursive: true, force: true });
        if (existsSync(backup)) renameSync(backup, target);
        reporter.warn(`Could not install the packaged app to ${target}.`);
        return false;
      }
      processes.run("xattr", ["-dr", "com.apple.provenance", target], { stdio: "ignore" });
      if (processes.has("codesign")
        && processes.run("codesign", ["--verify", "--deep", "--strict", target]).status !== 0) {
        rmSync(target, { recursive: true, force: true });
        if (existsSync(backup)) renameSync(backup, target);
        reporter.warn(`The installed app signature was invalid at ${target}; the previous app was restored.`);
        return false;
      }
      rmSync(backup, { recursive: true, force: true });
      return true;
    } catch (error) {
      rmSync(target, { recursive: true, force: true });
      if (existsSync(backup)) renameSync(backup, target);
      reporter.warn(`Could not replace ${target}: ${error.message}`);
      return false;
    }
  };
  let destination = "/Applications/Local Agent X.app";
  let appInstalled = installApp(destination);
  if (appInstalled) reporter.ok("Local Agent X.app installed to /Applications");
  else {
    const userApplications = join(homedir(), "Applications");
    mkdirSync(userApplications, { recursive: true });
    destination = join(userApplications, "Local Agent X.app");
    appInstalled = installApp(destination);
    if (appInstalled) reporter.ok(`Local Agent X.app installed to ${destination}`);
    else reporter.fail("Could not install the signed app to /Applications or ~/Applications.");
  }
  if (appInstalled && !existsSync(join(process.cwd(), ".git"))) {
    try {
      const escape = (value) => value.replace(/'/g, "'\\''");
      const commandPath = join(dirname(destination), "Uninstall Local Agent X.command");
      writeFileSync(commandPath, UNINSTALL_COMMAND
        .replace(/__SOURCE_DIR__/g, escape(process.cwd()))
        .replace(/__APP_DEST__/g, escape(destination))
        .replace(/__SELF__/g, escape(commandPath)));
      chmodSync(commandPath, 0o755);
      reporter.ok(`Uninstaller added — ${dirname(destination)} → "Uninstall Local Agent X"`);
    } catch (error) { reporter.warn(`Uninstaller not added: ${error.message}`); }
  }
  return { appInstalled, appBuildPath: destination };
  } finally {
    acquired.cleanup();
  }
}
