import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { readTool } from "./read-write-tools.js";
import { setSessionWorkRoot, clearSessionWorkRoot } from "../workspace/paths.js";
import { getRuntimeConfig, setRuntimeConfig } from "../config.js";
import {
  buildImportAppendix,
  extractImportSpecifiers,
  resolveRelativeImport,
  isNonCodeSpecifier,
  importConfinementRoot,
  MAX_IMPORT_FILES,
  IMPORT_FILE_LINE_CAP,
  IMPORT_TOTAL_LINE_CAP,
} from "./read-imports.js";

// End-to-end through the REAL read tool + the appendix builder: no mocks,
// absolute temp paths (same rig as edit-tools.integration.test.ts). Imports
// only expand inside the confinement root containing the main file, so each
// test registers its temp dir as the session's work root — exactly the
// production plumbing (setSessionWorkRoot) the confinement derives from.

// Windows can refuse symlink creation without Developer Mode — probe once and
// skip the symlink-escape test (only) when the environment can't create one.
const canSymlink = (() => {
  try {
    const d = mkdtempSync(join(tmpdir(), "lax-symprobe-"));
    writeFileSync(join(d, "t.txt"), "x");
    symlinkSync(join(d, "t.txt"), join(d, "l.txt"), "file");
    rmSync(d, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
})();

let seq = 0;
let dir: string;      // the confinement root (registered work root)
let outside: string;  // a sibling dir OUTSIDE the confinement root
let sid: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-readimp-"));
  outside = mkdtempSync(join(tmpdir(), "lax-readimp-out-"));
  sid = `readimp-test-${seq++}`;
  setSessionWorkRoot(sid, dir);
});
afterEach(() => {
  clearSessionWorkRoot(sid);
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const HELPER_TS = `export function helper(): number {\n  return 42;\n}\n`;

function writeMain(extraImports = ""): string {
  const main = join(dir, "main.ts");
  writeFileSync(main, [
    `import { readFileSync } from "node:fs";`,
    `import { helper } from "./helper.js";`,
    `import { gone } from "./missing.js";`,
    extraImports,
    `export const x = helper();`,
    "",
  ].join("\n"));
  writeFileSync(join(dir, "helper.ts"), HELPER_TS);
  return main;
}

async function readWithImports(path: string) {
  return readTool.execute({ path, include_imports: true, _sessionId: sid });
}

describe("extractImportSpecifiers", () => {
  it("finds static, export-from, side-effect, dynamic, and require specifiers", () => {
    const src = [
      `import a from "./a.js";`,
      `import { b, c } from '../b.js';`,
      `import type { T } from "./types.js";`,
      `export { d } from "./d.js";`,
      `export * from "./e.js";`,
      `import "./side-effect.js";`,
      `const f = await import("./f.js");`,
      `const g = require("./g.cjs");`,
      `import ext from "react";`,
    ].join("\n");
    expect(extractImportSpecifiers(src)).toEqual([
      "./a.js", "../b.js", "./types.js", "./d.js", "./e.js",
      "./side-effect.js", "./f.js", "./g.cjs", "react",
    ]);
  });

  it("does NOT let a side-effect import swallow a later statement's from-clause", () => {
    const src = `import "./setup.js";\nexport const n = 1;\nimport { z } from "./z.js";`;
    expect(extractImportSpecifiers(src)).toEqual(["./setup.js", "./z.js"]);
  });

  it("dedups repeated specifiers", () => {
    const src = `import a from "./a.js";\nimport { b } from "./a.js";`;
    expect(extractImportSpecifiers(src)).toEqual(["./a.js"]);
  });
});

describe("resolveRelativeImport — code files only", () => {
  it("remaps the ESM-TS './x.js' specifier to the on-disk .ts file", () => {
    writeFileSync(join(dir, "helper.ts"), HELPER_TS);
    expect(resolveRelativeImport(dir, "./helper.js")).toBe(join(dir, "helper.ts"));
  });

  it("resolves extensionless specifiers and directory /index.*", () => {
    writeFileSync(join(dir, "util.ts"), "export const u = 1;\n");
    expect(resolveRelativeImport(dir, "./util")).toBe(join(dir, "util.ts"));
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "index.ts"), "export const s = 1;\n");
    expect(resolveRelativeImport(dir, "./sub")).toBe(join(dir, "sub", "index.ts"));
  });

  it("NEVER resolves a non-code extension, even when the file exists", () => {
    writeFileSync(join(dir, "creds.json"), `{"secret":"x"}`);
    writeFileSync(join(dir, "notes.txt"), "notes");
    expect(resolveRelativeImport(dir, "./creds.json")).toBeNull();
    expect(resolveRelativeImport(dir, "./notes.txt")).toBeNull();
    expect(isNonCodeSpecifier("./creds.json")).toBe(true);
    expect(isNonCodeSpecifier("./notes.txt")).toBe(true);
    expect(isNonCodeSpecifier("./helper.js")).toBe(false);
  });

  it("NEVER resolves a bare extensionless on-disk file (no bare-base candidate)", () => {
    writeFileSync(join(dir, "LICENSE"), "MIT");
    expect(resolveRelativeImport(dir, "./LICENSE")).toBeNull();
  });

  it("returns null for a specifier that resolves to nothing", () => {
    expect(resolveRelativeImport(dir, "./nope.js")).toBeNull();
  });
});

