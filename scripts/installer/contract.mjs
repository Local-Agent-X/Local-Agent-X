import { readFileSync } from "node:fs";

export const NODE_MAJOR_MIN = (() => {
  try {
    const engines = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8")).engines?.node;
    const match = String(engines || "").match(/(\d+)/);
    if (match) return Number(match[1]);
  } catch {}
  return 22;
})();

export const NODE_LTS_INSTALL = 24;
export const NODE_PORTABLE_VERSION = "24.16.0";
export const EMBED_MODEL = "mxbai-embed-large";
export const WINGET_SOURCE = ["--source", "winget"];
export const INSTALL_CHECKPOINT_VERSION = 1;

export const ALL_STEPS = [
  { id: "node", label: "Node.js runtime", platforms: ["win32", "darwin", "linux"], required: true },
  { id: "vsbuildtools", label: "C++ build tools", platforms: ["win32"], required: false },
  { id: "xcode-clt", label: "Xcode Command Line Tools", platforms: ["darwin"], required: false },
  { id: "python", label: "Python 3.12", platforms: ["win32", "darwin", "linux"], required: false },
  { id: "ollama", label: "Ollama AI runtime", platforms: ["win32", "darwin", "linux"], required: false },
  { id: "npm", label: "App dependencies", platforms: ["win32", "darwin", "linux"], required: true },
  { id: "embedmodel", label: "AI memory engine", platforms: ["win32", "darwin", "linux"], required: false },
  { id: "settings", label: "User settings", platforms: ["win32", "darwin", "linux"], required: false },
  { id: "build", label: "App build", platforms: ["win32", "darwin", "linux"], required: true },
  { id: "config", label: "Configuration", platforms: ["win32", "darwin", "linux"], required: true },
  { id: "posixshell", label: "POSIX shell", platforms: ["win32"], required: true },
  { id: "desktop", label: "Desktop app", platforms: ["win32", "darwin", "linux"], required: true },
];

export function stepsPlan(platform = process.platform) {
  return ALL_STEPS.filter((step) => step.platforms.includes(platform)).map(({ id, label }) => ({ id, label }));
}

export function wantsOllama(env = process.env) {
  return env.LAX_INSTALL_OLLAMA === "1" || env.LAX_INSTALL_OLLAMA === "true";
}

export function wantsOllamaMemoryModel(env = process.env) {
  return env.LAX_INSTALL_OLLAMA_MEMORY_MODEL === "1" || env.LAX_INSTALL_OLLAMA_MEMORY_MODEL === "true";
}

export function installerSelections(env = process.env) {
  return {
    ollamaRuntime: wantsOllama(env),
    ollamaMemoryModel: wantsOllamaMemoryModel(env),
  };
}

export function installerContract(platform, selections) {
  return {
    version: INSTALL_CHECKPOINT_VERSION,
    platform,
    steps: stepsPlan(platform).map(({ id }) => id),
    selections,
  };
}

export function stepIntent(contract, stepId) {
  const selection = stepId === "ollama"
    ? contract.selections.ollamaRuntime
    : stepId === "embedmodel" ? contract.selections.ollamaMemoryModel : null;
  return JSON.stringify({
    version: contract.version,
    platform: contract.platform,
    steps: contract.steps,
    stepId,
    selection,
  });
}
