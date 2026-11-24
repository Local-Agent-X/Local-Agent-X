import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { disposeLanguageIntel } from "../language-intel/index.js";
import { structuralSearchTool, runWordFallback, type ExecFileLike } from "./structural-search-tool.js";
import { ripgrepBin } from "./grep-tool.js";

// Fixture mirrors language-intel's: `greetUser` declared in a.ts, used in
// b.ts, and ALSO present in a comment and a string literal — the exact shape
// where grep false-positives and the AST-backed path must not.
const TSCONFIG = JSON.stringify({
  compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true },
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
  'export const g1 = greetUser("one");',
  'export const g2 = greetUser("two");',
  'export const g3 = greetUser("three");',
  "",
].join("\n");

const rgAvailable = spawnSync(ripgrepBin(), ["--version"]).status === 0;

let dir: string;

function tsFixture(): void {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(dir, "tsconfig.json"), TSCONFIG);
  writeFileSync(join(dir, "a.ts"), A_TS);
  writeFileSync(join(dir, "b.ts"), B_TS);
}

beforeEach(() => {
  // realpathSync: os.tmpdir() is a symlink on macOS (/var → /private/var).
  dir = realpathSync(mkdtempSync(join(tmpdir(), "structural-search-")));
});

afterEach(() => {
  disposeLanguageIntel();
  rmSync(dir, { recursive: true, force: true });
});

