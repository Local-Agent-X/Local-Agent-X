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

  it("respects limit with a '(N more)' tail", async () => {
    tsFixture();
    const res = await structuralSearchTool.execute({ symbol: "greetUser", path: dir, limit: 2 });
    expect(res.isError).toBeUndefined();
    const hitLines = res.content.split("\n").filter((l) => /:\d+:/.test(l));
    expect(hitLines.length).toBe(2);
    expect(res.content).toMatch(/\.\.\. \(\d+ more\)/);
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
