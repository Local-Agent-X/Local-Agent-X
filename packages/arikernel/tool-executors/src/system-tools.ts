import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** The lowercased basename an executable names, whichever separator it uses. */
export function toolNameOf(normalizedExe: string): string {
	return (normalizedExe.split("/").pop()?.split("\\").pop() ?? normalizedExe).toLowerCase();
}

/**
 * The only directories an allowlisted tool runs from. Fixed, never PATH: a PATH
 * entry can be the cwd (an empty or "." entry) or a user-writable bin dir, and
 * on Windows a bare name is looked up in the cwd before PATH. Each of those
 * would run a file the agent wrote, named like an allowlisted tool, on the host
 * in its place. Windows has no system coreutils, so there they are Git for
 * Windows' usr\bin under the roots the shell itself is provisioned to: the
 * installer's PortableGit (scripts/portable-git.mjs), then the standard installs.
 */
export function systemToolDirs(): string[] {
	if (process.platform !== "win32") return ["/usr/bin", "/bin"];
	const localAppData = process.env.LOCALAPPDATA;
	const gitRoots = [
		...(localAppData ? [join(localAppData, "LocalAgentX", "PortableGit")] : []),
		join(process.env.ProgramFiles || "C:\\Program Files", "Git"),
		join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Git"),
		...(localAppData ? [join(localAppData, "Programs", "Git")] : []),
	];
	return gitRoots.map((root) => join(root, "usr", "bin"));
}

/**
 * The absolute file to spawn for an executable that passed validateCommand:
 * its tool found in systemToolDirs(). A path-shaped executable is accepted
 * only when it IS that file, so a lookalike elsewhere (the workspace, the cwd)
 * is refused instead of run, and the spawn never does a lookup of its own.
 */
export function resolveSystemExecutable(executable: string): string {
	const normalizedExe = executable.normalize("NFKC");
	const name = toolNameOf(normalizedExe);
	const fileName = process.platform === "win32" ? `${name}.exe` : name;
	const dirs = systemToolDirs();
	const resolved = dirs.map((dir) => join(dir, fileName)).find(isExecutableFile);
	if (!resolved) {
		throw new Error(`Executable "${executable}" was not found in the system tool directories (${dirs.join(", ")}).`);
	}
	if (/[\\/]/.test(normalizedExe) && !(isAbsolute(normalizedExe) && sameFile(normalizedExe, resolved))) {
		throw new Error(
			`Executable "${executable}" is not the system ${name} (${resolved}). Allowlisted tools run only from the system tool directories; pass the bare name.`,
		);
	}
	return resolved;
}

function isExecutableFile(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return statSync(path).isFile();
	} catch {
		return false; // absent here, or not executable by this user
	}
}

function sameFile(a: string, b: string): boolean {
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return false; // an unresolvable path is not the system tool
	}
}
