import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { UNINSTALL_COMMAND } from "./uninstall-templates.mjs";

export async function installMacDesktop({ reporter, processes, env = process.env }) {
  if (env.LAX_SKIP_APP) return { appInstalled: false, appBuildPath: null };
  const logLevel = env.LAX_NPM_LOGLEVEL || "error";
  reporter.log("Building Local Agent X.app — this is the slow step the first time (~3–5 min, ~500MB).");
  let result = await processes.runStreaming("npm", ["ci", "--no-audit", "--no-fund", `--loglevel=${logLevel}`], { cwd: "desktop" });
  if (result.status !== 0) {
    reporter.warn("desktop npm ci failed (lockfile drift?) — falling back to npm install.");
    result = await processes.runStreaming("npm", ["install", "--no-audit", "--no-fund", `--loglevel=${logLevel}`], { cwd: "desktop" });
    if (result.status !== 0) reporter.fail("desktop npm install failed.");
  }
  result = await processes.runStreaming("npm", ["run", "build"], { cwd: "desktop" });
  if (result.status !== 0) reporter.fail("desktop tsc build failed.");
  result = await processes.runStreaming("npm", ["run", "dist"], { cwd: "desktop" });
  if (result.status !== 0) reporter.fail("electron-builder failed.");

  const releaseDirectory = join(process.cwd(), "desktop", "release");
  let appBuildPath = null;
  for (const subdirectory of ["mac-arm64", "mac"]) {
    const candidate = join(releaseDirectory, subdirectory, "Local Agent X.app");
    if (existsSync(candidate)) { appBuildPath = candidate; break; }
  }
  if (!appBuildPath) reporter.fail(`Could not locate built .app under ${releaseDirectory}`);
  const copyApp = (target) => {
    if (existsSync(target)) { reporter.log(`Removing previous ${target}`); processes.run("rm", ["-rf", target]); }
    reporter.log(`Installing → ${target}`);
    return processes.run("cp", ["-R", appBuildPath, target]).status === 0;
  };
  let destination = "/Applications/Local Agent X.app";
  let appInstalled = copyApp(destination);
  if (appInstalled) reporter.ok("Local Agent X.app installed to /Applications");
  else {
    const userApplications = join(homedir(), "Applications");
    mkdirSync(userApplications, { recursive: true });
    destination = join(userApplications, "Local Agent X.app");
    appInstalled = copyApp(destination);
    if (appInstalled) reporter.ok(`Local Agent X.app installed to ${destination}`);
    else reporter.warn(`Could not copy to /Applications or ~/Applications. Built app is at:\n  ${appBuildPath}`);
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
  return { appInstalled, appBuildPath };
}
