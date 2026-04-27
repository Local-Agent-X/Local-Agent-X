import { execSync } from "node:child_process";

// On Windows, `npm install -g` puts CLIs (claude.cmd, codex.cmd) at the npm
// global prefix, but the running Node process's PATH doesn't include that
// directory until the process restarts. Resolve the prefix once and merge it
// into PATH for any spawn that needs to find a globally-installed CLI.
let _npmGlobalBin: string | null = null;
export function npmAugmentedEnv(): NodeJS.ProcessEnv {
  if (_npmGlobalBin === null) {
    try {
      const prefix = execSync("npm config get prefix", { timeout: 5000, stdio: "pipe" }).toString().trim();
      _npmGlobalBin = process.platform === "win32" ? prefix : `${prefix}/bin`;
    } catch { _npmGlobalBin = ""; }
  }
  if (!_npmGlobalBin) return process.env;
  const sep = process.platform === "win32" ? ";" : ":";
  return { ...process.env, PATH: `${_npmGlobalBin}${sep}${process.env.PATH || ""}` };
}

export function resetNpmAugmentedEnvCache(): void { _npmGlobalBin = null; }
