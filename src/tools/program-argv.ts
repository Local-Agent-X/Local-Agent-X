/**
 * The fixed programs the build runners start (npm, npx, git), as argv for
 * spawnCaged, so none of them goes through a shell.
 *
 * On Windows the program is named by full path, found in the PATH's absolute
 * entries only: a bare name handed to spawn is looked for in the child's cwd
 * first, and that cwd is the agent's project, where a planted git.exe would
 * run in place of git. npm and npx are batch shims there, which spawn cannot
 * start without cmd.exe, so they run as node with the CLI script the shim
 * itself runs. Elsewhere the name stays bare: exec searches the PATH and never
 * the cwd.
 */
import { statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path/win32";

export interface ProgramArgv {
  file: string;
  args: string[];
}

function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

function onWindowsPath(name: string): string {
  for (const dir of (process.env.PATH ?? "").split(";")) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    if (isFile(candidate)) return candidate;
  }
  throw new Error(`${name} was not found on the PATH, so nothing was started.`);
}

export function gitArgv(args: string[]): ProgramArgv {
  return { file: process.platform === "win32" ? onWindowsPath("git.exe") : "git", args };
}

export function npmArgv(tool: "npm" | "npx", args: string[]): ProgramArgv {
  if (process.platform !== "win32") return { file: tool, args };
  // What the shim runs: the node.exe beside it (else the PATH's) on the CLI
  // script under its own node_modules.
  const home = dirname(onWindowsPath(`${tool}.cmd`));
  const beside = join(home, "node.exe");
  return {
    file: isFile(beside) ? beside : onWindowsPath("node.exe"),
    args: [join(home, "node_modules", "npm", "bin", `${tool}-cli.js`), ...args],
  };
}

/** A fixed `npm …` or `npx …` line from the harness's own plans, which carry
 *  no quoting, as argv. */
export function npmCommandArgv(command: string): ProgramArgv {
  const [tool, ...args] = command.split(" ");
  if (tool !== "npm" && tool !== "npx") throw new Error(`"${command}" is not an npm command, so nothing was started.`);
  return npmArgv(tool, args);
}
