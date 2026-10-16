// `npm run deps -- <path> --depth N` and `npm run refs -- <Name> --depth N`:
// how far a change reaches, by the compiler's own reading of the code. Each
// is checked on a small fixture project for the cases a text search gets
// wrong: an import inside a comment, a dynamic import(), a renamed import, a
// test reached only through a helper, a use at module scope.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildImportGraph, importersByHop, testsReaching } from "../scripts/lib/import-graph.mjs";
import { enclosingDeclaration, symbolReach } from "../scripts/lib/symbol-reach.js";
import { getLanguageIntel } from "../src/language-intel/index.js";

let repo: string;
const at = (p: string) => resolve(repo, p);

const FILES: Record<string, string> = {
  "package.json": `{ "type": "module" }`,
  "tsconfig.json": JSON.stringify({ compilerOptions: { module: "Node16", moduleResolution: "Node16", target: "ES2022", strict: true }, include: ["src", "test"] }),
  "src/base.ts": `export function base(): number { return 1; }\n`,
  "src/mid.ts": `import { base as renamed } from "./base.js";\nexport function mid(): number {\n  return renamed() + 1;\n}\n`,
  "src/top.ts": `import { mid } from "./mid.js";\nexport const top = (): number => mid();\n`,
  "src/lazy.ts": `export async function lazy() {\n  return (await import("./top.js")).top();\n}\n`,
  "src/registry.ts": `import { mid } from "./mid.js";\nmid();\n`,
  "src/commented.ts": `// import { base } from "./base.js";\nexport const nothing = 0;\n`,
  "src/mid.test-helper.ts": `import { mid } from "./mid.js";\nexport const viaHelper = () => mid();\n`,
  "src/helper.test.ts": `import { viaHelper } from "./mid.test-helper.js";\nviaHelper();\n`,
  "test/top.test.ts": `import { top } from "../src/top.js";\ntop();\n`,
  "src/mid.test.ts": `import { mid } from "./mid.js";\nmid();\n`,
};

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "lax-reach-"));
  for (const [p, text] of Object.entries(FILES)) {
    mkdirSync(join(repo, p, ".."), { recursive: true });
    writeFileSync(join(repo, p), text);
  }
});
afterAll(() => {
  getLanguageIntel().dispose();
  rmSync(repo, { recursive: true, force: true });
});

describe("deps --depth: who a file reaches through imports, hop by hop", () => {
  it("follows static and dynamic imports, never one inside a comment", () => {
    const graph = buildImportGraph(repo);
    const hops = importersByHop(graph, at("src/base.ts"), 3).map((h) => h.map((f) => f.slice(repo.length + 1).replace(/\\/g, "/")).sort());
    expect(hops[0]).toEqual(["src/mid.ts"]);
    expect(hops[1]).toEqual(expect.arrayContaining(["src/top.ts", "src/registry.ts", "src/mid.test-helper.ts", "src/mid.test.ts"]));
    expect(hops[2]).toEqual(expect.arrayContaining(["src/lazy.ts", "test/top.test.ts"]));
    expect(hops.flat().some((f) => f.endsWith("commented.ts"))).toBe(false);
  });

  it("lists the tests to run: direct, in test/, and through a helper", () => {
    const graph = buildImportGraph(repo);
    const tests = testsReaching(graph, [at("src/mid.ts")]).map((f) => f.slice(repo.length + 1).replace(/\\/g, "/")).sort();
    expect(tests).toEqual(["src/helper.test.ts", "src/mid.test.ts"]);
    expect(testsReaching(graph, [at("src/top.ts")]).map((f) => f.endsWith("top.test.ts"))).toEqual([true]);
  });
});

describe("refs --depth: which declarations a change reaches, symbol by symbol", () => {
  it("names the top-level declaration a line sits in, or none at module scope", () => {
    expect(enclosingDeclaration(at("src/mid.ts"), 3)?.name).toBe("mid");
    expect(enclosingDeclaration(at("src/top.ts"), 2)?.name).toBe("top");
    expect(enclosingDeclaration(at("src/registry.ts"), 2)).toBeNull();
  });

  it("follows a renamed import to the declarations that use it, and stops at tests", async () => {
    const intel = getLanguageIntel();
    const reach = await symbolReach((loc) => intel.findReferences(loc), { file: at("src/base.ts"), line: 1, column: 17 }, 2, (f) => /\.test\./.test(f));
    expect(reach.hops[0].map((d) => d.name)).toEqual(["mid"]);
    expect(reach.hops[1].map((d) => d.name).sort()).toEqual(["top", "viaHelper"]);
    expect(reach.moduleScope.map((m) => m.file)).toEqual([at("src/registry.ts")]);
    expect(reach.tests.map((f) => f.replace(/\\/g, "/").split("/").pop())).toEqual(["mid.test.ts"]);
  }, 60_000);
});