describe("confinement invariant — runtime-discovered imports", () => {
  it("skeptic repro: a relative specifier escaping the confinement root is skipped, content NOT rendered", async () => {
    const probe = join(outside, "probe-outside-secret.ts");
    writeFileSync(probe, `export const SECRET = "TRAVERSAL-LEAK-CANARY";\n`);
    const spec = relative(dir, probe).replace(/\\/g, "/"); // ../lax-readimp-out-*/probe-outside-secret.ts
    expect(spec.startsWith("../")).toBe(true);
    const main = join(dir, "main.ts");
    writeFileSync(main, `import { SECRET } from "${spec}";\nexport const y = SECRET;\n`);
    const r = await readWithImports(main);
    const text = String(r.content);
    expect(text).not.toContain("TRAVERSAL-LEAK-CANARY");
    expect(text).toContain("outside workspace confinement");
    expect((r.metadata as Record<string, unknown>).imports_included).toBe(0);
  });

  it.runIf(canSymlink)("a symlink inside the root pointing outside it is skipped, content NOT rendered", async () => {
    const secret = join(outside, "secret.ts");
    writeFileSync(secret, `export const SECRET = "SYMLINK-LEAK-CANARY";\n`);
    symlinkSync(secret, join(dir, "linked.ts"), "file");
    const main = join(dir, "main.ts");
    writeFileSync(main, `import { SECRET } from "./linked.js";\n`);
    const r = await readWithImports(main);
    const text = String(r.content);
    expect(text).not.toContain("SYMLINK-LEAK-CANARY");
    expect(text).toContain("outside workspace confinement");
    expect((r.metadata as Record<string, unknown>).imports_included).toBe(0);
  });

  it("a directory junction inside the root pointing outside it is skipped, content NOT rendered", async () => {
    // Junctions need no privilege on Windows (unlike file symlinks), so this
    // leg of the symlink-escape invariant always runs. On POSIX the "junction"
    // type falls back to a plain directory symlink — same escape shape.
    writeFileSync(join(outside, "secret.ts"), `export const SECRET = "JUNCTION-LEAK-CANARY";\n`);
    symlinkSync(outside, join(dir, "junc"), "junction");
    const main = join(dir, "main.ts");
    writeFileSync(main, `import { SECRET } from "./junc/secret.js";\n`);
    const r = await readWithImports(main);
    const text = String(r.content);
    expect(text).not.toContain("JUNCTION-LEAK-CANARY");
    expect(text).toContain("outside workspace confinement");
    expect((r.metadata as Record<string, unknown>).imports_included).toBe(0);
  });

  it("non-code amplifier: creds.json / notes.txt are reported but never read", async () => {
    writeFileSync(join(dir, "creds.json"), `{"aws_secret":"JSON-LEAK-CANARY"}`);
    writeFileSync(join(dir, "notes.txt"), "TXT-LEAK-CANARY");
    const main = join(dir, "main.ts");
    writeFileSync(main, `import creds from "./creds.json";\nconst notes = require("./notes.txt");\n`);
    const r = await readWithImports(main);
    const text = String(r.content);
    expect(text).not.toContain("JSON-LEAK-CANARY");
    expect(text).not.toContain("TXT-LEAK-CANARY");
    expect(text).toMatch(/\.\/creds\.json: non-code import \(not read\)/);
    expect(text).toMatch(/\.\/notes\.txt: non-code import \(not read\)/);
    expect((r.metadata as Record<string, unknown>).imports_included).toBe(0);
  });

  it("absolute and alias specifiers stay external — listed, never read", async () => {
    const absTarget = join(outside, "abs.ts");
    writeFileSync(absTarget, `export const SECRET = "ABS-LEAK-CANARY";\n`);
    const absSpec = absTarget.replace(/\\/g, "/");
    const main = join(dir, "main.ts");
    writeFileSync(main, `import a from "${absSpec}";\nimport b from "@app/aliased";\nimport c from "#internal/thing";\n`);
    const r = await readWithImports(main);
    const text = String(r.content);
    expect(text).not.toContain("ABS-LEAK-CANARY");
    expect(text).toContain(`External imports (not read): ${absSpec}, @app/aliased, #internal/thing`);
    expect((r.metadata as Record<string, unknown>).imports_external).toBe(3);
    expect((r.metadata as Record<string, unknown>).imports_included).toBe(0);
  });

  it("fallback branch (NO session work root): a file under the configured workspace resolves its siblings", async () => {
    // Production chat sessions have no registered work root — the confinement
    // root must come from the canonicalized workspaceRoot() candidate. Inject
    // a temp workspace through the exported runtime-config seam, restore after.
    const prev = getRuntimeConfig();
    const ws = mkdtempSync(join(tmpdir(), "lax-readimp-ws-"));
    setRuntimeConfig({ ...prev, workspace: ws });
    try {
      mkdirSync(join(ws, "sub"));
      const main = join(ws, "sub", "main.ts");
      writeFileSync(main, `import { helper } from "./helper.js";\nexport const x = helper();\n`);
      writeFileSync(join(ws, "sub", "helper.ts"), HELPER_TS);
      expect(importConfinementRoot(main, undefined)).not.toBeNull();
      const r = await readTool.execute({ path: main, include_imports: true }); // no _sessionId
      const text = String(r.content);
      expect((r.metadata as Record<string, unknown>).imports_included).toBe(1);
      expect(text).toContain("export function helper");
    } finally {
      setRuntimeConfig(prev);
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("junction layout: workspace root that IS a junction still expands imports, and escapes stay blocked", async () => {
    // The shipped relocated layout: <repo>\workspace is a junction to the real
    // workspace elsewhere. confineToDir realpaths targets OUT of the junction,
    // so the root candidate must be canonicalized the same way — the exact
    // defect: lexical projectRoot()/workspaceRoot() never contained any
    // realpathed workspace file. Junctions need no privilege, so this runs
    // everywhere on Windows.
    const prev = getRuntimeConfig();
    const realWs = mkdtempSync(join(tmpdir(), "lax-readimp-realws-"));
    const lexParent = mkdtempSync(join(tmpdir(), "lax-readimp-lex-"));
    const junction = join(lexParent, "workspace");
    symlinkSync(realWs, junction, "junction");
    setRuntimeConfig({ ...prev, workspace: junction }); // configured root is the JUNCTION path
    try {
      // Files written THROUGH the junction (lexical spelling), like real traffic.
      const main = join(junction, "main.ts");
      writeFileSync(main, `import { helper } from "./helper.js";\nimport { esc } from "../escape.js";\n`);
      writeFileSync(join(junction, "helper.ts"), HELPER_TS);
      // Escape target OUTSIDE the workspace (junction's lexical parent).
      writeFileSync(join(lexParent, "escape.ts"), `export const esc = "JUNCTION-ROOT-LEAK-CANARY";\n`);
      const root = importConfinementRoot(main, undefined);
      expect(root).not.toBeNull(); // canonicalized workspace-root candidate contains the realpathed main
      const r = await readTool.execute({ path: main, include_imports: true }); // no _sessionId
      const text = String(r.content);
      expect((r.metadata as Record<string, unknown>).imports_included).toBe(1);
      expect(text).toContain("export function helper");
      // The sibling resolves; the escape from under the junction does not.
      expect(text).not.toContain("JUNCTION-ROOT-LEAK-CANARY");
      expect(text).toContain("outside workspace confinement");
    } finally {
      setRuntimeConfig(prev);
      rmSync(lexParent, { recursive: true, force: true });
      rmSync(realWs, { recursive: true, force: true });
    }
  });

  it("a main file outside every known root gets NO imports expanded (fail closed)", async () => {
    // No _sessionId → no work root; a tmpdir main is outside projectRoot().
    const main = join(outside, "main.ts");
    writeFileSync(main, `import { helper } from "./helper.js";\n`);
    writeFileSync(join(outside, "helper.ts"), `export const SECRET = "NOROOT-LEAK-CANARY";\n`);
    expect(importConfinementRoot(main, undefined)).toBeNull();
    const r = await readTool.execute({ path: main, include_imports: true });
    const text = String(r.content);
    expect(text).not.toContain("NOROOT-LEAK-CANARY");
    expect(text).toContain("outside workspace confinement");
    expect((r.metadata as Record<string, unknown>).imports_included).toBe(0);
  });
});

describe("read tool with include_imports:true", () => {
  it("appends resolved imports, lists externals compactly, and notes missing ones", async () => {
    const main = writeMain();
    const r = await readWithImports(main);
    expect(r.isError).toBeFalsy();
    const text = String(r.content);
    // Main body first, then the delimited appendix.
    expect(text.indexOf("export const x")).toBeGreaterThan(-1);
    expect(text).toContain("=== imports (depth 1) ===");
    // Helper section: path header + the read tool's line-numbering style.
    expect(text).toContain(`--- import: ${join(dir, "helper.ts")} ---`);
    expect(text).toContain("1\texport function helper(): number {");
    // External listed, not read.
    expect(text).toContain("External imports (not read): node:fs");
    // Missing relative import surfaced, not silently dropped.
    expect(text).toContain("./missing.js: not found");
    const meta = r.metadata as Record<string, unknown>;
    expect(meta.imports_included).toBe(1);
    expect(meta.imports_external).toBe(1);
    expect(meta.imports_skipped).toBe(1);
  });

  it("never re-includes the main file and dedups repeated targets", async () => {
    const main = writeMain(`import "./main.js";\nimport again from "./helper.js";`);
    const r = await readWithImports(main);
    const text = String(r.content);
    expect(text.match(/--- import: /g)?.length).toBe(1); // helper once, main never
    expect((r.metadata as Record<string, unknown>).imports_included).toBe(1);
  });

  it("skips sensitive-path and binary imports WITH a reason", async () => {
    const main = join(dir, "main.ts");
    writeFileSync(main, `import a from "./id_rsa_helper.js";\nimport b from "./blob.js";\n`);
    writeFileSync(join(dir, "id_rsa_helper.ts"), "export const k = 1;\n");
    writeFileSync(join(dir, "blob.js"), Buffer.from([0x00, 0x01, 0x02, 0x65]));
    const r = await readWithImports(main);
    const text = String(r.content);
    expect(text).not.toContain("export const k"); // sensitive content never rendered
    expect(text).toMatch(/id_rsa_helper\.ts: sensitive path/);
    expect(text).toMatch(/blob\.js: binary/);
    expect((r.metadata as Record<string, unknown>).imports_included).toBe(0);
    expect((r.metadata as Record<string, unknown>).imports_skipped).toBe(2);
  });

  it("returns a normal read with imports_supported:false for a non-JS file", async () => {
    const md = join(dir, "notes.md");
    writeFileSync(md, "# notes\nimport nothing from './x.js'\n");
    const r = await readTool.execute({ path: md, include_imports: true, _sessionId: sid });
    expect(r.isError).toBeFalsy();
    expect(String(r.content)).not.toContain("=== imports");
    expect((r.metadata as Record<string, unknown>).imports_supported).toBe(false);
  });

  it("enforces the file-count cap and reports truncation", async () => {
    const imports: string[] = [];
    for (let i = 0; i < MAX_IMPORT_FILES + 2; i++) {
      writeFileSync(join(dir, `m${i}.ts`), `export const m${i} = ${i};\n`);
      imports.push(`import { m${i} } from "./m${i}.js";`);
    }
    const main = join(dir, "main.ts");
    writeFileSync(main, imports.join("\n") + "\n");
    const r = await readWithImports(main);
    const meta = r.metadata as Record<string, unknown>;
    expect(meta.imports_included).toBe(MAX_IMPORT_FILES);
    expect(meta.imports_skipped).toBe(2);
    expect(meta.imports_truncated).toBe(true);
    expect(String(r.content)).toMatch(new RegExp(`over the ${MAX_IMPORT_FILES}-file cap`));
  });
});

describe("buildImportAppendix line caps", () => {
  it("clips a single oversized import at the per-file cap and marks truncation", () => {
    const big = join(dir, "big.ts");
    writeFileSync(big, Array.from({ length: IMPORT_FILE_LINE_CAP + 50 }, (_, i) => `export const v${i} = ${i};`).join("\n"));
    const main = join(dir, "main.ts");
    const content = `import { v0 } from "./big.js";\n`;
    writeFileSync(main, content);
    const appendix = buildImportAppendix(main, content, { sessionId: sid });
    expect(appendix.metadata.imports_truncated).toBe(true);
    expect(appendix.text).toContain(`[lines 1-${IMPORT_FILE_LINE_CAP} of ${IMPORT_FILE_LINE_CAP + 50}]`);
    expect(appendix.text).not.toContain(`${IMPORT_FILE_LINE_CAP + 1}\t`);
  });

  it("stops at the total line budget and lists the starved import as skipped", () => {
    const filesNeeded = Math.ceil(IMPORT_TOTAL_LINE_CAP / IMPORT_FILE_LINE_CAP) + 1;
    const specs: string[] = [];
    for (let i = 0; i < filesNeeded; i++) {
      writeFileSync(join(dir, `chunk${i}.ts`), Array.from({ length: IMPORT_FILE_LINE_CAP }, (_, j) => `export const c${i}x${j} = 0;`).join("\n"));
      specs.push(`import "./chunk${i}.js";`);
    }
    const main = join(dir, "main.ts");
    const content = specs.join("\n") + "\n";
    writeFileSync(main, content);
    const appendix = buildImportAppendix(main, content, { sessionId: sid });
    expect(appendix.metadata.imports_truncated).toBe(true);
    expect(appendix.text).toContain("line budget exhausted");
    // Total appended numbered lines never exceed the budget.
    const numbered = appendix.text.split("\n").filter((l) => /^\d+\t/.test(l));
    expect(numbered.length).toBeLessThanOrEqual(IMPORT_TOTAL_LINE_CAP);
  });
});

describe("regression guard — default path unchanged", () => {
  it("include_imports omitted or false is byte-identical to a plain read", async () => {
    const main = writeMain();
    const plain = await readTool.execute({ path: main });
    const omitted = await readTool.execute({ path: main });
    const explicitFalse = await readTool.execute({ path: main, include_imports: false });
    expect(omitted.content).toBe(plain.content);
    expect(explicitFalse.content).toBe(plain.content);
    expect(String(plain.content)).not.toContain("=== imports");
    expect(omitted.metadata).toEqual(plain.metadata);
    expect(explicitFalse.metadata).toEqual(plain.metadata);
    const metaKeys = Object.keys(plain.metadata ?? {});
    expect(metaKeys.some((k) => k.startsWith("imports_"))).toBe(false);
  });
});
