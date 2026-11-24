// Reach and symbol queries, as the agent's structural_search tool and the
// `npm run refs` command both use them: a symbol named three ways, a walk that
// follows what a text search cannot, and the limits that keep a walk on the
// server's thread from running away.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { enclosingDeclaration, getLanguageIntel, symbolQueryFile, type ReferenceHit, type SymbolLocation } from "./index.js";
import { symbolReach } from "./reach.js";

let repo: string;
const at = (p: string) => resolve(repo, p);
const intel = getLanguageIntel();

const FILES: Record<string, string> = {
  "package.json": `{ "type": "module" }`,
  "tsconfig.json": JSON.stringify({ compilerOptions: { module: "Node16", moduleResolution: "Node16", target: "ES2022", strict: true }, include: ["src"] }),
  "src/store.ts": [
    `export interface Store {`,
    `  save(id: string): boolean;`,
    `}`,
    `export function makeStore(): Store {`,
    `  return { save: (id) => id.length > 0 };`,
    `}`,
    ``,
  ].join("\n"),
  "src/barrel.ts": `export { makeStore } from "./store.js";\n`,
  "src/use.ts": [
    `import { makeStore as build } from "./barrel.js";`,
    `export function keep(id: string): boolean {`,
    `  return build().save(id);`,
    `}`,
    ``,
  ].join("\n"),
  "src/lazy.ts": `export async function later(): Promise<boolean> {\n  return (await import("./use.js")).keep("x");\n}\n`,
  "src/other.ts": `export function makeStore(): number { return 2; }\n`,
  "src/prose.ts": `// makeStore is mentioned here and in "makeStore", never used\nexport const nothing = 0;\n`,
  "src/use.test.ts": `import { keep } from "./use.js";\nkeep("a");\n`,
};

beforeAll(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "lax-reach-unit-")));
  for (const [p, text] of Object.entries(FILES)) {
    mkdirSync(join(repo, p, ".."), { recursive: true });
    writeFileSync(join(repo, p), text);
  }
});
afterAll(() => {
  intel.dispose();
  rmSync(repo, { recursive: true, force: true });
});

const where = (locs: SymbolLocation[]) => locs.map((l) => `${l.file.slice(repo.length + 1).replace(/\\/g, "/")}:${l.line}`).sort();

describe("naming a symbol", () => {
  it("a bare name is every module-level declaration of it, never a mention in prose", async () => {
    expect(where(await intel.symbolTargets(repo, "makeStore"))).toEqual(["src/other.ts:1", "src/store.ts:4"]);
    expect(await intel.symbolTargets(repo, "neverDeclared")).toEqual([]);
    // A member is not a module-level declaration: the bare name does not reach it.
    expect(await intel.symbolTargets(repo, "save")).toEqual([]);
  });

  it("<file>#<Name> is the declaration in that one file", async () => {
    expect(where(await intel.symbolTargets(repo, "src/store.ts#makeStore"))).toEqual(["src/store.ts:4"]);
    expect(where(await intel.symbolTargets(repo, "src/other.ts#makeStore"))).toEqual(["src/other.ts:1"]);
    expect(await intel.symbolTargets(repo, "src/use.ts#makeStore")).toEqual([]);
  });

  it("<file>:<line> is the symbol on that line, which reaches a member", async () => {
    const [member] = await intel.symbolTargets(repo, "src/store.ts:2");
    expect(member).toEqual({ file: at("src/store.ts"), line: 2, column: 3 });
    const uses = (await intel.findReferences(member)).filter((h) => !h.isDefinition).map((h) => `${h.file.slice(repo.length + 1).replace(/\\/g, "/")}:${h.line}`);
    expect(uses).toContain("src/use.ts:3");
    expect(await intel.symbolTargets(repo, "src/store.ts:2:3")).toEqual([member]);
    expect(await intel.symbolTargets(repo, "src/no-such-file.ts:2")).toEqual([]);
  });

  it("says which file a query names, so a caller can confine it", () => {
    expect(symbolQueryFile("makeStore", repo)).toBeNull();
    expect(symbolQueryFile("src/store.ts#makeStore", repo)).toBe(at("src/store.ts"));
    expect(symbolQueryFile("src/store.ts:2", repo)).toBe(at("src/store.ts"));
    expect(symbolQueryFile("../outside.ts:9:2", repo)).toBe(resolve(repo, "../outside.ts"));
  });

  it("resolves a relative file against the base when one is given", async () => {
    expect(where(await intel.symbolTargets(join(repo, "src"), "src/store.ts#makeStore", { base: repo }))).toEqual(["src/store.ts:4"]);
  });
});

describe("reach", () => {
  const start = (): SymbolLocation => ({ file: at("src/store.ts"), line: 4, column: 17 });
  const isTest = (f: string) => /\.test\./.test(f);

  it("follows a barrel re-export, a renamed import and a dynamic import, and ends at the tests", async () => {
    const reach = await intel.reach(start(), 3, isTest);
    expect(reach.hops.map((hop) => hop.map((d) => d.name))).toEqual([["keep"], ["later"], []]);
    expect(reach.tests.map((t) => t.slice(repo.length + 1).replace(/\\/g, "/"))).toEqual(["src/use.test.ts"]);
    expect(reach.capped).toBe(false);
  }, 60_000);

  it("stops at the depth asked for", async () => {
    const reach = await intel.reach(start(), 1, isTest);
    expect(reach.hops.map((hop) => hop.map((d) => d.name))).toEqual([["keep"]]);
  }, 60_000);

  it("stops at its deadline and says what it has is not all of it", async () => {
    let calls = 0;
    const slow = async (loc: SymbolLocation): Promise<ReferenceHit[]> => {
      calls++;
      await new Promise((r) => setTimeout(r, 30));
      return intel.findReferences(loc);
    };
    const reach = await symbolReach(slow, start(), 3, isTest, { deadlineMs: 10 });
    expect(reach.capped).toBe(true);
    expect(calls).toBe(1);
    expect(reach.hops[0].map((d) => d.name)).toEqual(["keep"]);
  }, 60_000);

  it("stops at the declaration cap", async () => {
    const reach = await intel.reach(start(), 3, isTest, { declarations: 1 });
    expect(reach.capped).toBe(true);
    expect(reach.hops).toHaveLength(1);
  }, 60_000);
});

describe("the declaration a line sits in", () => {
  it("is read afresh when the file changes", () => {
    const file = at("src/shifting.ts");
    writeFileSync(file, `export function first(): number {\n  return 1;\n}\n`);
    expect(enclosingDeclaration(file, 2)?.name).toBe("first");
    writeFileSync(file, `export function second(): number {\n  return 1;\n}\n`);
    const later = new Date(Date.now() + 5_000);
    utimesSync(file, later, later);
    expect(enclosingDeclaration(file, 2)?.name).toBe("second");
  });
});