describe("structural_search — language-intel path (TS/JS)", () => {
  it("references mode returns hits in both files, excluding comment/string occurrences", async () => {
    tsFixture();
    const res = await structuralSearchTool.execute({ symbol: "greetUser", path: dir });
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain("references");
    expect(res.content).toContain("greetUser");

    const hitLines = res.content.split("\n").filter((l) => /:\d+:/.test(l));
    // Declaration in a.ts + import/call sites in b.ts, formatted file:line.
    expect(hitLines.some((l) => /(^|\s)\[def\] a\.ts:2:/.test(l))).toBe(true);
    expect(hitLines.some((l) => l.startsWith("b.ts:1:"))).toBe(true);
    expect(hitLines.some((l) => l.startsWith("b.ts:3:"))).toBe(true);
    // The comment (a.ts:1) and string-literal (a.ts:3) mentions must NOT appear.
    expect(hitLines.some((l) => l.includes("a.ts:1:"))).toBe(false);
    expect(hitLines.some((l) => l.includes("a.ts:3:"))).toBe(false);
  });

  it("definition mode returns the declaration site prefixed [def]", async () => {
    tsFixture();
    const res = await structuralSearchTool.execute({ symbol: "greetUser", path: dir, mode: "definition" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain("definition");
    expect(res.content).toContain("[def] a.ts:2:");
  });

  it("respects limit with grep's '(N more lines)' tail", async () => {
    tsFixture();
    const res = await structuralSearchTool.execute({ symbol: "greetUser", path: dir, limit: 2 });
    expect(res.isError).toBeUndefined();
    const hitLines = res.content.split("\n").filter((l) => /:\d+:/.test(l));
    expect(hitLines.length).toBe(2);
    expect(res.content).toMatch(/\.\.\. \(\d+ more lines\)/);
  });

  it("unknown symbol yields a clear empty-result message naming symbol and root", async () => {
    tsFixture();
    const res = await structuralSearchTool.execute({ symbol: "noSuchSymbolAnywhere", path: dir });
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain("noSuchSymbolAnywhere");
    expect(res.content).toContain(dir);
    expect(res.content).toMatch(/No matches|No references/);
  });
});

// What a change touches. `greetUser` is used by three constants in b.ts; one
// of them is used by a function in c.ts, which a test file uses. A method is
// named by its line, since two types may each have one of the same name.
const C_TS = [
  'import { g1 as first } from "./b.js";',
  "",
  "export function shout(): string {",
  "  return first.toUpperCase();",
  "}",
  "",
  "export class Greeter {",
  "  hello(): string { return shout(); }",
  "}",
  "",
].join("\n");
const C_TEST_TS = ['import { shout, Greeter } from "./c.js";', "shout();", "new Greeter().hello();", ""].join("\n");

function reachFixture(): void {
  tsFixture();
  writeFileSync(join(dir, "c.ts"), C_TS);
  writeFileSync(join(dir, "c.test.ts"), C_TEST_TS);
}

describe("structural_search — reach mode", () => {
  it("lists the declarations that use the symbol and the tests to run", async () => {
    reachFixture();
    const res = await structuralSearchTool.execute({ symbol: "greetUser", path: dir, mode: "reach" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain('reach of "greetUser" (a.ts:2)');
    expect(res.content).toContain("depth 1");
    expect(res.content).toContain("hop 1: 3 declaration(s) in 1 file(s)");
    expect(res.content).toMatch(/b\.ts {2}g1:3, g2:4, g3:5/);
    expect(res.content).not.toContain("hop 2");
    expect(res.content).toContain("tests to run (0)");
  });

  it("follows the users' users at a greater depth, through a renamed import, to the test file", async () => {
    reachFixture();
    const res = await structuralSearchTool.execute({ symbol: "greetUser", path: dir, mode: "reach", depth: 3 });
    expect(res.content).toContain("hop 2: 1 declaration(s) in 1 file(s)");
    expect(res.content).toMatch(/c\.ts {2}shout:3/);
    expect(res.content).toMatch(/hop 3: 1 declaration\(s\)[\s\S]*c\.ts {2}Greeter:7/);
    expect(res.content).toMatch(/tests to run \(1\)[^\n]*\n {2}c\.test\.ts/);
  });

  it("holds depth to its ceiling", async () => {
    reachFixture();
    const res = await structuralSearchTool.execute({ symbol: "greetUser", path: dir, mode: "reach", depth: 99 });
    expect(res.content).toContain("depth 3");
  });

  it("says reach needs the language service when the symbol is not TS/JS", async () => {
    writeFileSync(join(dir, "main.py"), "def greet_user():\n    pass\n");
    const res = await structuralSearchTool.execute({ symbol: "greet_user", path: dir, mode: "reach" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("Reach needs the language service");
  });

  it("refuses an unknown mode, naming the three it has", async () => {
    const res = await structuralSearchTool.execute({ symbol: "x", path: dir, mode: "callers" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('"references", "definition" or "reach"');
  });
});

describe("structural_search — naming the symbol by file", () => {
  it("<file>:<line> finds the uses of a method", async () => {
    reachFixture();
    const res = await structuralSearchTool.execute({ symbol: "c.ts:8", path: dir });
    expect(res.isError).toBeUndefined();
    const hitLines = res.content.split("\n").filter((l) => /:\d+:/.test(l));
    expect(hitLines.some((l) => l.startsWith("[def] c.ts:8:"))).toBe(true);
    expect(hitLines.some((l) => l.startsWith("c.test.ts:3:"))).toBe(true);
  });

  it("<file>#<Name> anchors on that file's declaration, with no ambiguity note", async () => {
    reachFixture();
    writeFileSync(join(dir, "d.ts"), "export function shout(): number { return 1; }\n");
    const bare = await structuralSearchTool.execute({ symbol: "shout", path: dir });
    expect(bare.content).toContain("same-named declarations found");
    expect(bare.content).toContain("<file>#shout");
    const named = await structuralSearchTool.execute({ symbol: "d.ts#shout", path: dir });
    expect(named.content).not.toContain("same-named");
    expect(named.content).toContain("[def] d.ts:1:");
    expect(named.content).not.toContain("c.ts:");
  });

  it("refuses a file outside the search root, and says so for one that is not there", async () => {
    reachFixture();
    for (const symbol of ["../elsewhere.ts:1", `${join(dir, "..", "elsewhere.ts")}#x`, "../../etc/passwd:1"]) {
      const res = await structuralSearchTool.execute({ symbol, path: dir });
      expect(res.isError, symbol).toBe(true);
      expect(res.content, symbol).toContain("outside the search root");
    }
    const missing = await structuralSearchTool.execute({ symbol: "nope.ts#shout", path: dir });
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain("Nothing found");
  });
});

describe("structural_search — same-name ambiguity disclosure", () => {
  it("anchors on the module-level declaration (not an earlier-file parameter) and lists the others", async () => {
    tsFixture();
    // 'aa.ts' sorts BEFORE 'zz.ts' in the alphabetical walk; its parameter
    // `formatThing` must not win the anchor over zz.ts's exported function.
    writeFileSync(join(dir, "aa.ts"), [
      "export function wrap(formatThing: string): string {",
      "  return formatThing;",
      "}",
      "",
    ].join("\n"));
    writeFileSync(join(dir, "zz.ts"), [
      "export function formatThing(x: string): string {",
      "  return x;",
      "}",
      'export const used = formatThing("y");',
      "",
    ].join("\n"));
    const res = await structuralSearchTool.execute({ symbol: "formatThing", path: dir });
    expect(res.isError).toBeUndefined();
    // Anchored on the exported declaration → its references, [def] in zz.ts.
    expect(res.content).toContain("[def] zz.ts:1:");
    // The ambiguity is disclosed, naming the anchor and the other site.
    expect(res.content).toContain("note: 2 same-named declarations found");
    expect(res.content).toContain("anchored on zz.ts:1");
    expect(res.content).toContain("aa.ts:1");
  });

  it("a single declaration produces no ambiguity note", async () => {
    tsFixture();
    const res = await structuralSearchTool.execute({ symbol: "greetUser", path: dir });
    expect(res.content).not.toContain("same-named declarations");
  });
});

// ── runWordFallback error discrimination (stubbed exec seam) ──
type ExecErr = Error & { code?: number | string };

function stubExec(error: ExecErr | null, stdout: string, stderr = ""): ExecFileLike {
  return (_file, _args, _opts, cb) => {
    queueMicrotask(() => cb(error, stdout, stderr));
    return { stdin: null };
  };
}

describe("runWordFallback — rg exit/error discrimination", () => {
  const withCode = (msg: string, code: number | string): ExecErr =>
    Object.assign(new Error(msg), { code });

  it("no error with output → normal hit list", async () => {
    const r = await runWordFallback("sym", "/root", 50, undefined, stubExec(null, "/root/x.py:1:sym here"));
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("x.py:1:");
  });

  it("exit 1 (rg's documented no-match) → clean no-matches result, not an error", async () => {
    const r = await runWordFallback("sym", "/root", 50, undefined, stubExec(withCode("exit 1", 1), ""));
    expect(r.isError).toBeUndefined();
    expect(r.content).toMatch(/No matches/);
  });

  it("exit 2 (real rg failure) → err() naming the exit code and a stderr snippet", async () => {
    const r = await runWordFallback(
      "sym", "/root", 50, undefined,
      stubExec(withCode("exit 2", 2), "", "rg: error parsing glob 'x['"),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("2");
    expect(r.content).toContain("error parsing glob");
  });

  it("maxBuffer overflow → returns the truncated results WITH an explicit truncation warning", async () => {
    const r = await runWordFallback(
      "sym", "/root", 50, undefined,
      stubExec(
        withCode("maxBuffer length exceeded", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"),
        "/root/x.py:1:sym one\n/root/y.py:2:sym two",
      ),
    );
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("x.py:1:");
    expect(r.content).toContain("y.py:2:");
    expect(r.content).toMatch(/TRUNCATED/);
  });

  it("ENOENT (rg missing) → rejects so the caller can say 'install ripgrep'", async () => {
    await expect(
      runWordFallback("sym", "/root", 50, undefined, stubExec(withCode("spawn rg ENOENT", "ENOENT"), "")),
    ).rejects.toThrow(/ENOENT/);
  });
});

describe("structural_search — text fallback (unsupported languages)", () => {
  it.skipIf(!rgAvailable)("labels results from a Python-only tree as text fallback (word-boundary)", async () => {
    writeFileSync(join(dir, "main.py"), [
      "def greet_user(name):",
      '    return "hi " + name',
      "",
      'print(greet_user("world"))',
      "",
    ].join("\n"));
    const res = await structuralSearchTool.execute({ symbol: "greet_user", path: dir });
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain("text fallback (word-boundary)");
    expect(res.content).toContain("main.py:1:");
    expect(res.content).toContain("main.py:4:");
    // Word-boundary: a superstring must not match.
    const res2 = await structuralSearchTool.execute({ symbol: "greet_use", path: dir });
    expect(res2.content).toMatch(/No matches/);
  });
});

describe("structural_search — input validation", () => {
  it("errors on a missing symbol and a bad root", async () => {
    const noSymbol = await structuralSearchTool.execute({ path: dir });
    expect(noSymbol.isError).toBe(true);
    const badRoot = await structuralSearchTool.execute({ symbol: "x", path: join(dir, "does-not-exist") });
    expect(badRoot.isError).toBe(true);
    expect(badRoot.content).toContain("does-not-exist");
  });
});

// Same class as grep-tool's dash-leading pattern bug: a symbol beginning with
// a dash was pushed positionally with no `--`, so rg consumed it as a flag.
describe("runWordFallback — dash-leading symbols are never parsed as flags", () => {
  it("places `--` before the symbol and root", async () => {
    let seen: readonly string[] = [];
    const exec: ExecFileLike = (_file, args, _options, callback) => {
      seen = args;
      queueMicrotask(() => callback(null, "/root/theme.css:1:--pre", ""));
      return { stdin: { end() {} } };
    };
    await runWordFallback("--pre", "/root", 50, undefined, exec);
    const sep = seen.indexOf("--");
    expect(sep).toBeGreaterThanOrEqual(0);
    expect(seen.slice(sep + 1)).toEqual(["--pre", "/root"]);
  });
});
