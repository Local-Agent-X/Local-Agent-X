/**
 * PATH repair for agent-spawned subprocesses. A Finder/launchd-launched macOS
 * app (or a minimal-PATH Linux service) inherits a PATH without the user's
 * toolchain or LAX's own bundled binaries — this module appends what exists so
 * shell commands resolve the same tools LAX's built-in tools do. Split from
 * shell-env.ts (LOC cap); buildSanitizedEnv is the only production caller.
 */

import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
import { ffmpegBin, ffprobeBin } from "../ffmpeg-bin.js";
import { ripgrepBin } from "./grep-tool.js";

// Standard user-toolchain bin dirs that a Finder/launchd-launched macOS app (or
// a minimal-PATH Linux service) inherits a PATH WITHOUT — so `cargo`, `go`,
// `python3`, `node`, and other Homebrew/rustup tools read as "command not found"
// even when installed. We APPEND the ones that exist (never prepend), so system
// tools keep priority and nothing is shadowed. This is what makes the
// compiled-language app-build tier — and any build/test command — work
// regardless of how LAX was launched.
function toolchainBinDirs(): string[] {
  const home = homedir();
  if (platform() === "win32") return [join(home, ".cargo", "bin")];
  return [
    "/opt/homebrew/bin", "/opt/homebrew/sbin",   // Apple-silicon Homebrew (cargo, node, go, python3, …)
    "/usr/local/bin", "/usr/local/sbin",          // Intel Homebrew / common installs
    join(home, ".cargo", "bin"),                  // rustup
    join(home, ".local", "bin"),                  // pip --user / pipx
    join(home, "go", "bin"), "/usr/local/go/bin", // Go
    "/opt/local/bin",                             // MacPorts
  ];
}

// Directories holding the binaries LAX bundles for its OWN tools (ripgrep,
// ffmpeg/ffprobe) — resolved through the same canonical resolvers the tools
// use. The agent's shell gets them appended to PATH so a freehand `rg` or
// `ffmpeg` works on any box where the built-in grep/capture tools do, instead
// of "command not found" on machines with no system-wide install. A resolver
// returning a bare name (no separator) means "already expected on PATH" —
// nothing to add. Appended, never prepended, so a user-installed copy wins.
function bundledToolBinDirs(): string[] {
  const dirs: string[] = [];
  for (const bin of [ripgrepBin(), ffmpegBin(), ffprobeBin()]) {
    if (bin.includes(sep)) dirs.push(dirname(bin));
  }
  return [...new Set(dirs)];
}

/** Append `addDirs` to a PATH string, skipping any already present. Pure +
 *  fs-free so it's unit-testable; the caller filters addDirs by existence. */
export function mergePathDirs(currentPath: string | undefined, addDirs: string[]): string {
  const existing = (currentPath || "").split(delimiter).filter(Boolean);
  const have = new Set(existing);
  const add = addDirs.filter((d) => d && !have.has(d));
  return [...existing, ...add].join(delimiter);
}

/** The subprocess PATH: the current value plus every existing toolchain and
 *  bundled-binary dir. */
export function repairedPath(currentPath: string | undefined): string {
  return mergePathDirs(
    currentPath,
    [...toolchainBinDirs(), ...bundledToolBinDirs()].filter((d) => existsSync(d)),
  );
}
