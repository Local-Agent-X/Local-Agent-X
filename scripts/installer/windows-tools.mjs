import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  GIT_PORTABLE_SHA256, GIT_PORTABLE_VERSION, portableGitAssetName,
  portableGitDownloadUrl, portableGitExtractDir,
} from "../portable-git.mjs";
import { NODE_PORTABLE_VERSION } from "./contract.mjs";
import { extractZipTo } from "./archive-tools.mjs";

export function wingetAvailable(processes, platform = process.platform) {
  return platform === "win32" && processes.has("winget");
}

export function ensureOllamaOnPath({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (platform !== "win32") return;
  const dir = join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "Programs", "Ollama");
  const parts = (env.PATH || "").split(";");
  if (existsSync(dir) && !parts.includes(dir)) env.PATH = `${dir};${env.PATH || ""}`;
}

export function killOllamaServe(processes, platform = process.platform) {
  if (platform === "win32") processes.spawnSync("taskkill", ["/F", "/IM", "ollama.exe", "/T"], { stdio: "ignore", shell: true });
  else processes.spawnSync("pkill", ["-f", "ollama serve"], { stdio: "ignore" });
}

export function resolvePosixShell({ env = process.env } = {}) {
  const isWsl = (path) => { const lower = path.toLowerCase().replace(/\//g, "\\"); return lower.includes("\\system32\\") || lower.includes("\\windowsapps\\"); };
  const local = env.LOCALAPPDATA;
  const pathDirs = (env.PATH || "").split(";");
  const candidates = [];
  if (local) candidates.push(join(local, "LocalAgentX", "PortableGit", "bin", "bash.exe"));
  for (const dir of pathDirs) {
    if (!dir) continue;
    const git = join(dir, "git.exe");
    if (existsSync(git) && !isWsl(git)) {
      const root = dirname(dirname(git));
      candidates.push(join(root, "bin", "bash.exe"), join(root, "usr", "bin", "bash.exe"));
    }
  }
  const programFiles = env.ProgramFiles || "C:\\Program Files";
  candidates.push(join(programFiles, "Git", "bin", "bash.exe"), join(programFiles, "Git", "usr", "bin", "bash.exe"));
  if (local) candidates.push(join(local, "Programs", "Git", "bin", "bash.exe"));
  for (const dir of pathDirs) if (dir) candidates.push(join(dir, "bash.exe"));
  return candidates.find((candidate) => !isWsl(candidate) && existsSync(candidate)) || null;
}

export function persistUserPathWin(dirs, processes) {
  const list = dirs.map((dir) => `'${dir.replace(/'/g, "''")}'`).join(",");
  const script = `$p=[Environment]::GetEnvironmentVariable('PATH','User'); foreach($d in @(${list})){ if($p -notlike ('*'+$d+'*')){$p=$d+';'+$p} }; [Environment]::SetEnvironmentVariable('PATH',$p,'User')`;
  try { processes.spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore" }); } catch {}
}

export async function provisionPortableGit({ reporter, processes, env = process.env }) {
  const local = env.LOCALAPPDATA;
  if (!local) { reporter.warn("No LOCALAPPDATA — cannot provision PortableGit."); return null; }
  const extractDir = portableGitExtractDir(local);
  const parent = dirname(extractDir);
  const selfExtractor = join(parent, portableGitAssetName());
  try {
    mkdirSync(parent, { recursive: true });
    reporter.log(`Downloading PortableGit ${GIT_PORTABLE_VERSION} (~56 MB, one-time)…`);
    const response = await fetch(portableGitDownloadUrl());
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    writeFileSync(selfExtractor, buffer);
    const { createHash } = await import("node:crypto");
    const digest = createHash("sha256").update(buffer).digest("hex");
    if (digest !== GIT_PORTABLE_SHA256) throw new Error(`checksum mismatch (got ${digest}, want ${GIT_PORTABLE_SHA256})`);
    reporter.log("Unpacking the POSIX shell (Git Bash)…");
    rmSync(extractDir, { recursive: true, force: true });
    const extracted = processes.spawnSync(selfExtractor, ["-y", "-gm2", "-nr"], { encoding: "utf-8" });
    if (extracted.status !== 0) throw new Error(`self-extractor exit ${extracted.status}`);
    const bin = join(extractDir, "bin");
    const cmd = join(extractDir, "cmd");
    env.PATH = `${bin};${cmd};${env.PATH || ""}`;
    persistUserPathWin([cmd, bin], processes);
    return resolvePosixShell({ env });
  } catch (error) {
    reporter.warn(`PortableGit provision failed: ${error.message}`);
    return null;
  } finally {
    try { rmSync(selfExtractor, { force: true }); } catch {}
  }
}

export async function installNodePortableWin({ processes, env = process.env, home = homedir() }) {
  const local = env.LOCALAPPDATA || join(home, "AppData", "Local");
  const arch = process.arch === "arm64" ? "win-arm64" : "win-x64";
  const packageName = `node-v${NODE_PORTABLE_VERSION}-${arch}`;
  const installRoot = join(local, "LocalAgentX");
  const nodeDir = join(installRoot, packageName);
  const zip = join(installRoot, `${packageName}.zip`);
  try {
    const url = `https://nodejs.org/dist/v${NODE_PORTABLE_VERSION}/${packageName}.zip`;
    console.log(`[upgrade-node] downloading ${url}`);
    mkdirSync(installRoot, { recursive: true });
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    writeFileSync(zip, Buffer.from(await response.arrayBuffer()));
    rmSync(nodeDir, { recursive: true, force: true });
    const extracted = extractZipTo(zip, installRoot, processes, "win32");
    if (extracted.status !== 0) throw new Error(`unzip exit ${extracted.status}`);
    env.PATH = `${nodeDir};${env.PATH || ""}`;
    persistUserPathWin([nodeDir], processes);
    return { status: existsSync(join(nodeDir, "node.exe")) ? 0 : 1 };
  } catch (error) {
    console.error(`[upgrade-node] portable Node provision failed: ${error.message}`);
    return { status: 1 };
  } finally {
    try { rmSync(zip, { force: true }); } catch {}
  }
}

export async function installOllamaDirectWindows({ reporter, processes, env = process.env, home = homedir() }) {
  const temporary = join(env.TEMP || home, "OllamaSetup.exe");
  reporter.log("Downloading Ollama installer (~700 MB, one-time)…");
  const download = await processes.runStreaming(
    `powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://ollama.com/download/OllamaSetup.exe' -OutFile '${temporary}' -UseBasicParsing"`, [],
  );
  if (download.status !== 0) { reporter.warn(`Ollama download failed (exit ${download.status})`); return false; }
  reporter.log("Running the Ollama installer (silent)…");
  const result = await processes.runStreaming(`"${temporary}" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART`, []);
  return result.status === 0;
}
