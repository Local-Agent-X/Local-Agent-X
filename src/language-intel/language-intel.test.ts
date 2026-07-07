import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getLanguageIntel, disposeLanguageIntel } from "./index.js";

// Fixture: a tiny two-file NodeNext ESM project. `greetUser` appears as a
// declaration (a.ts L2), inside a comment (a.ts L1), inside a string literal
// (a.ts L3), and as an import + call site in b.ts — exactly the shape where a
// regex scan false-positives and an AST scan must not.
const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
  },
});

const A_TS = [
  "// this comment mentions greetUser and must not count",
  "export function greetUser(name: string): string {",
  '  return "greetUser inside a string: " + name;',
  "}",
  "",
].join("\n");

const B_TS = [
  'import { greetUser } from "./a.js";',
  "",
  'export const greeting = greetUser("world");',
  "",
].join("\n");

let dir: string;

/** 1-based location of `needle` on `line` of `file` (asserts it exists). */
function posOf(file: string, line: number, needle: string) {
  const column = readFileSync(file, "utf8").split("\n")[line - 1].indexOf(needle) + 1;
  expect(column).toBeGreaterThan(0);
  return { file, line, column };
}

beforeEach(() => {
  // realpathSync: os.tmpdir() is a symlink on macOS (/var → /private/var);
  // resolving it up front keeps compiler-reported paths comparable to ours.
  dir = realpathSync(mkdtempSync(join(tmpdir(), "language-intel-")));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(dir, "tsconfig.json"), TSCONFIG);
  writeFileSync(join(dir, "a.ts"), A_TS);
  writeFileSync(join(dir, "b.ts"), B_TS);
});

afterEach(() => {
  disposeLanguageIntel(); // drops services + their unref()d idle timers
  rmSync(dir, { recursive: true, force: true });
});

describe("language-intel", () => {
  it("findSymbolPositions finds the declaration, never comment/string occurrences", async () => {
    const intel = getLanguageIntel();
    const positions = await intel.findSymbolPositions(dir, "greetUser");
    const aFile = join(dir, "a.ts");

    // Declaration first: "export function " is 16 chars → column 17.
    expect(positions[0]).toEqual({ file: aFile, line: 2, column: 17 });

    // The comment (L1) and string-literal (L3) mentions are not AST
    // identifiers and must not appear.
    const aLines = positions.filter((p) => p.file === aFile).map((p) => p.line);
    expect(aLines).not.toContain(1);
    expect(aLines).not.toContain(3);

    // The b.ts import + call site show up as non-declaration occurrences.
    const bLines = positions.filter((p) => p.file === join(dir, "b.ts")).map((p) => p.line);
    expect(bLines).toContain(3);
  });

  it("findSymbolPositions honors opts.limit", async () => {
    const intel = getLanguageIntel();
    const positions = await intel.findSymbolPositions(dir, "greetUser", { limit: 1 });
    expect(positions).toHaveLength(1);
  });

  it("findReferences from the declaration returns 1-based hits in both files", async () => {
    const intel = getLanguageIntel();
    const hits = await intel.findReferences(posOf(join(dir, "a.ts"), 2, "greetUser"));

    const defHit = hits.find((h) => h.file === join(dir, "a.ts") && h.line === 2);
    expect(defHit).toBeDefined();
    expect(defHit?.isDefinition).toBe(true);
    expect(defHit?.lineText).toBe("export function greetUser(name: string): string {");

    const bLines = hits.filter((h) => h.file === join(dir, "b.ts")).map((h) => h.line).sort();
    expect(bLines).toEqual([1, 3]); // import binding + call site
    const callHit = hits.find((h) => h.file === join(dir, "b.ts") && h.line === 3);
    expect(callHit?.lineText).toContain('greetUser("world")');
  });

  it("getDiagnostics: clean fixture is empty; an on-disk edit is picked up (mtime staleness)", async () => {
    const intel = getLanguageIntel();
    const files = [join(dir, "a.ts"), join(dir, "b.ts")];
    expect(await intel.getDiagnostics(files)).toEqual([]);

    // Rewrite b.ts AFTER the service answered once — the wrong-typed argument
    // must surface, proving mtime invalidation re-reads changed files.
    const bPath = join(dir, "b.ts");
    writeFileSync(bPath, B_TS.replace('greetUser("world")', "greetUser(42)"));
    const bumped = new Date(Date.now() + 5_000);
    utimesSync(bPath, bumped, bumped); // guarantee an mtime delta on coarse filesystems

    const diags = await intel.getDiagnostics(files);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ file: bPath, line: 3, severity: "error", code: 2345 });
    expect(diags[0].message).toContain("not assignable");
  });

  it("findDefinition from the b.ts call site lands on a.ts", async () => {
    const intel = getLanguageIntel();
    const defs = await intel.findDefinition(posOf(join(dir, "b.ts"), 3, "greetUser"));
    expect(defs.length).toBeGreaterThan(0);
    expect(defs[0]).toMatchObject({ file: join(dir, "a.ts"), line: 2, column: 17, isDefinition: true });
  });

  it("unsupported extensions answer empty from the facade", async () => {
    const intel = getLanguageIntel();
    const py = join(dir, "script.py");
    writeFileSync(py, "def greet():\n    pass\n");
    expect(intel.supports(py)).toBe(false);
    expect(await intel.findReferences({ file: py, line: 1, column: 5 })).toEqual([]);
    expect(await intel.findDefinition({ file: py, line: 1, column: 5 })).toEqual([]);
    expect(await intel.getDiagnostics([py])).toEqual([]);
  });

  it("out-of-range positions answer empty, not a throw", async () => {
    const intel = getLanguageIntel();
    const hits = await intel.findReferences({ file: join(dir, "a.ts"), line: 999, column: 999 });
    expect(hits).toEqual([]); // clamped to EOF, where no symbol lives
  });
});
