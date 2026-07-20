import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { EMBED_MODEL, NODE_MAJOR_MIN } from "./contract.mjs";
import { resolvePosixShell } from "./windows-tools.mjs";

const present = (value) => value ? "present" : "absent";

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return null; }
}

function verifyNode() {
  return present(Number(process.versions.node.split(".")[0]) >= NODE_MAJOR_MIN);
}

function verifyPython({ processes, platform }) {
  const command = platform === "win32" ? "python" : "python3";
  return present(processes.spawnSync(command, ["--version"], { stdio: "ignore", shell: true }).status === 0);
}

function verifyNpm(context, evidence) {
  if (!existsSync(join(process.cwd(), "node_modules"))) return "absent";
  if (!existsSync(join(process.cwd(), "node_modules", ".package-lock.json"))) return "absent";
  if (!evidence?.inFlight) return "present";
  const result = context.processes.spawnSync("npm", ["ls", "--depth=0"], { stdio: "ignore" });
  return result.status === 0 ? "present" : "absent";
}

function verifyConfig(context) {
  const home = context.homeDirectory || homedir();
  const config = readJson(join(home, ".lax", "config.json"));
  if (!config) return "absent";
  return config.projectRoot === process.cwd() && typeof config.authToken === "string" && config.authToken.length > 0
    ? "present" : "ambiguous";
}

function verifyDesktop(context) {
  const { env = process.env, platform, processes } = context;
  if (env.LAX_SKIP_APP || platform === "linux") return "present";
  if (platform === "darwin") {
    return present(existsSync("/Applications/Local Agent X.app")
      || existsSync(join(context.homeDirectory || homedir(), "Applications", "Local Agent X.app")));
  }
  const electron = join(process.cwd(), "desktop", "node_modules", "electron", "dist", "electron.exe");
  const entry = join(process.cwd(), "desktop", "dist", "loader.js");
  if (!existsSync(electron) || !existsSync(entry)) return "absent";
  const script = "$d=[Environment]::GetFolderPath('Desktop'); $s=Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'; $dirs=@($d,$s)|Where-Object { Test-Path $_ }; if ($dirs.Count -gt 0 -and @($dirs|Where-Object { -not (Test-Path (Join-Path $_ 'Local Agent X.lnk')) }).Count -eq 0) { exit 0 }; exit 2";
  const result = processes.spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore" });
  return result.status === 0 ? "present" : result.status === 2 ? "absent" : "ambiguous";
}

export function verifyInstallStep(id, context, evidence = {}) {
  const { processes, platform = process.platform, selections = {} } = context;
  if (id === "node") return verifyNode();
  if (id === "vsbuildtools") {
    const vswhere = `${process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)"}\\Microsoft Visual Studio\\Installer\\vswhere.exe`;
    if (!existsSync(vswhere)) return "absent";
    return present(processes.spawnSync(vswhere, ["-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64"], { stdio: "ignore" }).status === 0);
  }
  if (id === "xcode-clt") return present(processes.spawnSync("xcode-select", ["-p"], { stdio: "ignore" }).status === 0);
  if (id === "python") return verifyPython({ processes, platform });
  if (id === "ollama") return selections.ollamaRuntime ? present(processes.has("ollama")) : "present";
  if (id === "npm") return verifyNpm(context, evidence);
  if (id === "embedmodel") {
    if (!selections.ollamaMemoryModel) return "present";
    if (!processes.has("ollama")) return "absent";
    const result = processes.spawnSync("ollama", ["list"], { encoding: "utf-8" });
    return result.status === 0 ? present(String(result.stdout || "").includes(EMBED_MODEL)) : "ambiguous";
  }
  if (id === "settings") return present(existsSync(join(context.homeDirectory || homedir(), ".lax", "settings.json")));
  if (id === "build") {
    if (!existsSync(join(process.cwd(), "dist", "index.js"))) return "absent";
    return evidence.inFlight ? "ambiguous" : "present";
  }
  if (id === "config") return verifyConfig(context);
  if (id === "posixshell") return platform !== "win32" ? "present" : present(Boolean(resolvePosixShell({ env: context.env || process.env })));
  if (id === "desktop") return verifyDesktop({ ...context, platform, processes });
  return "ambiguous";
}
