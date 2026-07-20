import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function electronBinRelPath(platform = process.platform) {
  if (platform === "win32") return "electron.exe";
  if (platform === "darwin") return join("Electron.app", "Contents", "MacOS", "Electron");
  return "electron";
}

export function findBundledElectronZip(repoRoot, version, { platform = process.platform, arch = process.arch, env = process.env, warn = () => {} } = {}) {
  const suffix = `-${platform}-${arch}.zip`;
  const dirs = [env.LAX_ELECTRON_BUNDLE_DIR, join(repoRoot, "vendor", "electron")].filter(Boolean);
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const exact = join(dir, `electron-v${version}${suffix}`);
    if (version && existsSync(exact)) return exact;
    try {
      const alternate = readdirSync(dir).find((file) => file.startsWith("electron-v") && file.endsWith(suffix));
      if (alternate) {
        if (version) warn(`Bundled Electron is ${alternate}, expected v${version} — using the bundled archive.`);
        return join(dir, alternate);
      }
    } catch {}
  }
  return null;
}

export function extractZipTo(zipPath, destination, processTools, platform = process.platform) {
  mkdirSync(destination, { recursive: true });
  if (platform === "win32") {
    const quote = (value) => value.replace(/'/g, "''");
    return processTools.spawnSync("powershell", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
      `Expand-Archive -Force -LiteralPath '${quote(zipPath)}' -DestinationPath '${quote(destination)}'`,
    ], { stdio: "inherit" });
  }
  if (platform === "darwin") return processTools.spawnSync("ditto", ["-x", "-k", zipPath, destination], { stdio: "inherit" });
  return processTools.spawnSync("unzip", ["-o", "-q", zipPath, "-d", destination], { stdio: "inherit" });
}

export async function ensureElectronRuntime(repoRoot, context) {
  const { reporter, processes, platform = process.platform } = context;
  const electronPackage = join(repoRoot, "desktop", "node_modules", "electron");
  const distribution = join(electronPackage, "dist");
  const binaryRelative = electronBinRelPath(platform);
  const binary = join(distribution, binaryRelative);
  if (existsSync(binary)) { reporter.ok("Electron runtime present"); return; }

  let version = "";
  try { version = JSON.parse(readFileSync(join(electronPackage, "package.json"), "utf-8")).version || ""; } catch {}
  const bundle = findBundledElectronZip(repoRoot, version, { platform, warn: reporter.warn });
  if (bundle) {
    reporter.log(`Staging bundled Electron runtime (${bundle})…`);
    const extracted = extractZipTo(bundle, distribution, processes, platform);
    if (extracted.status === 0 && existsSync(binary)) {
      try { writeFileSync(join(electronPackage, "path.txt"), `dist/${binaryRelative.split("\\").join("/")}`); } catch {}
      if (platform !== "win32") { try { chmodSync(binary, 0o755); } catch {} }
      reporter.ok("Electron runtime staged from bundle (no download)");
      return;
    }
    reporter.warn("Bundled Electron archive failed to extract — falling back to network fetch.");
  } else {
    reporter.warn("No bundled Electron runtime found — falling back to network fetch (needs internet/CDN access).");
  }
  const fetchElectron = (mirror, label) => {
    reporter.log(`Fetching Electron runtime${label}…`);
    const env = mirror ? { ...process.env, ELECTRON_MIRROR: mirror } : process.env;
    return processes.runStreaming("node", [join("node_modules", "electron", "install.js")], { cwd: "desktop", env });
  };
  let result = await fetchElectron(null, " (GitHub)");
  if (result.status !== 0 || !existsSync(binary)) {
    reporter.warn("Default Electron download failed — retrying via the npmmirror CDN…");
    result = await fetchElectron("https://npmmirror.com/mirrors/electron/", " (npmmirror)");
  }
  if (result.status !== 0 || !existsSync(binary)) {
    reporter.fail("Electron runtime is missing and could not be staged from the bundle or downloaded from GitHub/npmmirror. Re-run the installer (it ships the runtime), or allowlist the install folder if antivirus is quarantining electron.exe.");
  }
  reporter.ok("Electron runtime fetched");
}
