// The kit is proven the way the skill proves itself: applied to a scratch
// project, its vendored scripts run, and each gate fails on its probe. A check
// that never failed has not been tested.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { adoptProjectKit, applyProjectKit, projectKitFiles, structureCheckCommand, STRUCTURE_CHECK_SCRIPT } from "./project-kit.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-project-kit-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const file = (rel: string, text = "") => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
const read = (rel: string) => readFileSync(join(dir, rel), "utf-8");
const appendArchRow = (row: string) => writeFileSync(join(dir, "ARCHITECTURE.md"), read("ARCHITECTURE.md") + row + "\n");

const vitePackage = {
  name: "app",
  scripts: { dev: "vite", build: "tsc -b && vite build" },
  devDependencies: { typescript: "~5.8.3", vite: "^7.0.0", vitest: "^3.0.0" },
};

function check(cwd: string): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [join(cwd, STRUCTURE_CHECK_SCRIPT)], { cwd, encoding: "utf-8" });
  return { status: r.status, out: r.stdout + r.stderr };
}

describe("applyProjectKit on a scaffolded TypeScript project", () => {
  beforeEach(() => {
    file("src/main.tsx", "export const main = 1;\n");
    file("package.json", JSON.stringify(vitePackage, null, 2));
  });

  it("writes the docs, the scripts and the seal test, and wires npm scripts with the check in front of build", () => {
    const result = applyProjectKit(dir, { projectName: "App" });
    expect(result.written).toEqual(expect.arrayContaining([
      "AGENTS.md", "ARCHITECTURE.md", "docs/adr/0001-record-architecture-decisions.md", "docs/history/README.md",
      "scripts/check-structure.mjs", "scripts/codebase-map.mjs", "scripts/project-languages.mjs", "scripts/code-refs.mjs",
      "src/module-seals.test.ts",
    ]));
    expect(result.wiredNpmScripts).toBe(true);
    const pkg = JSON.parse(read("package.json")) as typeof vitePackage;
    expect(pkg.scripts).toMatchObject({
      build: "npm run check:structure && tsc -b && vite build",
      "check:structure": "node scripts/check-structure.mjs",
      "docs:map": "node scripts/codebase-map.mjs",
      refs: "node scripts/code-refs.mjs",
      test: "vitest run",
    });
    expect(pkg.scripts.dev).toBe("vite");
    const agents = read("AGENTS.md");
    expect(agents).toContain("`npm run check:structure`");
    expect(agents).toContain("`src/module-seals.test.ts` holds the seal table");
    expect(structureCheckCommand(dir)).toBe("node scripts/check-structure.mjs");
  });

  it("is idempotent: a second application writes nothing and changes nothing", () => {
    applyProjectKit(dir, { projectName: "App" });
    file("AGENTS.md", "# mine\n");
    const again = applyProjectKit(dir, { projectName: "App" });
    expect(again.written).toEqual([]);
    expect(again.wiredNpmScripts).toBe(false);
    expect(read("AGENTS.md")).toBe("# mine\n");
  });

  it("the structure check passes on the fresh project and writes the map", () => {
    applyProjectKit(dir, { projectName: "App" });
    const r = check(dir);
    expect(r.status, r.out).toBe(0);
    expect(existsSync(join(dir, "docs", "codebase-map.md"))).toBe(true);
  });

  it("fails on a file over the ceiling, naming it and the way out", () => {
    applyProjectKit(dir, { projectName: "App" });
    file("src/big.ts", Array.from({ length: 460 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n");
    const r = check(dir);
    expect(r.status).toBe(1);
    expect(r.out).toContain("src/big.ts: 460 lines (limit 450) — split it by responsibility, or, if it is a generated file that must stay large, add its path to .file-size-allow");
  });

  it("fails on a module with no owner row until ARCHITECTURE.md names it", () => {
    applyProjectKit(dir, { projectName: "App" });
    file("src/widgets/a.ts", "export const a = 1;\n");
    const failing = check(dir);
    expect(failing.status).toBe(1);
    expect(failing.out).toContain("src/widgets/");
    appendArchRow("| Widgets | `src/widgets/` | the widgets |");
    expect(check(dir).status).toBe(0);
  });

  it("fails on a doc naming a path that does not exist", () => {
    applyProjectKit(dir, { projectName: "App" });
    appendArchRow("| Ghost | `src/ghost/` | gone |");
    const r = check(dir);
    expect(r.status).toBe(1);
    expect(r.out).toContain("src/ghost/");
  });
});

describe("the kit follows the project kind", () => {
  it("python with pytest: the pytest seal test in tests/, pointed at the root", () => {
    file("pyproject.toml", "[tool.pytest.ini_options]\ntestpaths = ['tests']\n");
    file("src/app/__init__.py");
    const files = projectKitFiles(dir, { projectName: "Svc" });
    const seal = files.find((f) => f.rel === "tests/test_module_seals.py");
    expect(seal?.content).toContain('SOURCE_ROOT = "../src"');
    expect(files.map((f) => f.rel)).not.toContain("src/module-seals.test.ts");
    expect(files.find((f) => f.rel === "AGENTS.md")!.content).toContain("`tests/test_module_seals.py` holds the seal table");
  });

  it("rust: no seal test, the compiler named as the boundary, a file module owned by its .rs path", () => {
    file("Cargo.toml", "[package]\nname = \"probe\"\n");
    file("src/main.rs", "mod auth;\nfn main() { auth::login(); }\n");
    file("src/auth.rs", "pub fn login() {}\n");
    const result = applyProjectKit(dir, { projectName: "Probe" });
    expect(result.written.some((r) => r.includes("module-seals") || r.includes("test_module_seals"))).toBe(false);
    expect(result.wiredNpmScripts).toBe(false);
    const agents = read("AGENTS.md");
    expect(agents).toContain("**Module boundaries are the compiler's.**");
    expect(agents).toContain("`cargo check`");
    expect(agents).toContain("`src/<module>.rs`");
    const failing = check(dir);
    expect(failing.status).toBe(1);
    expect(failing.out).toContain("src/auth.rs");
    appendArchRow("| Auth | `src/auth.rs` | login |");
    expect(check(dir).status, check(dir).out).toBe(0);
  });

  it("go: the roots present are the docs' roots and the check's, a package directory is the module", () => {
    file("go.mod", "module example.com/probe\n");
    file("cmd/app/main.go", 'package main\n\nimport "example.com/probe/internal/store"\n\nfunc main() { store.Get() }\n');
    file("internal/store/store.go", "package store\n\nfunc Get() string { return \"\" }\n");
    applyProjectKit(dir, { projectName: "Probe" });
    const agents = read("AGENTS.md");
    expect(agents).toContain("| `internal/`, `cmd/` |");
    expect(agents).toContain("`gopls references");
    expect(agents).toContain("`internal/` cannot be imported from outside");
    const failing = check(dir);
    expect(failing.status).toBe(1);
    expect(failing.out).toContain("internal/store/");
    expect(failing.out).toContain("cmd/app/");
    appendArchRow("| Entry | `cmd/app/` | main |");
    appendArchRow("| Store | `internal/store/` | kv |");
    expect(check(dir).status, check(dir).out).toBe(0);
    expect(read("docs/codebase-map.md")).toContain("| `cmd/app/` | `internal/store/` |");
  });

  it("a Next app-dir project: app/ is the root the docs name and the check scans", () => {
    file("package.json", JSON.stringify({ dependencies: { next: "15.0.0" } }));
    file("app/page.tsx", "export default function Page() { return null; }\n");
    applyProjectKit(dir, { projectName: "Site" });
    expect(read("AGENTS.md")).toContain("`npm run deps -- app/<module> --depth 2`");
    file("app/components/nav.tsx", "export const Nav = 1;\n");
    const failing = check(dir);
    expect(failing.status).toBe(1);
    expect(failing.out).toContain("app/components/");
  });
});

describe("adoptProjectKit — the kit for a project the model created", () => {
  it("applies the kit once to a project that has none, and reports nothing to do otherwise", () => {
    expect(adoptProjectKit(dir, { projectName: "Site" }), "no project file yet").toBeNull();
    file("package.json", JSON.stringify({ dependencies: { next: "15.0.0" } }));
    file("app/page.tsx", "export default function Page() { return null; }\n");
    const first = adoptProjectKit(dir, { projectName: "Site" });
    expect(first?.written).toEqual(expect.arrayContaining(["AGENTS.md", "scripts/check-structure.mjs"]));
    expect(structureCheckCommand(dir)).toBe("node scripts/check-structure.mjs");
    expect(adoptProjectKit(dir, { projectName: "Site" }), "already carries the kit").toBeNull();
  });
});

describe("projectKitFiles for a project with no code yet (Product Build)", () => {
  it("names the source root as a path only once it exists, and skips the seal test without a runner", () => {
    const files = projectKitFiles(dir, { projectName: "Bookwell", readFirst: ["`spec/product.md` — what and why"] });
    const rels = files.map((f) => f.rel);
    expect(rels).not.toContain("src/module-seals.test.ts");
    expect(rels).toContain("scripts/check-structure.mjs");
    const agents = files.find((f) => f.rel === "AGENTS.md")!.content;
    expect(agents).not.toContain("| `src/` |");
    expect(agents).toContain("src/ (the first code creates it)");
    expect(agents).toContain("`node scripts/check-structure.mjs`");
    expect(files.find((f) => f.rel === "ARCHITECTURE.md")!.content).toContain("1. `spec/product.md` — what and why");
  });

  it("the check passes on an empty tree once the files are written, so the first chunk is never blocked by the kit itself", () => {
    for (const f of projectKitFiles(dir, { projectName: "Bookwell" })) file(f.rel, f.content);
    const r = check(dir);
    expect(r.status, r.out).toBe(0);
  });

  it("a project without the kit has no structure command", () => {
    expect(structureCheckCommand(dir)).toBeNull();
  });
});
