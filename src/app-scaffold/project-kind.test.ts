// The project kind drives what the kit writes (roots, seal test). Its root rule
// restates the kit script's own; the last test runs the vendored script on the
// same fixtures so the two can never disagree silently.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { detectProjectKind, hasProjectFile } from "./project-kind.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-project-kind-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const file = (rel: string, text = "") => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};

const fixtures: Record<string, () => void> = {
  rust: () => { file("Cargo.toml", "[package]\n"); file("src/main.rs"); },
  go: () => { file("go.mod", "module example.com/x\n"); file("internal/a/a.go"); file("cmd/x/main.go"); },
  "go without the usual folders": () => { file("go.mod", "module example.com/x\n"); file("main.go"); },
  "python with pytest": () => { file("pyproject.toml", "[tool.pytest.ini_options]\n"); file("src/app/__init__.py"); },
  "python without pytest": () => { file("requirements.txt", "flask\n"); },
  "vite with vitest and typescript": () => {
    file("package.json", JSON.stringify({ devDependencies: { vitest: "^3", typescript: "~5" } })); file("src/main.tsx");
  },
  sveltekit: () => { file("package.json", "{}"); file("svelte.config.js"); file("src/lib/index.ts"); file("src/routes/+page.svelte"); },
  "next app dir": () => { file("package.json", JSON.stringify({ dependencies: { next: "15" } })); file("app/page.tsx"); },
  "node before any code": () => { file("package.json", "{}"); },
  empty: () => {},
};

describe("detectProjectKind", () => {
  it("rust: src, no seal test (the compiler is one)", () => {
    fixtures.rust();
    expect(detectProjectKind(dir)).toMatchObject({ language: "rust", sourceRoots: ["src"], absentRoots: [], sealTest: "compiler" });
  });
  it("go: the roots present among internal/, cmd/, pkg/; internal/ named when none exists yet", () => {
    fixtures.go();
    expect(detectProjectKind(dir)).toMatchObject({ language: "go", sourceRoots: ["internal", "cmd"], sealTest: "compiler" });
    rmSync(join(dir, "internal"), { recursive: true });
    rmSync(join(dir, "cmd"), { recursive: true });
    expect(detectProjectKind(dir)).toMatchObject({ sourceRoots: ["internal"], absentRoots: ["internal"] });
  });
  it("python: pytest seal test only when pytest is configured", () => {
    fixtures["python with pytest"]();
    expect(detectProjectKind(dir)).toMatchObject({ language: "python", sourceRoots: ["src"], sealTest: "pytest" });
    rmSync(join(dir, "pyproject.toml"));
    fixtures["python without pytest"]();
    expect(detectProjectKind(dir)).toMatchObject({ language: "python", sealTest: null });
  });
  it("node: vitest seal test and refs follow the dependencies; the root follows the framework's layout", () => {
    fixtures["vite with vitest and typescript"]();
    expect(detectProjectKind(dir)).toMatchObject({ language: "node", sourceRoots: ["src"], sealTest: "vitest", typescript: true });
    rmSync(dir, { recursive: true, force: true });
    fixtures.sveltekit();
    expect(detectProjectKind(dir)).toMatchObject({ sourceRoots: ["src/lib"], sealTest: null, typescript: false });
    rmSync(dir, { recursive: true, force: true });
    fixtures["next app dir"]();
    expect(detectProjectKind(dir)).toMatchObject({ sourceRoots: ["app"], absentRoots: [] });
    rmSync(dir, { recursive: true, force: true });
    fixtures["node before any code"]();
    expect(detectProjectKind(dir)).toMatchObject({ sourceRoots: ["src"], absentRoots: ["src"] });
  });
  it("no project file: unknown, the kit's defaults", () => {
    expect(detectProjectKind(dir)).toMatchObject({ language: "unknown", sourceRoots: ["src"], sealTest: null });
    expect(hasProjectFile(dir)).toBe(false);
    fixtures.rust();
    expect(hasProjectFile(dir)).toBe(true);
  });
});

describe("the root rule is the kit script's root rule", () => {
  const kitScript = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "kit", "project-languages.mjs")).href;
  it.each(Object.keys(fixtures))("%s", (name) => {
    fixtures[name]();
    const r = spawnSync(process.execPath, [
      "--input-type=module", "-e",
      `import { defaultRoots } from ${JSON.stringify(kitScript)}; console.log(JSON.stringify(defaultRoots(process.argv[1])));`,
      dir,
    ], { encoding: "utf-8" });
    expect(r.status, r.stderr).toBe(0);
    const scriptRoots = JSON.parse(r.stdout.trim()) as string[];
    const kind = detectProjectKind(dir);
    // Go is the one kind whose roots are "those present": the script scans
    // none when none exists, while the docs still name the one the first code
    // will create.
    const expected = kind.language === "go" ? kind.sourceRoots.filter((root) => !kind.absentRoots.includes(root)) : kind.sourceRoots;
    expect(scriptRoots).toEqual(expected);
  });
});
