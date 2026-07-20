import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureElectronRuntime } from "./archive-tools.mjs";
import { UNINSTALL_PS1 } from "./uninstall-templates.mjs";

export async function installWindowsDesktop(context) {
  const { reporter, processes, env = process.env } = context;
  if (env.LAX_SKIP_APP) return { appInstalled: false, appBuildPath: null };
  const logLevel = env.LAX_NPM_LOGLEVEL || "error";
  reporter.log("Building Electron desktop bundle…");
  const desktopEnvironment = { ...env, ELECTRON_SKIP_BINARY_DOWNLOAD: "1" };
  let result = await processes.runStreaming("npm", ["ci", "--no-audit", "--no-fund", `--loglevel=${logLevel}`], { cwd: "desktop", env: desktopEnvironment });
  if (result.status !== 0) {
    reporter.warn("desktop npm ci failed (lockfile drift?) — falling back to npm install.");
    result = await processes.runStreaming("npm", ["install", "--no-audit", "--no-fund", `--loglevel=${logLevel}`], { cwd: "desktop", env: desktopEnvironment });
    if (result.status !== 0) reporter.fail("desktop npm install failed.");
  }
  result = await processes.runStreaming("npm", ["run", "build"], { cwd: "desktop" });
  if (result.status !== 0) reporter.fail("desktop tsc build failed.");
  reporter.ok("Desktop bundle built");
  await ensureElectronRuntime(process.cwd(), context);

  const repoRoot = process.cwd();
  const electron = join(repoRoot, "desktop", "node_modules", "electron", "dist", "electron.exe");
  const entry = join(repoRoot, "desktop", "dist", "loader.js");
  const workDirectory = join(repoRoot, "desktop");
  const icon = join(repoRoot, "public", "icon.ico");
  if (!existsSync(electron) || !existsSync(entry)) reporter.fail(`Desktop launch artifacts missing — need both ${electron} and ${entry}, but the desktop build did not produce a runnable bundle.`);
  const quote = (value) => value.replace(/'/g, "''");
  const shortcutScript = [
    `$electron = '${quote(electron)}'`, `$entryJs  = '${quote(entry)}'`, `$workDir  = '${quote(workDirectory)}'`,
    `$iconPath = '${existsSync(icon) ? quote(icon) : ""}'`, `$desktop  = [Environment]::GetFolderPath('Desktop')`,
    `$startMenu = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'`,
    `if (-not (Test-Path $startMenu)) { New-Item -ItemType Directory -Force -Path $startMenu | Out-Null }`,
    `foreach ($dir in @($desktop, $startMenu)) {`,
    `  if (-not (Test-Path $dir)) { Write-Output "[skip] $dir (not present)"; continue }`,
    `  $lnk = Join-Path $dir 'Local Agent X.lnk'`,
    `  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)`, `  $s.TargetPath = $electron`,
    `  $s.Arguments = '"' + $entryJs + '"'`, `  $s.WorkingDirectory = $workDir`,
    `  if ($iconPath) { $s.IconLocation = $iconPath }`, `  $s.Description = 'Local Agent X'`, `  $s.Save()`,
    `  Write-Output "[ok]   $lnk"`, `}`,
  ].join("; ");
  const shortcut = processes.spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", shortcutScript], { stdio: "inherit" });
  if (shortcut.status !== 0) reporter.fail(`Shortcut creation failed (PowerShell exit ${shortcut.status}). Without it there's no Desktop or Start Menu entry to launch the app from.`);
  reporter.ok("Shortcuts created (Desktop + Start Menu, resolved via Known Folders API)");
  if (!existsSync(join(repoRoot, ".git"))) registerUninstaller(context, { repoRoot, electron, icon });
  return { appInstalled: true, appBuildPath: null };
}

function registerUninstaller({ reporter, processes }, { repoRoot, electron, icon }) {
  try {
    let version = "0.0.0";
    try { version = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")).version || version; } catch {}
    const scriptPath = join(repoRoot, "uninstall.ps1");
    writeFileSync(scriptPath, UNINSTALL_PS1.replace(/__INSTALL_DIR__/g, repoRoot.replace(/'/g, "''")));
    const displayIcon = existsSync(icon) ? icon : electron;
    const uninstallCommand = `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`;
    const quote = (value) => String(value).replace(/'/g, "''");
    const registryScript = [
      `$k='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LocalAgentX'`,
      `New-Item -Path $k -Force | Out-Null`, `Set-ItemProperty $k DisplayName 'Local Agent X'`,
      `Set-ItemProperty $k DisplayIcon '${quote(displayIcon)}'`, `Set-ItemProperty $k DisplayVersion '${quote(version)}'`,
      `Set-ItemProperty $k Publisher 'Local Agent X'`, `Set-ItemProperty $k InstallLocation '${quote(repoRoot)}'`,
      `Set-ItemProperty $k UninstallString '${quote(uninstallCommand)}'`, `Set-ItemProperty $k NoModify 1 -Type DWord`,
      `Set-ItemProperty $k NoRepair 1 -Type DWord`,
    ].join("; ");
    const result = processes.spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", registryScript], { stdio: reporter.ipcMode ? ["ignore", "pipe", "pipe"] : "inherit" });
    if (result.status === 0) reporter.ok("Registered uninstaller — Settings → Installed apps → Local Agent X");
    else reporter.warn(`Uninstaller registration failed (exit ${result.status}); manual folder removal still works`);
  } catch (error) { reporter.warn(`Uninstaller registration skipped: ${error.message}`); }
}
