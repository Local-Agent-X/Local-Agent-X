import { execSync } from "node:child_process";

// On Windows, `npm install -g` puts CLIs (claude.cmd, codex.cmd) at the npm
// global prefix, but the running Node process's PATH doesn't include that
// directory until the process restarts. Resolve the prefix once and merge it
// into PATH for any spawn that needs to find a globally-installed CLI.
let _npmGlobalBin: string | null = null;

/**
 * Resolve (and cache) the npm global bin directory — the dir `npm install -g`
 * drops CLIs into. Returns "" if it can't be resolved. Exported so callers
 * that build a scrubbed child env from scratch (rather than spreading
 * process.env) can still prepend it to PATH so a globally-installed `claude`
 * resolves. See src/self-edit/child-env.ts.
 */
export function getNpmGlobalBin(): string {
  if (_npmGlobalBin === null) {
    try {
      const prefix = execSync("npm config get prefix", { timeout: 5000, stdio: "pipe" }).toString().trim();
      _npmGlobalBin = process.platform === "win32" ? prefix : `${prefix}/bin`;
    } catch { _npmGlobalBin = ""; }
  }
  return _npmGlobalBin;
}

export function npmAugmentedEnv(): NodeJS.ProcessEnv {
  const bin = getNpmGlobalBin();
  if (!bin) return process.env;
  const sep = process.platform === "win32" ? ";" : ":";
  return { ...process.env, PATH: `${bin}${sep}${process.env.PATH || ""}` };
}

export function resetNpmAugmentedEnvCache(): void { _npmGlobalBin = null; }
