// The kit is proven the way the skill proves itself: applied to a scratch
// project, its vendored scripts run, and each gate fails on its probe. A check
// that never failed has not been tested.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyProjectKit, projectKitFiles, structureCheckCommand, STRUCTURE_CHECK_SCRIPT } from "./project-kit.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-project-kit-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

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
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "main.tsx"), "export const main = 1;\n");
    writeFileSync(join(dir, "package.json"), JSON.stringify(vitePackage, null, 2));
  });

  it("writes the docs, the scripts and the seal test, and wires npm scripts with the check in front of build", () => {
    const result = applyProjectKit(dir, { projectName: "App" });
    expect(result.written).toEqual(expect.arrayContaining([
      "AGENTS.md", "ARCHITECTURE.md", "docs/adr/0001-record-architecture-decisions.md", "docs/history/README.md",
      "scripts/check-structure.mjs", "scripts/codebase-map.mjs", "scripts/code-refs.mjs", "src/module-seals.test.ts",
    ]));
    expect(result.wiredNpmScripts).toBe(true);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as typeof vitePackage;
    expect(pkg.scripts).toMatchObject({
      build: "npm run check:structure && tsc -b && vite build",
      "check:structure": "node scripts/check-structure.mjs",
      "docs:map": "node scripts/codebase-map.mjs",
      refs: "node scripts/code-refs.mjs",
    });
    expect(pkg.scripts.dev).toBe("vite");
    expect(readFileSync(join(dir, "AGENTS.md"), "utf-8")).toContain("`npm run check:structure`");
    expect(structureCheckCommand(dir)).toBe("node scripts/check-structure.mjs");
  });

  it("is idempotent: a second application writes nothing and changes nothing", () => {
    applyProjectKit(dir, { projectName: "App" });
    writeFileSync(join(dir, "AGENTS.md"), "# mine\n");
    const again = applyProjectKit(dir, { projectName: "App" });
    expect(again.written).toEqual([]);
    expect(again.wiredNpmScripts).toBe(false);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf-8")).toBe("# mine\n");
  });

  it("the structure check passes on the fresh project and writes the map", () => {
    applyProjectKit(dir, { projectName: "App" });
    const r = check(dir);
    expect(r.status, r.out).toBe(0);
    expect(existsSync(join(dir, "docs", "codebase-map.md"))).toBe(true);
  });

  it("fails on a file over the ceiling, naming it", () => {
    applyProjectKit(dir, { projectName: "App" });
    writeFileSync(join(dir, "src", "big.ts"), Array.from({ length: 460 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n");
    const r = check(dir);
    expect(r.status).toBe(1);
    expect(r.out).toContain("src/big.ts: 460 lines");
  });

  it("fails on a module with no owner row until ARCHITECTURE.md names it", () => {
    applyProjectKit(dir, { projectName: "App" });
    mkdirSync(join(dir, "src", "widgets"));
    writeFileSync(join(dir, "src", "widgets", "a.ts"), "export const a = 1;\n");
    const failing = check(dir);
    expect(failing.status).toBe(1);
    expect(failing.out).toContain("src/widgets/");
    writeFileSync(join(dir, "ARCHITECTURE.md"), readFileSync(join(dir, "ARCHITECTURE.md"), "utf-8") + "| Widgets | `src/widgets/` | the widgets |\n");
    expect(check(dir).status).toBe(0);
  });

  it("fails on a doc naming a path that does not exist", () => {
    applyProjectKit(dir, { projectName: "App" });
    writeFileSync(join(dir, "ARCHITECTURE.md"), readFileSync(join(dir, "ARCHITECTURE.md"), "utf-8") + "| Ghost | `src/ghost/` | gone |\n");
    const r = check(dir);
    expect(r.status).toBe(1);
    expect(r.out).toContain("src/ghost/");
  });
});

describe("projectKitFiles for a project with no code yet (Product Build)", () => {
  it("names the source root as a path only once it exists, and skips the seal test without vitest", () => {
    const files = projectKitFiles(dir, { projectName: "Bookwell", readFirst: ["`spec/product.md` — what and why"] });
    const rels = files.map((f) => f.rel);
    expect(rels).not.toContain("src/module-seals.test.ts");
    expect(rels).toContain("scripts/check-structure.mjs");
    const agents = files.find((f) => f.rel === "AGENTS.md")!.content;
    expect(agents).not.toContain("| `src/` |");
    expect(agents).toContain("`node scripts/check-structure.mjs`");
    expect(files.find((f) => f.rel === "ARCHITECTURE.md")!.content).toContain("1. `spec/product.md` — what and why");
  });

  it("the check passes on an empty tree once the files are written, so the first chunk is never blocked by the kit itself", () => {
    for (const f of projectKitFiles(dir, { projectName: "Bookwell" })) {
      mkdirSync(join(dir, f.rel, ".."), { recursive: true });
      writeFileSync(join(dir, f.rel), f.content);
    }
    const r = check(dir);
    expect(r.status, r.out).toBe(0);
  });

  it("a project without the kit has no structure command", () => {
    expect(structureCheckCommand(dir)).toBeNull();
  });
});
