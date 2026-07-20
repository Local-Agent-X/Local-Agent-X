import { existsSync } from "node:fs";
import { EMBED_MODEL, NODE_MAJOR_MIN, WINGET_SOURCE } from "./contract.mjs";
import { ensureOllamaOnPath, installOllamaDirectWindows, wingetAvailable } from "./windows-tools.mjs";

export async function runPrerequisiteSteps(context) {
  const { reporter, processes, platform = process.platform, wantOllama } = context;
  reporter.step("node");
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < NODE_MAJOR_MIN) reporter.fail(`Node ${NODE_MAJOR_MIN}+ required (found v${process.versions.node})`);
  reporter.ok(`Node v${process.versions.node}`);
  reporter.stepDone("node");

  if (platform === "win32") await installWindowsBuildTools(context);
  else if (platform === "darwin") await installXcodeTools(context);
  await installPython(context);
  await installOllama(context, wantOllama);
}

async function installWindowsBuildTools({ reporter, processes }) {
  reporter.step("vsbuildtools", "~3 GB download, 10-30 min on first install");
  const vswhere = `${process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)"}\\Microsoft Visual Studio\\Installer\\vswhere.exe`;
  let hasCompiler = false;
  if (existsSync(vswhere)) {
    const result = processes.spawnSync(vswhere, [
      "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath",
    ], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    hasCompiler = result.status === 0 && (result.stdout || "").trim().length > 0;
  }
  if (hasCompiler) reporter.ok("Visual Studio Build Tools already present");
  else if (!wingetAvailable(processes, "win32")) {
    reporter.warn("winget not available — skipping C++ build tools. Prebuilt native binaries will be used; if a later step needs a source build, install VS Build Tools from https://visualstudio.microsoft.com/downloads/ and re-run.");
  } else {
    reporter.log("Installing Visual Studio Build Tools (silent winget)…");
    const override = "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended";
    const result = await processes.runStreaming(
      `winget install --id Microsoft.VisualStudio.2022.BuildTools ${WINGET_SOURCE.join(" ")} `
      + `--accept-package-agreements --accept-source-agreements --silent --override "${override}"`, [],
    );
    if (result.status === 0 || result.status === -1978335215) reporter.ok("Visual Studio Build Tools installed");
    else reporter.warn(`winget couldn't install VS Build Tools (exit ${result.status}) — continuing with prebuilt native binaries. If a later step fails on a node-gyp / C++ source build, install VS Build Tools from https://visualstudio.microsoft.com/downloads/ and re-run.`);
  }
  reporter.stepDone("vsbuildtools");
}

async function installXcodeTools({ reporter, processes }) {
  reporter.step("xcode-clt", "Apple requires a system dialog — click Install if prompted");
  const check = processes.spawnSync("xcode-select", ["-p"], { stdio: ["ignore", "ignore", "ignore"] });
  if (check.status === 0) reporter.ok("Xcode Command Line Tools already present");
  else {
    reporter.log("Triggering Xcode CLT install (system dialog opens)…");
    processes.spawnSync("xcode-select", ["--install"], { stdio: ["ignore", "ignore", "ignore"] });
    const deadline = Date.now() + 30 * 60 * 1000;
    let done = false;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      if (processes.spawnSync("xcode-select", ["-p"], { stdio: ["ignore", "ignore", "ignore"] }).status === 0) { done = true; break; }
    }
    if (!done) reporter.fail("Xcode Command Line Tools didn't finish installing within 30 min — prebuilt native binaries will be used. If a later step fails on a C++ source build, run 'xcode-select --install' and re-run");
    else reporter.ok("Xcode Command Line Tools installed");
  }
  reporter.stepDone("xcode-clt");
}

async function installPython({ reporter, processes, platform = process.platform }) {
  reporter.step("python");
  const command = platform === "win32" ? "python" : "python3";
  const present = processes.spawnSync(command, ["--version"], { stdio: ["ignore", "ignore", "ignore"], shell: true }).status === 0;
  if (present) reporter.ok("Python already present");
  else {
    reporter.log("Installing Python 3.12…");
    let result;
    if (platform === "win32") {
      if (!wingetAvailable(processes, platform)) reporter.warn("winget not available — skipping Python 3.12 (voice servers won't work until you install Python from https://python.org and re-run).");
      else {
        result = await processes.runStreaming("winget", ["install", "Python.Python.3.12", ...WINGET_SOURCE, "--accept-package-agreements", "--accept-source-agreements", "--silent"]);
        if (result.status !== 0) reporter.warn(`Python install failed (exit ${result.status}) — continuing without (voice servers won't work)`);
        else reporter.ok("Python 3.12 installed");
      }
    } else if (platform === "darwin") {
      result = processes.run("brew", ["install", "python@3.12"]);
      if (result.status !== 0) reporter.warn("Python install failed — continuing without (voice servers won't work)");
      else reporter.ok("Python 3.12 installed");
    } else {
      result = processes.run("sudo", ["apt-get", "install", "-y", "python3", "python3-pip"]);
      if (result.status !== 0) reporter.warn("Python install failed — continuing without (voice servers won't work)");
      else reporter.ok("Python installed");
    }
  }
  reporter.stepDone("python");
}

async function installOllama({ reporter, processes, platform = process.platform }, selected) {
  reporter.step("ollama");
  if (!selected) reporter.ok("Skipped — memory uses the built-in local embedder (no Ollama needed). Set LAX_INSTALL_OLLAMA=1 to enable Ollama-backed semantic memory.");
  else if (processes.has("ollama")) reporter.ok("Ollama already present");
  else if (platform === "win32") {
    reporter.log("Installing Ollama…");
    let installed = false;
    if (wingetAvailable(processes, platform)) {
      const result = await processes.runStreaming("winget", ["install", "Ollama.Ollama", ...WINGET_SOURCE, "--accept-package-agreements", "--accept-source-agreements", "--silent"]);
      if (result.status === 0) installed = true;
      else reporter.warn(`winget couldn't install Ollama (exit ${result.status}) — falling back to Ollama's official installer…`);
    } else reporter.log("winget not available — installing Ollama from its official installer…");
    if (!installed && await installOllamaDirectWindows({ reporter, processes })) installed = true;
    if (installed) { ensureOllamaOnPath(); reporter.ok("Ollama installed"); }
    else reporter.fail("Ollama couldn't be installed via winget or its official installer. Install it from https://ollama.com/download and re-run to enable semantic memory");
  } else if (platform === "darwin") {
    reporter.log("Installing Ollama…");
    if (!processes.has("brew")) reporter.fail("Homebrew not found, so Ollama couldn't be installed. Install Ollama from https://ollama.com/download to enable semantic memory");
    else {
      const result = processes.run("brew", ["install", "ollama"]);
      if (result.status !== 0) reporter.fail("Ollama install failed. Install it from https://ollama.com/download and re-run to enable semantic memory");
      else reporter.ok("Ollama installed");
    }
  } else {
    reporter.log("Installing Ollama…");
    const result = processes.spawnSync("sh", ["-c", "curl -fsSL https://ollama.com/install.sh | sh"], { stdio: reporter.ipcMode ? ["ignore", "pipe", "pipe"] : "inherit" });
    if (result.status !== 0) reporter.fail("Ollama install failed. Install it from https://ollama.com/download and re-run to enable semantic memory");
    else reporter.ok("Ollama installed");
  }
  reporter.stepDone("ollama");
}
