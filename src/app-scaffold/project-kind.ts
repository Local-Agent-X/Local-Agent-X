/**
 * What kind of project is on disk, and what that means for the structure kit:
 * which folders the checks scan (the source roots), which seal test ships
 * (the one its test runner runs), and how the docs name the boundary rule.
 * Read from the project files at the root, nothing else; a directory with no
 * project file is "unknown", which gets the kit's defaults.
 *
 * The root rule is the kit script's own (`kit/project-languages.mjs`,
 * `defaultRoots`), restated here for the docs and the seal test's placement;
 * `project-kind.test.ts` runs the script and fails when the two disagree.
 * Not `src/agent-guards/build-command.ts`: that picks the command that verifies
 * a project, this picks where the kit's checks look.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ProjectLanguage = "node" | "python" | "rust" | "go" | "unknown";

/** The runner the seal test ships for; "compiler" when the language itself
 *  enforces module privacy (Rust `pub`, Go `internal/`) and no test is shipped. */
export type SealTestRunner = "vitest" | "pytest" | "compiler" | null;

export interface ProjectKind {
  language: ProjectLanguage;
  /** Repo-relative, forward slashes; the folders the structure check scans.
   *  Those that exist today come first; `absent` names the ones that do not. */
  sourceRoots: string[];
  /** The roots the docs may name only as "the first code creates it". */
  absentRoots: string[];
  sealTest: SealTestRunner;
  /** TypeScript project: `code-refs` answers symbol questions. */
  typescript: boolean;
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPackageJson(dir: string): PackageJson | null {
  const path = join(dir, "package.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as PackageJson;
  } catch {
    return null; // not JSON: the kit leaves it alone and writes no npm scripts
  }
}

export const hasDependency = (pkg: PackageJson | null, name: string): boolean =>
  !!(pkg?.dependencies?.[name] ?? pkg?.devDependencies?.[name]);

const GO_ROOTS = ["internal", "cmd", "pkg"];
const PYTHON_FILES = ["pyproject.toml", "setup.py", "requirements.txt"];

function mentionsPytest(dir: string): boolean {
  const files = [
    "pyproject.toml",
    ...readdirSync(dir).filter((n) => /^requirements.*\.txt$/.test(n)),
  ].map((n) => join(dir, n)).filter(existsSync);
  return files.some((f) => /pytest/.test(readFileSync(f, "utf-8")));
}

function nodeRoots(dir: string): string[] {
  const svelte = readdirSync(dir).some((n) => /^svelte\.config\.(js|mjs|ts)$/.test(n));
  if (svelte && existsSync(join(dir, "src", "lib"))) return ["src/lib"];
  if (!existsSync(join(dir, "src")) && existsSync(join(dir, "app"))) return ["app"];
  return ["src"];
}

export function detectProjectKind(dir: string): ProjectKind {
  const kind = (language: ProjectLanguage, roots: string[], sealTest: SealTestRunner, typescript = false): ProjectKind => ({
    language,
    sourceRoots: roots,
    absentRoots: roots.filter((r) => !existsSync(join(dir, r))),
    sealTest,
    typescript,
  });
  if (!existsSync(dir)) return kind("unknown", ["src"], null);
  if (existsSync(join(dir, "Cargo.toml"))) return kind("rust", ["src"], "compiler");
  if (existsSync(join(dir, "go.mod"))) {
    const present = GO_ROOTS.filter((r) => existsSync(join(dir, r)));
    return kind("go", present.length ? present : ["internal"], "compiler");
  }
  if (PYTHON_FILES.some((f) => existsSync(join(dir, f)))) {
    return kind("python", ["src"], mentionsPytest(dir) ? "pytest" : null);
  }
  const pkg = readPackageJson(dir);
  if (pkg) return kind("node", nodeRoots(dir), hasDependency(pkg, "vitest") ? "vitest" : null, hasDependency(pkg, "typescript"));
  return kind("unknown", ["src"], null);
}

/** Whether the directory holds a project at all: one of the project files
 *  the kit's scripts key their roots on. */
export const hasProjectFile = (dir: string): boolean => detectProjectKind(dir).language !== "unknown";
